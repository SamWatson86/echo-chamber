//! Private, disk-backed file library. No user-supplied name is ever a disk path.
use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    fs,
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tower_http::services::ServeFile;

const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const COOKIE: &str = "echo_files";
const SESSION_SECONDS: u64 = 24 * 60 * 60;
type ApiError = (StatusCode, &'static str);
type ApiResult<T> = Result<T, ApiError>;

pub(crate) struct FileStore {
    dir: PathBuf,
    reader: Option<String>,
    owner: Option<String>,
    secret: String,
    // Serialize mutations, including publication/deletion, across requests.
    writes: tokio::sync::Mutex<()>,
    attempts: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl FileStore {
    pub(crate) fn from_env(default_dir: PathBuf) -> Arc<Self> {
        let value = |key| std::env::var(key).ok().filter(|s| !s.is_empty());
        let reader = value("CORE_FILES_PASSWORD");
        let owner = value("CORE_FILES_OWNER_PASSWORD");
        let enabled = matches!((&reader, &owner), (Some(r), Some(o)) if r.len() >= 16 && o.len() >= 16 && r != o);
        if !enabled {
            tracing::info!("Files disabled: configure distinct CORE_FILES_PASSWORD and CORE_FILES_OWNER_PASSWORD (16+ characters each)");
        }
        Arc::new(Self {
            dir: value("CORE_FILES_DIR")
                .map(PathBuf::from)
                .unwrap_or(default_dir),
            reader: reader.filter(|_| enabled),
            owner: owner.filter(|_| enabled),
            secret: crate::config::random_secret(),
            writes: tokio::sync::Mutex::new(()),
            attempts: Mutex::new(HashMap::new()),
        })
    }

    fn enabled(&self) -> ApiResult<()> {
        if self.reader.is_none() || self.owner.is_none() {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Files is not configured on this server.",
            ));
        }
        Ok(())
    }

    fn path(&self, id: &str, suffix: &str) -> ApiResult<PathBuf> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err((StatusCode::BAD_REQUEST, "Invalid file ID."));
        }
        Ok(self.dir.join(format!("{id}.{suffix}")))
    }

    async fn record(&self, id: &str) -> ApiResult<FileRecord> {
        let pending = self.path(id, "upload.json")?;
        let path = if fs::try_exists(&pending).await.map_err(storage_error)? {
            pending
        } else {
            self.path(id, "json")?
        };
        let bytes = fs::read(path).await.map_err(storage_error)?;
        serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid file metadata."))
    }

    async fn save(&self, record: &FileRecord) -> ApiResult<()> {
        let path = self.path(&record.id, "upload.json")?;
        let temporary = self.path(&record.id, "tmp")?;
        let bytes = serde_json::to_vec(record)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Cannot encode metadata."))?;
        let mut file = fs::File::create(&temporary).await.map_err(storage_error)?;
        file.write_all(&bytes).await.map_err(storage_error)?;
        file.sync_all().await.map_err(storage_error)?;
        drop(file);
        fs::rename(temporary, path).await.map_err(storage_error)
    }

    fn auth(&self, headers: &HeaderMap, owner: bool) -> ApiResult<Claims> {
        self.enabled()?;
        let token = headers
            .get("cookie")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| {
                s.split(';')
                    .find_map(|part| part.trim().strip_prefix(&format!("{COOKIE}=")))
            })
            .ok_or((StatusCode::UNAUTHORIZED, "Sign in to Files."))?;
        let claims = decode::<Claims>(
            token,
            &DecodingKey::from_secret(self.secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| {
            (
                StatusCode::UNAUTHORIZED,
                "Your Files session expired. Sign in again.",
            )
        })?
        .claims;
        if !matches!(claims.role.as_str(), "reader" | "owner") || (owner && claims.role != "owner")
        {
            return Err((StatusCode::FORBIDDEN, "Owner sign-in required."));
        }
        Ok(claims)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    role: String,
    exp: usize,
}
#[derive(Clone, Serialize, Deserialize)]
struct FileRecord {
    id: String,
    name: String,
    size: u64,
    offset: u64,
    fingerprint: String,
    created_at: u64,
    complete: bool,
}
#[derive(Deserialize)]
struct Login {
    password: String,
    role: String,
}
#[derive(Deserialize)]
struct NewUpload {
    name: String,
    size: u64,
    fingerprint: String,
}

pub(crate) fn router(store: Arc<FileStore>) -> Router {
    Router::new()
        .route("/session", get(session).post(login).delete(logout))
        .route("/catalog", get(list))
        .route("/uploads", post(create_upload).get(list_uploads))
        .route(
            "/uploads/:id",
            get(upload_status).patch(append_chunk).delete(remove_upload),
        )
        .route("/uploads/:id/complete", post(complete_upload))
        .route("/:id/download", get(download))
        .route("/:id", axum::routing::delete(remove_file))
        .layer(DefaultBodyLimit::max(CHUNK_BYTES))
        .layer(middleware::from_fn(private_response))
        .with_state(store)
}

// Mutations require a non-simple header AND a matching Origin when supplied.
// Parent Echo CORS rules must never grant other origins access to this cookie API.
async fn private_response(request: Request, next: Next) -> Response {
    let mutation = !matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    );
    let origin_bad = request
        .headers()
        .get("origin")
        .map(|origin| !origin_matches_request(&request, origin))
        .unwrap_or(false);
    if origin_bad
        || (mutation
            && request
                .headers()
                .get("x-echo-files")
                .and_then(|v| v.to_str().ok())
                != Some("1"))
    {
        return (StatusCode::FORBIDDEN, "Same-origin Files request required.").into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

// HTTP/2 carries :authority in the URI and may omit the HTTP/1 Host header.
// Use that native authority without trusting client-supplied forwarding headers.
fn origin_matches_request(request: &Request, origin: &HeaderValue) -> bool {
    let Some(origin) = origin
        .to_str()
        .ok()
        .and_then(|s| s.parse::<axum::http::Uri>().ok())
    else {
        return false;
    };
    if !matches!(origin.scheme_str(), Some("http" | "https")) {
        return false;
    }
    let authority = request.uri().authority().map(|value| value.as_str());
    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok());
    if let (Some(authority), Some(host)) = (authority, host) {
        if !authority.eq_ignore_ascii_case(host) {
            return false;
        }
    }
    if let Some(scheme) = request.uri().scheme_str() {
        if origin.scheme_str() != Some(scheme) {
            return false;
        }
    }
    match (origin.authority(), authority.or(host)) {
        (Some(origin), Some(target)) => origin.as_str().eq_ignore_ascii_case(target),
        _ => false,
    }
}

async fn login(
    State(store): State<Arc<FileStore>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(input): Json<Login>,
) -> ApiResult<Response> {
    store.enabled()?;
    if input.password.len() > 1024 {
        return Err((StatusCode::BAD_REQUEST, "Invalid password."));
    }
    {
        let mut attempts = store.attempts.lock().unwrap_or_else(|e| e.into_inner());
        attempts.retain(|_, (_, when)| when.elapsed() < Duration::from_secs(900));
        if attempts
            .get(&peer.ip())
            .map(|(count, _)| *count >= 5)
            .unwrap_or(false)
            || attempts.len() >= 4096
        {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Too many sign-in attempts. Try again in 15 minutes.",
            ));
        }
        // Reserve before verification so simultaneous requests cannot bypass the limit.
        attempts.entry(peer.ip()).or_insert((0, Instant::now())).0 += 1;
    }
    let expected = match input.role.as_str() {
        "owner" => store.owner.as_deref(),
        "reader" => store.reader.as_deref(),
        _ => None,
    };
    let valid = expected
        .map(|password| {
            // Fixed-size digest comparison avoids plaintext early-exit comparison.
            let left = Sha256::digest(password.as_bytes());
            let right = Sha256::digest(input.password.as_bytes());
            left.iter()
                .zip(right.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
        })
        .unwrap_or(false);
    if !valid {
        return Err((StatusCode::UNAUTHORIZED, "Incorrect Files password."));
    }
    store
        .attempts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&peer.ip());
    let claims = Claims {
        role: input.role,
        exp: (crate::config::now_ts() + SESSION_SECONDS) as usize,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(store.secret.as_bytes()),
    )
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Cannot create session."))?;
    let mut response = Json(serde_json::json!({"role": claims.role})).into_response();
    response.headers_mut().insert("set-cookie", HeaderValue::from_str(&format!("{COOKIE}={token}; Path=/api/files; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_SECONDS}" )).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Cannot create session."))?);
    Ok(response)
}
async fn session(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let claims = store.auth(&headers, false)?;
    Ok(Json(
        serde_json::json!({"role": claims.role, "chunk_bytes": CHUNK_BYTES}),
    ))
}
async fn logout() -> Response {
    (
        [(
            "set-cookie",
            "echo_files=; Path=/api/files; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        )],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}
async fn records(store: &FileStore, complete: bool) -> ApiResult<Json<Vec<FileRecord>>> {
    let mut result = Vec::new();
    let mut entries = match fs::read_dir(&store.dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Json(result)),
        Err(e) => return Err(storage_error(e)),
    };
    while let Some(entry) = entries.next_entry().await.map_err(storage_error)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = if complete { ".json" } else { ".upload.json" };
        let Some(id) = name.strip_suffix(suffix) else {
            continue;
        };
        if store.path(id, "json").is_err() {
            continue;
        }
        let data = fs::read(entry.path()).await.map_err(storage_error)?;
        let record: FileRecord = serde_json::from_slice(&data)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid file metadata."))?;
        if !complete || record.complete {
            result.push(record);
        }
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    Ok(Json(result))
}
async fn list(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<FileRecord>>> {
    store.auth(&headers, false)?;
    let _guard = store.writes.lock().await;
    records(&store, true).await
}
async fn list_uploads(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<FileRecord>>> {
    store.auth(&headers, true)?;
    let _guard = store.writes.lock().await;
    records(&store, false).await
}
fn validate_upload(input: &NewUpload) -> ApiResult<()> {
    if input.name.trim().is_empty()
        || input.name.len() > 255
        || input
            .name
            .chars()
            .any(|c| c.is_control() || "\\/:".contains(c))
        || matches!(input.name.as_str(), "." | "..")
        || input.fingerprint.len() > 256
        || input.fingerprint.is_empty()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid filename, size, or fingerprint.",
        ));
    }
    Ok(())
}
async fn create_upload(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Json(input): Json<NewUpload>,
) -> ApiResult<Json<FileRecord>> {
    finish_mutation(async move {
        store.auth(&headers, true)?;
        validate_upload(&input)?;
        let _guard = store.writes.lock().await;
        fs::create_dir_all(&store.dir)
            .await
            .map_err(storage_error)?;
        let id = crate::config::random_secret();
        let record = FileRecord {
            id,
            name: input.name,
            size: input.size,
            offset: 0,
            fingerprint: input.fingerprint,
            created_at: crate::config::now_ts(),
            complete: false,
        };
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(store.path(&record.id, "blob")?)
            .await
            .map_err(storage_error)?;
        store.save(&record).await?;
        Ok(Json(record))
    })
    .await
}
async fn upload_status(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<FileRecord>> {
    store.auth(&headers, true)?;
    let _guard = store.writes.lock().await;
    Ok(Json(store.record(&id).await?))
}
async fn append_chunk(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Json<FileRecord>> {
    finish_mutation(async move {
        store.auth(&headers, true)?;
        let offset = headers
            .get("upload-offset")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or((StatusCode::BAD_REQUEST, "Upload-Offset required."))?;
        let digest = format!("{:x}", Sha256::digest(&body));
        if headers.get("x-chunk-sha256").and_then(|v| v.to_str().ok()) != Some(digest.as_str()) {
            return Err((StatusCode::BAD_REQUEST, "Chunk checksum mismatch."));
        }
        let _guard = store.writes.lock().await;
        let mut record = store.record(&id).await?;
        if record.complete || record.offset != offset {
            return Err((
                StatusCode::CONFLICT,
                "Upload offset changed. Resume from server status.",
            ));
        }
        if body.is_empty()
            || body.len() > CHUNK_BYTES
            || body.len() as u64 > record.size.saturating_sub(offset)
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "Chunk exceeds remaining file size.",
            ));
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(store.path(&id, "blob")?)
            .await
            .map_err(storage_error)?;
        // Roll back any uncommitted tail left by a cancelled/failed previous write.
        file.set_len(offset).await.map_err(storage_error)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(storage_error)?;
        file.write_all(&body).await.map_err(storage_error)?;
        file.sync_data().await.map_err(storage_error)?;
        record.offset += body.len() as u64;
        store.save(&record).await?;
        Ok(Json(record))
    })
    .await
}
async fn complete_upload(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<FileRecord>> {
    finish_mutation(async move {
        store.auth(&headers, true)?;
        let _guard = store.writes.lock().await;
        let mut record = store.record(&id).await?;
        if record.complete {
            if fs::try_exists(store.path(&id, "upload.json")?)
                .await
                .map_err(storage_error)?
            {
                fs::rename(store.path(&id, "upload.json")?, store.path(&id, "json")?)
                    .await
                    .map_err(storage_error)?;
            }
            return Ok(Json(record));
        }
        let path = store.path(&id, "blob")?;
        if record.offset != record.size
            || fs::metadata(&path).await.map_err(storage_error)?.len() != record.size
        {
            return Err((StatusCode::CONFLICT, "Upload is incomplete."));
        }
        record.complete = true;
        store.save(&record).await?;
        fs::rename(store.path(&id, "upload.json")?, store.path(&id, "json")?)
            .await
            .map_err(storage_error)?;
        Ok(Json(record))
    })
    .await
}
async fn remove_upload(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    finish_mutation(async move { remove(&store, &headers, &id, false).await }).await
}
async fn remove_file(
    State(store): State<Arc<FileStore>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    finish_mutation(async move { remove(&store, &headers, &id, true).await }).await
}
async fn remove(
    store: &FileStore,
    headers: &HeaderMap,
    id: &str,
    complete: bool,
) -> ApiResult<StatusCode> {
    store.auth(headers, true)?;
    let _guard = store.writes.lock().await;
    store.record(id).await?;
    let published = fs::try_exists(store.path(id, "json")?)
        .await
        .map_err(storage_error)?;
    if published != complete {
        return Err((
            StatusCode::CONFLICT,
            "File state changed. Refresh the library.",
        ));
    }
    // Remove bytes first: on Windows an active download can prevent deletion.
    // Retain the catalog on failure so the owner can retry once it finishes.
    if let Err(error) = fs::remove_file(store.path(id, "blob")?).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(storage_error(error));
        }
    }
    fs::remove_file(store.path(id, if complete { "json" } else { "upload.json" })?)
        .await
        .map_err(storage_error)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn download(
    State(store): State<Arc<FileStore>>,
    Path(id): Path<String>,
    request: Request,
) -> ApiResult<Response> {
    store.auth(request.headers(), false)?;
    let record = store.record(&id).await?;
    if !record.complete
        || !fs::try_exists(store.path(&id, "json")?)
            .await
            .map_err(storage_error)?
    {
        return Err((StatusCode::NOT_FOUND, "File not found."));
    }
    let mut response = ServeFile::new(store.path(&id, "blob")?)
        .try_call(request)
        .await
        .map_err(storage_error)?
        .into_response();
    let encoded: String = record
        .name
        .as_bytes()
        .iter()
        .map(|b| format!("%{b:02X}"))
        .collect();
    response.headers_mut().insert(
        "content-disposition",
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{encoded}"
        ))
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid filename."))?,
    );
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(response)
}
fn storage_error(error: std::io::Error) -> ApiError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return (StatusCode::NOT_FOUND, "File not found.");
    }
    tracing::warn!("Files storage I/O failed: {error}");
    (
        StatusCode::INSUFFICIENT_STORAGE,
        "Storage unavailable, full, or busy. Check server disk space and retry.",
    )
}

// Detached request work retains the write lock until OS I/O really completes.
async fn finish_mutation<T: Send + 'static>(
    work: impl std::future::Future<Output = ApiResult<T>> + Send + 'static,
) -> ApiResult<T> {
    tokio::spawn(work).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Storage operation failed.",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    struct Fixture {
        store: Arc<FileStore>,
        app: Router,
    }
    impl Fixture {
        fn new() -> Self {
            let store = Arc::new(FileStore {
                dir: std::env::temp_dir().join(format!(
                    "echo-files-test-{}",
                    crate::config::random_secret()
                )),
                reader: Some("reader-password-for-files".into()),
                owner: Some("owner-password-for-files".into()),
                secret: crate::config::random_secret(),
                writes: tokio::sync::Mutex::new(()),
                attempts: Mutex::new(HashMap::new()),
            });
            let app = Router::new()
                .nest("/api/files", router(store.clone()))
                .layer(axum::Extension(ConnectInfo(
                    "127.0.0.1:12345".parse::<SocketAddr>().unwrap(),
                )))
                // Reproduce the main router's outer limit: chunks retain their own cap.
                .layer(DefaultBodyLimit::max(50 * 1024 * 1024));
            Self { store, app }
        }
        fn cookie(&self, role: &str) -> String {
            let token = encode(
                &Header::default(),
                &Claims {
                    role: role.into(),
                    exp: (crate::config::now_ts() + 3600) as usize,
                },
                &EncodingKey::from_secret(self.store.secret.as_bytes()),
            )
            .unwrap();
            format!("{COOKIE}={token}")
        }
        async fn request(
            &self,
            method: &str,
            path: &str,
            role: &str,
            body: impl Into<Body>,
            extra: &[(&str, String)],
        ) -> Response {
            let mut req = HttpRequest::builder()
                .method(method)
                .uri(format!("/api/files{path}"))
                .header("host", "echo.test")
                .header("x-echo-files", "1")
                .header("content-type", "application/json");
            if !role.is_empty() {
                req = req.header("cookie", self.cookie(role));
            }
            for (name, value) in extra {
                req = req.header(*name, value);
            }
            self.app
                .clone()
                .oneshot(req.body(body.into()).unwrap())
                .await
                .unwrap()
        }
        async fn create(&self, size: u64) -> FileRecord {
            let response = self.request("POST", "/uploads", "owner", serde_json::json!({"name":"Example 💾.zip", "size":size, "fingerprint":"source-id"}).to_string(), &[]).await;
            assert_eq!(response.status(), StatusCode::OK);
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap()
        }
        async fn append(&self, id: &str, offset: u64, bytes: &'static [u8]) -> Response {
            self.request(
                "PATCH",
                &format!("/uploads/{id}"),
                "owner",
                bytes,
                &[
                    ("upload-offset", offset.to_string()),
                    ("x-chunk-sha256", format!("{:x}", Sha256::digest(bytes))),
                ],
            )
            .await
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.store.dir);
        }
    }
    async fn json(response: Response) -> serde_json::Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn only_owner_can_mutate_and_all_files_require_auth() {
        let f = Fixture::new();
        assert_eq!(
            f.request("GET", "/catalog", "", "", &[]).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            f.request(
                "POST",
                "/uploads",
                "reader",
                r#"{"name":"x","size":0,"fingerprint":"x"}"#,
                &[]
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let record = f.create(0).await;
        for (method, path) in [
            ("GET", "/uploads".to_string()),
            ("GET", format!("/uploads/{}", record.id)),
            ("DELETE", format!("/uploads/{}", record.id)),
            ("POST", format!("/uploads/{}/complete", record.id)),
            ("DELETE", format!("/{}", record.id)),
        ] {
            assert_eq!(
                f.request(method, &path, "reader", "", &[]).await.status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            f.request("GET", &format!("/{}/download", record.id), "", "", &[])
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn chunks_publish_privately_and_download_with_ranges_and_original_filename() {
        let f = Fixture::new();
        let r = f.create(6).await;
        assert_eq!(
            json(f.request("GET", "/catalog", "reader", "", &[]).await).await,
            serde_json::json!([])
        );
        assert_eq!(
            f.request("GET", &format!("/{}/download", r.id), "reader", "", &[])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            f.request(
                "POST",
                &format!("/uploads/{}/complete", r.id),
                "owner",
                "",
                &[]
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(f.append(&r.id, 0, b"abc").await.status(), StatusCode::OK);
        assert_eq!(
            f.append(&r.id, 0, b"abc").await.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(f.append(&r.id, 3, b"def").await.status(), StatusCode::OK);
        let complete = format!("/uploads/{}/complete", r.id);
        assert_eq!(
            f.request("POST", &complete, "owner", "", &[])
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            f.request("POST", &complete, "owner", "", &[])
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            json(f.request("GET", "/catalog", "reader", "", &[]).await)
                .await
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let response = f
            .request(
                "GET",
                &format!("/{}/download", r.id),
                "reader",
                "",
                &[("range", "bytes=2-4".into())],
            )
            .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 2-4/6");
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert!(response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''%45%78"));
        assert_eq!(
            &to_bytes(response.into_body(), 100).await.unwrap()[..],
            b"cde"
        );
        assert_eq!(
            f.request("HEAD", &format!("/{}/download", r.id), "reader", "", &[])
                .await
                .headers()["content-length"],
            "6"
        );
        assert_eq!(
            f.request("DELETE", &format!("/{}", r.id), "owner", "", &[])
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            f.request("GET", &format!("/{}/download", r.id), "reader", "", &[])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn resume_uses_durable_offset_and_overwrites_uncommitted_tail() {
        let f = Fixture::new();
        let r = f.create(6).await;
        assert_eq!(f.append(&r.id, 0, b"abc").await.status(), StatusCode::OK);
        let mut blob = fs::OpenOptions::new()
            .append(true)
            .open(f.store.path(&r.id, "blob").unwrap())
            .await
            .unwrap();
        blob.write_all(b"uncommitted tail").await.unwrap();
        drop(blob);
        // New store instance reads only durable disk state, with no upload registry.
        let restarted = FileStore {
            dir: f.store.dir.clone(),
            reader: f.store.reader.clone(),
            owner: f.store.owner.clone(),
            secret: crate::config::random_secret(),
            writes: tokio::sync::Mutex::new(()),
            attempts: Mutex::new(HashMap::new()),
        };
        assert_eq!(restarted.record(&r.id).await.unwrap().offset, 3);
        assert_eq!(f.append(&r.id, 3, b"def").await.status(), StatusCode::OK);
        assert_eq!(
            fs::read(f.store.path(&r.id, "blob").unwrap())
                .await
                .unwrap(),
            b"abcdef"
        );
    }

    #[tokio::test]
    async fn checksum_size_and_concurrent_offset_guards_preserve_bytes() {
        let f = Fixture::new();
        let r = f.create(3).await;
        let bad = f
            .request(
                "PATCH",
                &format!("/uploads/{}", r.id),
                "owner",
                "abc",
                &[
                    ("upload-offset", "0".into()),
                    ("x-chunk-sha256", "wrong".into()),
                ],
            )
            .await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            f.append(&r.id, 0, b"toolong").await.status(),
            StatusCode::BAD_REQUEST
        );
        let (a, b) = tokio::join!(f.append(&r.id, 0, b"abc"), f.append(&r.id, 0, b"abc"));
        let mut statuses = vec![a.status(), b.status()];
        statuses.sort();
        assert_eq!(statuses, vec![StatusCode::OK, StatusCode::CONFLICT]);
        assert_eq!(
            fs::read(f.store.path(&r.id, "blob").unwrap())
                .await
                .unwrap(),
            b"abc"
        );
    }

    #[tokio::test]
    async fn empty_file_and_interrupted_publication_recover_idempotently() {
        let f = Fixture::new();
        let mut r = f.create(0).await;
        r.complete = true;
        f.store.save(&r).await.unwrap();
        assert_eq!(
            json(f.request("GET", "/uploads", "owner", "", &[]).await)
                .await
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            f.request(
                "POST",
                &format!("/uploads/{}/complete", r.id),
                "owner",
                "",
                &[]
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            f.request("GET", &format!("/{}/download", r.id), "reader", "", &[])
                .await
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn file_offsets_and_range_downloads_work_beyond_four_gibibytes() {
        let f = Fixture::new();
        let size = 5u64 * 1024 * 1024 * 1024;
        let mut r = f.create(size).await;
        let file = fs::OpenOptions::new()
            .write(true)
            .open(f.store.path(&r.id, "blob").unwrap())
            .await
            .unwrap();
        file.set_len(size).await.unwrap();
        drop(file);
        r.offset = size;
        f.store.save(&r).await.unwrap();
        assert_eq!(
            f.request(
                "POST",
                &format!("/uploads/{}/complete", r.id),
                "owner",
                "",
                &[]
            )
            .await
            .status(),
            StatusCode::OK
        );
        let response = f
            .request(
                "GET",
                &format!("/{}/download", r.id),
                "reader",
                "",
                &[("range", format!("bytes={}-{}", size - 3, size - 1))],
            )
            .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            &to_bytes(response.into_body(), 10).await.unwrap()[..],
            &[0, 0, 0]
        );
    }

    #[tokio::test]
    async fn body_limit_applies_per_chunk_even_with_echo_outer_limit() {
        let f = Fixture::new();
        let r = f.create(CHUNK_BYTES as u64 + 1).await;
        assert_eq!(
            f.request(
                "PATCH",
                &format!("/uploads/{}", r.id),
                "owner",
                vec![0u8; CHUNK_BYTES + 1],
                &[]
            )
            .await
            .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn login_sets_private_cookie_rate_limits_and_rejects_cross_origin_mutations() {
        let f = Fixture::new();
        let login = r#"{"role":"reader","password":"reader-password-for-files"}"#;
        let response = f.request("POST", "/session", "", login, &[]).await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()["set-cookie"].to_str().unwrap();
        for flag in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/files"] {
            assert!(cookie.contains(flag));
        }
        assert_eq!(
            f.request(
                "POST",
                "/session",
                "",
                login,
                &[("origin", "https://evil.test".into())]
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            f.request("POST", "/session", "", login, &[("origin", "null".into())])
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        for _ in 0..5 {
            assert_eq!(
                f.request(
                    "POST",
                    "/session",
                    "",
                    r#"{"role":"owner","password":"bad"}"#,
                    &[]
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            f.request("POST", "/session", "", login, &[]).await.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[test]
    fn all_user_supplied_paths_and_header_injection_are_rejected() {
        let f = Fixture::new();
        for bad in [
            "../secret",
            "..\\secret",
            "C:secret",
            "a\r\nb",
            ".",
            "..",
            "",
        ] {
            assert!(validate_upload(&NewUpload {
                name: bad.into(),
                size: 0,
                fingerprint: "x".into()
            })
            .is_err());
            assert!(f.store.path(bad, "json").is_err());
        }
        assert!(validate_upload(&NewUpload {
            name: "large.iso".into(),
            size: u64::MAX,
            fingerprint: "x".into()
        })
        .is_ok());
    }

    #[tokio::test]
    async fn cancelled_http_request_does_not_cancel_an_accepted_mutation() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let response = tokio::spawn(finish_mutation(async move {
            started_tx.send(()).unwrap();
            release_rx.await.unwrap();
            done_tx.send(()).unwrap();
            Ok(())
        }));
        started_rx.await.unwrap();
        response.abort();
        release_tx.send(()).unwrap();
        done_rx.await.unwrap();
    }

    #[tokio::test]
    async fn missing_csrf_header_expired_session_and_foreign_roles_are_rejected() {
        let f = Fixture::new();
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/api/files/session")
            .header("host", "echo.test")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"role":"owner","password":"owner-password-for-files"}"#,
            ))
            .unwrap();
        assert_eq!(
            f.app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            f.request("GET", "/catalog", "admin", "", &[])
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let expired = encode(
            &Header::default(),
            &Claims {
                role: "owner".into(),
                exp: 1,
            },
            &EncodingKey::from_secret(f.store.secret.as_bytes()),
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("{COOKIE}={expired}")).unwrap(),
        );
        assert_eq!(
            f.store.auth(&headers, false).err().unwrap().0,
            StatusCode::UNAUTHORIZED
        );
        let r = f.create(0).await;
        let mut pending = r.clone();
        pending.complete = true;
        f.store.save(&pending).await.unwrap();
        assert_eq!(
            f.request("DELETE", &format!("/uploads/{}", r.id), "owner", "", &[])
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn http2_native_authority_accepts_same_origin_and_rejects_ambiguous_origins() {
        for (origin, host, expected) in [
            ("https://echo.test:9443", None, StatusCode::OK),
            ("https://ECHO.test:9443", None, StatusCode::OK),
            ("https://evil.test:9443", None, StatusCode::FORBIDDEN),
            (
                "https://echo.test:9443",
                Some("evil.test:9443"),
                StatusCode::FORBIDDEN,
            ),
            ("http://echo.test:9443", None, StatusCode::FORBIDDEN),
            ("null", None, StatusCode::FORBIDDEN),
        ] {
            let f = Fixture::new();
            let mut request = HttpRequest::builder()
                .method("POST")
                .version(axum::http::Version::HTTP_2)
                .uri("https://echo.test:9443/api/files/session")
                .header("origin", origin)
                .header("x-echo-files", "1")
                .header("content-type", "application/json");
            if let Some(host) = host {
                request = request.header("host", host);
            }
            let response = f
                .app
                .clone()
                .oneshot(
                    request
                        .body(Body::from(
                            r#"{"role":"owner","password":"owner-password-for-files"}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "origin={origin} host={host:?}");
        }
    }

    /// Isolated real HTTP fixture for manually exercising browser cookie/download
    /// behavior. Never starts Echo services or reads the production environment.
    #[tokio::test]
    #[ignore = "manual browser smoke fixture; loopback only, exits after 45 seconds"]
    async fn serve_browser_smoke_fixture() {
        let fixture = Fixture::new();
        let port = std::env::var("ECHO_FILES_TEST_PORT")
            .expect("set an isolated ECHO_FILES_TEST_PORT")
            .parse::<u16>()
            .unwrap();
        assert!(port >= 1024 && port != 9443);
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let viewer = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../viewer");
        let app = Router::new()
            .nest("/api/files", router(fixture.store.clone()))
            .nest_service("/viewer", tower_http::services::ServeDir::new(viewer));
        if std::env::var("ECHO_FILES_TEST_TLS").as_deref() == Ok("1") {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let tls = crate::config::generate_self_signed().await;
            let handle = axum_server::Handle::new();
            let stop = handle.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(45)).await;
                stop.graceful_shutdown(Some(Duration::from_secs(5)));
            });
            println!("Files TLS/HTTP2 fixture ready at https://127.0.0.1:{port}/viewer/files.html");
            axum_server::from_tcp_rustls(listener.into_std().unwrap(), tls)
                .handle(handle)
                .serve(app.into_make_service_with_connect_info::<SocketAddr>())
                .await
                .unwrap();
        } else {
            println!("Files test fixture ready at http://127.0.0.1:{port}/viewer/files.html");
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async { tokio::time::sleep(Duration::from_secs(45)).await })
            .await
            .unwrap();
        }
    }
}
