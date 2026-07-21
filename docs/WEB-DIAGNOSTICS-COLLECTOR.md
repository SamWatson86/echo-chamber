# Mac Web Canary Diagnostics Collector

Date: 2026-07-21
Release impact: coordinated control-plane and server-served viewer update; no desktop binary

## Scope

This collector is limited to the desktop macOS browser fallback. It does not run
inside the native Echo shell, on Windows/Linux browsers, or on iPadOS devices
that identify themselves as `MacIntel`. Existing users therefore receive no
prompt or collection behavior unless they are using the Mac web canary.

The canary is also locally enrollment-gated. A fresh desktop Mac profile on the
normal viewer URL remains inert. The first prompt appears only from the exact
non-secret trailing-slash invitation
`/viewer/?echoWebDiagnosticsCanary=1`. After that choice, an exact
enabled/disabled diagnostics consent value keeps only that profile enrolled on
the normal URL. The flag is not authorization. It is removed after the first
consent decision while preserving unrelated query parameters and the fragment,
and no separate pre-consent enrollment key is written.

Diagnostics remain off until the browser user explicitly accepts the first-run
consent. The same Settings panel then provides an On/Off switch, last-upload
status, Send Now, and Delete Queued Data. Turning diagnostics off first records
the disabled preference, aborts pending work, and removes the browser-local
diagnostics identifiers and queue. It cannot recall an incident that the Echo
server already accepted; server incidents remain under the owner's normal
retention/delete controls.

## Privacy boundary

The browser records only fixed event codes and allowlisted booleans, counts,
numbers, and short enum-like values. The event adapters never read free-form
error messages, stacks, source filenames, URLs, console arguments, device
identifiers/labels, chat, screenshots, media content, clipboard data, window
titles, processes, or files. Raw identities, room names, tokens, and headers are
never placed in event details, browser storage, or the queued wire envelope.

Collection sanitizes before browser storage. The control plane validates the
closed schema and sanitizes again before private persistence. The participant
JWT and successful-heartbeat control origin exist only in memory and are never
included in a queued envelope. A local-only SHA-256 scope digest binds each
queued wrapper to the diagnostics installation, normalized control origin, and
JWT subject. The raw subject is used only in memory for that derivation. The
wrapper is stripped before upload, and reports from another origin or
participant cannot cross that boundary. After authentication, the server links
an accepted report to the current Echo participant for private owner review; the
report is private, not anonymous.

## Delivery and retry model

- Each diagnostics installation and page session uses a separate canonical
  lowercase UUID generated with the browser's secure random source.
- Draft events may be accumulated locally, but an envelope becomes immutable
  before its first request. Every retry sends byte-identical JSON so a lost
  acknowledgement cannot become an idempotency conflict.
- The complete persisted queue document (including JSON wrapper overhead) is
  limited to ten envelopes and 512 KiB, with a 72-hour retention window shorter
  than the server's seven-day ingestion maximum.
- Concurrent tabs share browser storage on a best-effort basis. Simultaneous
  writes can lose a diagnostic event or unclean-tab sentinel, but every sealed
  report retains its participant-and-origin scope and cannot be uploaded under
  a different scope.
- Upload is released only by an HTTP-successful, non-stale participant heartbeat
  using the exact LiveKit JWT and control origin that heartbeat just proved.
- `202 accepted` and `200 duplicate` remove the local envelope. Authentication,
  disabled-service, rate-limit, permanent-schema, and transient-server failures
  follow bounded non-looping policies.
- Credential replacement seals the prior draft and rotates the diagnostics
  session. Late responses from an aborted upload cannot mutate a newer session
  or recreate data after opt-out.
- Unclean-tab sentinels use a conservative five-minute stale window and carry
  only the same opaque local scope digest. A stale tab is reported only after a
  matching participant heartbeat; unknown or different-user sentinels are
  never attributed to the current user.
- The server retains accepted detail for approximately 14 days under its global
  disk cap.

## Build metadata and browser limitations

`GET /api/version` now returns the exact short Git SHA compiled into the control
binary along with the release version. Repository builds discover the SHA from
Git; source-less packaging must set `ECHO_GIT_SHA`, and the build fails rather
than emitting a fake value when neither source is available.

The browser reports its safe browser/LiveKit versions and that the operating
system is macOS. Safari does not reliably reveal the Apple Silicon architecture
or exact macOS build without fingerprint-heavy APIs, so those fields remain
unknown or absent. The collector never guesses them.

## Deliberate exclusions

- No console interception or arbitrary-log upload.
- No native/Tauri panic or Application Support spool; those require a native
  Mac client and are outside the web fallback.
- No third-party telemetry.
- No live deployment, service restart, or tester rollout is part of this PR.

Use `docs/WEB-DIAGNOSTICS-TESTING.md` for the isolated readiness gate,
approved-window deployment checks, Safari canary matrix, and rollback rules.
