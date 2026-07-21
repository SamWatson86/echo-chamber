# Private Diagnostics Owner UI

The diagnostics owner surface is available at:

```text
/admin/diagnostics/
```

It is a dedicated page, separate from the ordinary Echo Chamber admin
dashboard. It does not reuse ordinary admin authentication, room credentials,
or the legacy admin page's browser state.

## Authentication boundary

Set a unique `CORE_DIAGNOSTICS_OWNER_SECRET` of at least 32 random bytes to
enable private diagnostics. The UI sends that exact secret in a same-origin
`POST /v1/auth/diagnostics/login` request. It does not trim or otherwise alter
the secret.

A successful login returns a diagnostics-only bearer token with a maximum
one-hour lifetime. The secret and token are held only in the page's JavaScript
memory and are never placed in cookies, web storage, IndexedDB, `window.name`,
URLs, DOM attributes, or logs. Incident data and pagination history are also
memory-only and are erased at session boundaries; vetted incident fields are
rendered only as text or constrained presentation/accessibility attributes.
The password input is cleared as soon as a login attempt begins.

Signing out, reloading, leaving the page, receiving an authentication failure,
or reaching the token expiry clears the token and private view. A new login is
required after any of those events.

## Browsing incidents

The page loads incidents only when the owner signs in, selects Refresh, or
uses a pagination control. There is no polling or automatic refresh.

Each request asks for 51 summaries and renders at most 50. The extra summary
only determines whether a next page exists. Next-page requests use the last
rendered incident's compound `(received_at_ms, incident_id)` cursor; Previous
uses an in-memory cursor stack and never puts cursor state into browser
storage.

Identity/incident search, operating-system, minimum-severity, and event-type
filters apply only to the currently loaded page. They do not issue server
queries and are cleared on sign-out.

Incident detail is rendered from an explicit set of structured fields using
text-only DOM operations. Store-local identity digests, payload digests,
fingerprints, and free-form message fields are not shown. Untrusted strings are
never interpreted as HTML. Download and delete controls stay disabled until a
matching detail response has been validated, and disable again when that detail
is closed or cleared.

## Download and deletion

Download uses an authenticated same-origin fetch. The browser reads the
response as a bounded stream and cancels it once a conservative size ceiling is
crossed, even when `Content-Length` is absent or incorrect. It then parses the
response as JSON, verifies that its incident ID matches the selected record,
and creates a local file named:

```text
echo-diagnostic-inc_<32 lowercase hex characters>.json
```

The temporary blob URL is revoked after the browser receives the download.
The bearer token is never included in the URL or filename.

Deletion always requires an explicit browser confirmation. A confirmed delete
uses the owner-authenticated `DELETE /admin/api/diagnostics/{incidentId}`
endpoint, removes the confirmed record from the in-memory page, and only then
refreshes the current server page. A failed refresh cannot restore the stale
row. There is no automatic GitHub issue creation or other publishing path.

## Network and failure behavior

All requests are same-origin with credentials omitted, caching disabled,
referrers suppressed, and redirects rejected. Failure response bodies are not
read or displayed. The page maps HTTP status codes to short local messages:

- `401` and `403` end the owner session.
- `404` during login or listing reports that private diagnostics are disabled
  or unavailable.
- `429` shows a bounded delay derived from `Retry-After` when it is valid.
- Other client and server failures use opaque local wording.

Every asynchronous operation is fenced to the active login generation.
Signing out or leaving the page aborts in-flight requests and prevents late
responses from restoring private state.

## Static asset boundary

The control plane scopes `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` to the
dedicated `/admin/diagnostics/` static tree. The existing `/admin/` application
keeps its original static route and behavior. The diagnostics HTML also carries
a restrictive page-local Content Security Policy and has no inline scripts,
styles, or event handlers.

## Release boundary

The owner page is served by the control plane from `core/admin/diagnostics/`.
Changes to it are server-side/static-asset changes; they do not require a new
Windows desktop binary. Enabling or changing the owner secret is an operations
change and still follows the service verification and restart rules in
`docs/OPERATIONS.md`.
