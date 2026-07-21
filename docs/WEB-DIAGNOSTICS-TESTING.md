# Mac Web Canary Diagnostics Testing Runbook

Date: 2026-07-21
Release impact: coordinated control-plane, server-served viewer, and admin-static update; no desktop binary

## Purpose and status

This is the go/no-go checklist for the first approved desktop Safari canary of
Echo's private web diagnostics. It covers the browser collector, private owner
page, and control-plane boundary as one release unit.

Passing the local readiness gate means the code is ready for a controlled
manual test. It does **not** deploy anything, enable collection, restart Echo,
or authorize a production outage. Production work still requires Sam's
explicitly approved window and the preflight in `docs/OPERATIONS.md`.

Ordinary testers should never locate, package, or send log files. They opt in,
reproduce the problem, and report the approximate time and what they did. Sam
uses the private owner page to find the matching structured incident.

## Supported canary boundary

| Area | Canary behavior |
| --- | --- |
| Enrollment | Disabled by default; one profile is invited with the exact non-secret `?echoWebDiagnosticsCanary=1` flag |
| Browser | Enrolled desktop macOS browsers; the first real-engine canary is Safari |
| Consent | Off until the tester explicitly accepts; reversible in Settings |
| Collection | Closed-schema browser/session, JavaScript, permission/media, and connection/reconnect events |
| Upload | Only after a current authenticated participant heartbeat |
| Review | Private `/admin/diagnostics/` page with a separate owner secret |
| Retention | About 14 days by default, under a default 100 MiB global cap |
| Desktop impact | None; there is no Windows or Mac desktop-binary update |

The invitation flag is enrollment UX, not authentication or upload authority.
The tester still makes the explicit consent choice, and upload still requires a
current authenticated participant heartbeat. A fresh Mac profile visiting the
normal viewer URL remains completely inert: no prompt, settings section,
diagnostics storage, version lookup, or upload. After **Allow Diagnostics** or
**Keep Off**, the exact existing consent value becomes that profile's durable
enrollment marker and the invitation flag is removed from the URL. Do not
publish or broadly share the canary link. Once invited, this code supports any
desktop macOS browser, not only Safari.

The web fallback deliberately cannot provide native/Tauri/Rust panic capture,
an Application Support crash spool, updater/notarization evidence, DMG launch
coverage, exact Apple Silicon architecture, or the exact macOS build. Record
the Mac model/chip and OS build manually. Safari also cannot promise lossless
multi-tab storage coordination, so use exactly one Echo tab for the primary
canary. System-audio, native screen-capture, and output-device behavior remain
browser capability questions rather than diagnostics guarantees.

## Information required before scheduling

Record these facts before the outage or tester session:

| Field | Value |
| --- | --- |
| Approved outage date/time and owner | |
| Primary tester | |
| Mac model and Apple chip | |
| Exact macOS version/build | |
| Exact Safari version | |
| Tester comfortable opening Safari Web Inspector? | |
| Test room and participant display name | |
| Planned deployed Echo version and Git SHA | |
| Exact invited canary URL and approved recipients | |
| Any prior ungated collector exposure/accounted profiles | |
| Rollback control binary, viewer snapshot, and admin snapshot/path | |

Use a fresh Safari profile or a dedicated macOS test account for the initial
consent pass. Do not clear all site data from a tester's normal profile. The
unclean-session scenario must use a normal persistent profile, not a private
window whose storage disappears when the window closes.

An exact enabled/disabled consent value from any earlier ungated collector also
counts as enrollment. Before claiming an exact-recipient blast radius, establish
whether such a viewer was ever served and account for those profiles. If it was
never served, there is no migration population.

## 1. Offline readiness gate

From this repository, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify\web-diagnostics-readiness.ps1
```

The command is working-directory independent and fails fast. It records the
tested Git branch, HEAD, and working-tree state, then runs the quick repository
checks, full Playwright regression suite, locked control-plane tests, Rust
formatting check, atomic viewer-runtime deployment tests, a locked control
build, and an isolated API/static-asset smoke. The smoke process binds only to
loopback on port `19091`, uses temporary directories and synthetic credentials,
and does not inspect or change live Echo services or clients.

If that port is occupied, select another unused loopback port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify\web-diagnostics-readiness.ps1 -Port 19327
```

`-SkipControlBuild` is only for a repeat run when the matching debug control
binary has already been built. The recorded release gate must use the default
command. Any failure is a no-go; do not compensate by probing the live server.

The combined gate covers malformed, oversized, stale, unauthenticated,
duplicate/idempotent, rate-limited, redacted, download, deletion,
storage-isolation, owner-auth, and client participant/origin queue-scoping
cases. Do not replay hostile or load-oriented variants against production.

Playwright runs Chromium. Its consent test uses a Safari user agent and Mac
platform values to exercise the browser gate, but that is not Safari/WebKit
evidence. The controlled pass on the physical Mac is the real Safari gate.

## 2. Approved-window deployment gate

Before stopping anything, tell Sam that the control outage will disconnect
active Echo users. Then run the complete Echo preflight from
`docs/OPERATIONS.md` and record:

- clean, up-to-date production checkout and exact `origin/main` SHA;
- `/api/version` and `/health` before the change;
- `EchoCoreHost` state, configured child paths, and recent host log;
- the actual live viewer and admin directories;
- the exact rollback control binary and complete viewer/admin snapshots.

Configure diagnostics only in the protected control environment:

- `CORE_DIAGNOSTICS_OWNER_SECRET`: a new cryptographically random value with at
  least 32 random bytes. It must not reuse the room/admin password or hash,
  admin JWT secret, LiveKit/TURN/Jam/GitHub credential, or any tester secret.
  Never commit it, put it in a URL, paste it into a ticket, or include it in
  test evidence.
- `CORE_DIAGNOSTICS_DIR`: an explicit private durable directory disjoint from
  the viewer, admin, chat, upload, soundboard, avatar, and chime roots. Existing
  directories and served roots must not contain links/junctions that undermine
  that separation; startup fails closed if isolation cannot be proven.
- `CORE_DIAGNOSTICS_RETENTION_DAYS`: leave at `14` unless Sam deliberately
  chooses another value in the supported 1-30 day range.
- `CORE_DIAGNOSTICS_MAX_MB`: leave at `100` unless Sam deliberately chooses
  another value in the supported 1-1024 MiB range.

Deploy the matching control binary, **complete** viewer snapshot, and
**complete** `core/admin` static tree as one coordinated unit during the
approved outage. The viewer publisher in `docs/OPERATIONS.md` provides the
required atomic viewer swap; it does not publish admin assets.

The control log reports `admin dir: ...`. If `ECHO_CORE_ADMIN_DIR` points
outside the clean production checkout, stop: there must first be an explicit
full-admin snapshot, verification, and rollback procedure for that directory.
Never hot-copy only `diagnostics.js`, `index.html`, or another individual
admin/viewer file. If the default admin directory resolves into the clean
production checkout, verify that the checkout contains the matching complete
`core/admin` tree before starting the new control binary.

This is a no-go if any of the following is true:

- the production checkout is dirty, stale, or not the intended commit;
- the real control/viewer/admin path is unknown or does not match the prepared
  release unit;
- the diagnostics directory overlaps a served or user-content root;
- the owner secret is missing, weak, reused, or exposed;
- the exact canary-link recipients and desktop-Mac browser blast radius have not
  been approved;
- any prior ungated collector exposure is unknown or its enrolled profiles are
  unaccounted for;
- the primary tester cannot perform the required Safari Web Inspector privacy
  check with Sam's guidance;
- a complete rollback unit is not ready;
- the offline readiness gate is not green.

## 3. Post-start server checks

After the coordinated restart, but before inviting a tester:

1. Confirm `EchoCoreHost` and all expected child processes are healthy.
2. Confirm the host/control logs show the expected control executable,
   `viewer dir: ...`, `admin dir: ...`, and `private diagnostics enabled at ...`.
   A weak/reused-secret warning or `private diagnostics disabled` is a no-go.
3. Confirm `/api/version` reports the planned release version and exact short
   Git SHA. Health alone is not sufficient. This identifies the control build,
   not the loaded viewer JavaScript.
4. Confirm `/health` is healthy.
5. Run `core/deploy/publish-viewer-runtime.ps1 -VerifyOnly` against the actual
   `ECHO_CORE_VIEWER_DIR` from the clean intended commit. Confirm the served
   `/viewer/` HTML references `diagnostics-client.js` and the script returns
   `200`; a matching control SHA cannot compensate for a stale viewer snapshot.
6. Compare the actual admin root's three diagnostics asset hashes with the
   clean intended commit, then confirm each served asset returns `200`:
   `/admin/diagnostics/`, `/admin/diagnostics/diagnostics.js`, and
   `/admin/diagnostics/diagnostics.css`.
7. Confirm those three responses carry `Cache-Control: no-store`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
   `X-Frame-Options: DENY`.
8. Confirm the existing `/admin/` page still loads and behaves normally.
9. Open `/admin/diagnostics/` in a fresh owner browser tab. Confirm an ordinary
   admin or room credential is rejected, the separate owner secret succeeds,
   and signing out clears the private view.

Do not place the owner secret in command-line probes. Enter it only into the
dedicated page over the verified HTTPS origin.

## 4. One-tab Safari canary

Keep the owner page on Sam's machine and the viewer on the tester's Mac. Record
UTC timestamps and incident IDs throughout.

### A. Consent stays off

1. Open the normal `/viewer/` HTTPS URL in a fresh desktop Safari profile with
   one Echo tab. Confirm there is no diagnostics prompt or Settings section and
   no `echo-web-diagnostics-*` browser storage.
2. In Safari Web Inspector's Network view, confirm neither `/api/version` nor
   `/api/diagnostics/v1/envelopes` was initiated by `diagnostics-client.js`.
   Other existing viewer code may independently check `/api/version`.
3. Open the explicitly approved invitation by appending the exact flag to the
   trailing-slash viewer URL:

   ```text
   https://<echo-host>/viewer/?echoWebDiagnosticsCanary=1
   ```

   Confirm the **Mac Web Canary Diagnostics** prompt appears. This non-secret
   link enrolls the browser profile; it grants no server authorization.
4. Before deciding, confirm there is still no diagnostics storage,
   diagnostics-client-initiated version lookup, or envelope upload. The flag
   remains in the URL so an undecided reload can show the invitation again.
5. Select **Keep Off**. Confirm the flag disappears while any unrelated query
   parameters and fragment remain, then reload the normal `/viewer/` URL.
6. In Settings, confirm **Private Web Diagnostics** remains enrolled but off,
   with zero queued reports and no successful delivery status.

### B. Opt in and baseline delivery

1. Turn on **Send technical diagnostics to Sam's Echo server** in Settings.
2. Join the designated room. On the first microphone permission request, choose
   Safari's deny option and record the UTC time for section C. Echo requests the
   camera separately immediately afterward; allow that camera request. Then
   wait for the normal Echo heartbeat to succeed.
3. Wait for **Accepted** or **Already received**. If the queued count is still
   nonzero and **Send Now** is enabled, select it; an already drained queue is
   success and does not require Send Now.
4. In the owner page, refresh and open the matching `session.start` incident.
   Confirm the Echo version, exact Git SHA, Safari/LiveKit versions, `macos`,
   participant, and timestamps are coherent. Architecture may correctly be
   `unknown`; compare against the manually recorded hardware facts.

### C. Permission denial

1. Inspect the permission denial created during the baseline join. If Safari
   did not prompt because the origin already had a decision, reset only that
   origin's microphone permission, reload, and repeat the join/deny action.
2. Wait for heartbeat, then select **Send Now** only if the queued count is
   nonzero and the button is enabled.
3. Confirm the owner detail contains a microphone/permission denied event with
   a safe code such as `permission_denied`, but no device label or raw browser
   error message.

### D. JavaScript privacy canary

With diagnostics on and Web Inspector open, run exactly this synthetic error:

```javascript
setTimeout(() => { throw new TypeError("ECHO_CANARY_DO_NOT_STORE"); }, 0)
```

The page should remain usable. Confirm the owner receives
`javascript.window_error` with safe code `type_error`. View and download the
incident, then search the JSON: `ECHO_CANARY_DO_NOT_STORE`, the thrown message,
a stack, source URL/path, credentials, chat, and device labels must all be
absent. Any appearance of that marker or message is an immediate stop/rollback.

### E. Network interruption

1. While joined, disable the Mac's Wi-Fi for roughly 10-15 seconds, then
   restore it. Do not disturb SAM-PC or any unrelated publisher/client.
2. Allow Echo to reconnect and complete another heartbeat; use **Send Now** if
   needed.
3. Confirm a coherent bounded sequence such as `reconnect.started` followed by
   `reconnect.completed`, or an accurate disconnect/connect sequence. The
   viewer must recover without an upload loop or a flood of duplicate rows.

### F. Unclean-session observation

1. First perform an ordinary reload, keep the reloaded page open for more than
   five minutes, and confirm the prior clean session does not produce
   `session.unclean_shutdown`.
2. Confirm diagnostics are on, the tester is authenticated, and a heartbeat
   has succeeded in a persistent Safari profile. Save/close unrelated Safari
   work because the next command terminates every Safari process immediately.
3. In Terminal on the tester's Mac, perform the exact hard kill:

   ```bash
   killall -9 Safari
   ```

   A normal tab close or Command-Q is a clean shutdown and is not this test.
   Wait more than five minutes.
4. Reopen the same profile, origin, and Echo participant; wait for heartbeat
   and select **Send Now** only if a queued report remains.
5. Look for `session.unclean_shutdown`. The owner record may show the expected
   server-derived authenticated participant, but the event details must not
   contain a URL, window/tab title, or raw browser-provided identity.

This sentinel is intentionally best effort because Safari owns process and
storage semantics. Record whether it appeared, but absence by itself is not a
release blocker when all hard gates pass. Cross-user attribution, upload before
heartbeat, or leaked raw data is always a blocker.

### G. Queue deletion and opt-out

1. After a good heartbeat, disable Wi-Fi, inject the section D TypeError again,
   and wait until the queued count is nonzero. Use **Delete Queued Data**, then
   restore Wi-Fi. Confirm the count remains zero and the deleted report does not
   upload.
2. Turn diagnostics off. Confirm the preference stays off after reload, queued
   data and diagnostics-owned identifiers are removed, and no later upload
   occurs. Turning off cannot recall a report the server already accepted.
3. In the owner page, exercise search/filtering on the current page, download
   one known incident, confirm deletion, and verify the deleted incident does
   not return after refresh.
4. Sign out and confirm the private list/detail disappears and a new owner
   login is required.

### H. Safari product smoke and soak

Diagnostics are useful only if the browser fallback itself remains usable.
Reset the test origin's microphone permission and allow it; confirm camera
permission remains allowed, resetting both origin permissions if needed. Then
complete:

- join, leave, and switch rooms;
- allow microphone, verify live audio, mute/unmute, and remain connected for at
  least 30 minutes;
- publish camera and receive another participant's audio and camera;
- receive a remote screen share and exercise normal chat and tools;
- when a Jam source is available, join, hear it, and exercise the controls
  permitted to that participant;
- sleep/wake the Mac once and confirm the viewer reconnects;
- record Safari's system-output selection behavior and screen-share video
  behavior without treating unsupported output selection or missing system
  audio as a diagnostics failure.

Successful receive, chat, and Jam actions often produce no diagnostic event;
that absence is expected. Safari screen publishing, system audio, and output
device selection are capability-limited and non-blocking when the UI explains
the limitation. Failure of core join, microphone, camera, receive, chat, or
reconnect behavior is blocking. Record Jam as N/A only when no test source is
available.

### I. Existing-user isolation

Use a tester-owned Windows browser session, not SAM-PC and not a shared client.
Confirm the normal viewer shows no diagnostics prompt or Settings section,
creates no `echo-web-diagnostics-*` keys or diagnostics requests, and still
connects, publishes microphone/camera, receives media, and uses chat normally.
Do not close, reload, or alter Sam's local Echo client without separate explicit
approval.

## 5. Evidence and acceptance

Keep the evidence private and exclude the owner secret, tokens, downloaded
incident bodies, store-local identity/payload digests, or unrelated user data.
The owner UI intentionally hides those digests; an authenticated download may
legitimately contain them, so retain the file privately and evaluate the actual
privacy canary fields rather than treating a digest as raw identity leakage.

| Scenario | UTC time | Incident ID | Pass/fail/observed | Notes |
| --- | --- | --- | --- | --- |
| Server version/SHA and route headers | | | | |
| Normal fresh Mac URL remains inert | | N/A | | |
| Exact invite and durable consent enrollment | | N/A | | |
| Consent off/no upload | | N/A | | |
| Baseline session delivery | | | | |
| Microphone permission denial | | | | |
| JavaScript privacy marker absent | | | | |
| Network reconnect and recovery | | | | |
| Unclean session (best effort) | | | Observed/not observed | |
| Delete queued data and opt-out | | N/A | | |
| Owner download/delete/sign-out | | | | |
| Safari product smoke and 30-minute soak | | N/A | | |
| Tester-owned Windows isolation/regression | | N/A | | |
| Existing admin regression check | | N/A | | |

The canary is accepted only when every hard gate above passes, the reported
version/SHA and manually recorded Mac facts are unambiguous, no forbidden data
appears, opt-out remains effective, and the existing viewer/admin behavior is
healthy. Native Mac-client criteria are explicitly not applicable to this web
fallback and must not be claimed as covered.

## 6. Stop and rollback

Stop the canary immediately for a privacy leak, cross-user attribution,
pre-consent upload, repeated upload loop, owner-auth bypass, mixed asset set,
or viewer/admin regression.

1. Disconnect every enrolled tester Mac from the network immediately, without
   closing the current Echo tab. While offline, have the tester turn diagnostics
   off and confirm its queue is empty; do not ask them to collect files or edit
   browser storage. Keep the Mac offline until Sam clears the incident response.
   If the toggle cannot be reached, close Safari while still offline and do not
   reopen the canary profile until Sam decides how to handle its queue.
2. To disable server ingestion and owner access while retaining automatic
   pruning, remove `CORE_DIAGNOSTICS_OWNER_SECRET` from the protected control
   environment and perform the approved control restart with the current
   diagnostics-capable binary.
3. Server disable/rollback does not remotely erase browser queues. A `404`
   leaves an opted-in queued envelope for up to 72 hours, and a later server
   re-enable could release it after a new heartbeat. Do not re-enable collection
   during a privacy investigation until Sam has decided how every enrolled
   profile and retained queue will be handled.
4. If code rollback is required, restore the matching prior control binary,
   complete viewer snapshot, and complete admin tree together. Do not perform a
   partial static-file rollback.
5. Preserve the private diagnostics store unless Sam explicitly approves its
   deletion. An older binary will not prune that new store, so assign a manual
   retention action if the code is fully rolled back.
6. Re-run `/api/version`, `/health`, viewer, existing admin, and service-log
   verification after rollback.

There is no desktop client, installer, updater, or Mac artifact to roll back.
