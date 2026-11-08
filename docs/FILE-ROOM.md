# Echo File Room

The File Room is a private, persistent library served by the control plane. The
owner uploads files; friends use a separate shared Files password to download.
It is available from **More → Files** in Echo and directly at `/viewer/files.html`,
without connecting to a voice room. These are Files credentials, not individual
user accounts or the existing shared Echo/admin password.

Release impact: **server-only** (control plane plus server-served viewer).
Existing Windows desktop clients do not require a new installer. This feature
must be merged, configured, and deployed before friends can use it.

## Server configuration

Set these in the actual production control-plane environment, using the normal
operations/deployment process. Do not put the library inside a checkout or a
static web directory. Use an absolute path on a drive with enough free space:

```dotenv
CORE_FILES_DIR=D:\Echo Storage
CORE_FILES_PASSWORD=<a unique download password of at least 16 characters>
CORE_FILES_OWNER_PASSWORD=<a different unique owner password of at least 16 characters>
```

Both passwords are required, must differ, and must be at least 16 UTF-8 bytes.
Missing/invalid configuration disables the API with HTTP 503. Do not reuse the
Echo/admin password for owner access. The service account needs read/write/delete
permission on the storage directory. The directory is created on the first
upload. If `CORE_FILES_DIR` is omitted, the default is `files` beside the configured
chat directory (normally `logs/files`); use an explicit production path instead.

Share only the download password with friends. Both roles can browse/download;
only the owner can upload, see unfinished uploads, discard them, or delete files.
Sessions last 24 hours, use Secure/HttpOnly/SameSite=Strict cookies, and require
HTTPS in normal use. A server restart or password change followed by restart
requires signing in again. Sign-out clears the browser's Files cookie. Rotating a
shared password revokes the group at the next server restart; individual account
management, audit history, and per-friend revocation are not part of this module.

Before deployment or any production restart, follow `docs/OPERATIONS.md` and the
production network guard. This document does not authorize a service restart.

## Uploads, downloads, and storage

- No configured per-file size cap. Browser numeric representation, filesystem
  capacity, free space, and network/proxy policy remain physical limits.
- Uploads send at most 8 MiB per request, with a SHA-256 checksum, exact byte
  offset, and durable progress. No whole-file read into browser/server memory.
  Multiple selected files upload sequentially. Concurrent writers are serialized
  per chunk. Accepted writes finish even if the HTTP client disconnects.
- Pause or a network failure leaves the upload private. To resume, sign in as
  owner and select the unchanged original file again. Matching uses filename,
  byte length, modification time, and hashes of the first/last 64 KiB. Do not
  edit the source while an upload is incomplete. Abandoned uploads persist until
  the owner discards them and count toward used disk space.
- Publication requires the complete expected byte count. A failed/lost completion
  response can be retried safely. Incomplete uploads never appear to readers.
- Downloads stream through the browser/WebView download manager using authenticated
  GET/HEAD and HTTP byte ranges. The complete file is not fetched as a JS Blob.
  Browser download-manager capabilities determine pause/resume UX. If an expired
  session blocks a resumed download, sign in again before retrying it.
- All data stays on the Echo host. Disk IDs are random; supplied filenames are
  display/download metadata only. Files are always attachments with an
  octet-stream content type, private/no-store caching, and `nosniff`.
- Library deletion is permanent. Back up the storage directory as a unit, with
  uploads stopped or the service stopped through the approved operations process.
  There is no recycle bin, quota, replication, or automatic malware scanning.
- Full/unavailable storage returns HTTP 507 and leaves durable upload progress
  available for retry. Check drive space and service account permissions. Direct
  edits to `.blob`, `.json`, or `.upload.json` files are unsupported.

For reverse proxies, allow PATCH, Upload-Offset, X-Chunk-SHA256, X-Echo-Files,
Cookie, Range, HEAD, and attachment responses. Permit an 8 MiB request body and
appropriate transfer timeouts. Preserve the public Host/Origin relationship;
Files rejects cross-origin browser requests. Do not expose the storage directory
through static hosting or configure public CDN caching for `/api/files`.

## API contract

All routes are under `/api/files`. Mutations require `X-Echo-Files: 1` and a
matching Host/Origin when the browser supplies Origin. Cookie auth is scoped to
this API. Credentials/tokens are never passed in download URLs.

| Method/path | Role | Request/result |
| --- | --- | --- |
| `POST /session` | Public | JSON `{role: "reader" or "owner", password}`; sets session cookie; returns role |
| `GET /session` | Either | Current role and `chunk_bytes` |
| `DELETE /session` | Public | Clears cookie; 204 |
| `GET /catalog` | Either | Completed file records, newest first |
| `GET /uploads` | Owner | Unfinished records available for resume/discard |
| `POST /uploads` | Owner | JSON `{name, size, fingerprint}`; creates private upload |
| `GET /uploads/:id` | Owner | Durable record, including `offset` and publication state |
| `PATCH /uploads/:id` | Owner | Raw bytes; `Upload-Offset` and hex `X-Chunk-SHA256`; returns durable record |
| `POST /uploads/:id/complete` | Owner | Atomically publishes once all bytes exist; idempotent |
| `DELETE /uploads/:id` | Owner | Discards unfinished upload and bytes; 204 |
| `GET/HEAD /:id/download` | Either | Attachment stream; supports Range/206 and 416 |
| `DELETE /:id` | Owner | Permanently deletes published file; 204 |

Records contain `id`, `name`, `size`, `offset`, `fingerprint`, `created_at` (Unix
seconds), and `complete`. IDs are 64 lowercase hex characters. Integer sizes and
offsets use u64 on the server; the browser uses safe integer byte offsets.
Names are limited to 255 UTF-8 bytes and reject path separators, colon, dot-only
names, and control characters. This is a filename limit, not a file size cap.

Errors are plain text: 400 invalid input/checksum/size; 401 missing/expired/bad
credentials; 403 wrong role/origin/header; 404 missing record; 409 offset or file
state conflict/incomplete publication; 413 chunk exceeds 8 MiB; 429 login attempt
limit (five failed attempts per peer IP per 15 minutes); 503 disabled; 507 storage
unavailable/full/busy. Use GET upload status after an ambiguous PATCH result;
never blindly append bytes a second time. Login failures behind a proxy share
its peer-IP bucket; forwarded client IPs are intentionally not trusted.

## Verification

```powershell
cargo test --locked --manifest-path core/Cargo.toml -p echo-core-control files::tests
node --test core/viewer/files-transfer.test.js
npm --prefix core/viewer-tests test -- files.spec.js --workers=1
```

Backend tests cover permissions, path/header injection, private publication,
checksums, replayed/concurrent offsets, durable resume after an uncommitted tail,
request cancellation, empty files, interrupted completion, chunk limits, cookie
flags, cross-origin rejection, rate limiting, deletion, and range reads beyond
4 GiB. Browser tests cover real chunk/checksum generation, download-manager
handoff, Files panel integration, and desktop/phone overflow. Browser API fixtures
are isolated; they do not access the production service.

A real HTTP/browser smoke fixture is also available. In one terminal:

```powershell
$env:ECHO_FILES_TEST_PORT = '4197'
cargo test --locked --manifest-path core/Cargo.toml -p echo-core-control files::tests::serve_browser_smoke_fixture -- --ignored --exact --nocapture
```

As soon as it reports ready, run in another terminal:

```powershell
npm --prefix core/viewer-tests run test:files:smoke
```

This loopback-only fixture uses temporary storage and test-only credentials,
serves only Files and static viewer assets, and exits automatically after 45
seconds. It never reads the production environment or starts EchoCoreHost.
The smoke verifies real Secure/HttpOnly browser cookies, a 9 MiB upload, a
byte-identical download with its original filename, byte-range responses, and a
reader's denied delete request. Chromium trusts loopback for this isolated test;
normal remote users still require HTTPS. Screenshot: the ignored viewer-test
`test-results/real-files-browser-smoke.png` output.
