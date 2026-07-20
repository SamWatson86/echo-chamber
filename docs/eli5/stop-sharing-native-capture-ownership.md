# Native Stop Sharing reliability

## The simple version

Echo Desktop publishes a native screen share through a separate hidden
`$screen` participant. The viewer shows that publication on the Stage and marks
the owner's People card as **Sharing**.

Previously, a retiring Windows capture task could finish after its replacement
had started. That old task erased the replacement's native-capture handle and
sent an unversioned "capture stopped" event. The screen publisher could keep
running, but the viewer forgot that Rust owned it. Clicking **Stop Sharing**
then stopped only the browser-side audio and left the video, Stage tile, and
Sharing badge alive.

Native capture attempts now receive one cross-backend session ID. Replacing a
share atomically installs the new owner before the old task is stopped. Only
the current owner may update capture health, clear the native handle, or emit a
stop/error event. WGC and Desktop Duplication also retire each other so only
one native video publisher can own the screen companion.

The viewer remembers the session ID returned by Echo Desktop and ignores late
events from older sessions. If its in-memory flags are ever lost, the Stop
button can recover ownership from native health or from the user's live
`$screen` companion. It stops the applicable native capture engine—or both
idempotent engines when the mode is unknown—removes the companion, and clears
the Stage tile and Sharing indicator together.

## How we know it works

- Rust ownership tests cover replacement, stale completion, cross-backend
  exclusion, and stop-during-start behavior.
- Viewer unit tests reproduce the lost-flag state for both WGC and Desktop
  Duplication and verify stale session events cannot tear down a replacement.
- A browser layout test clicks the real **Stop Sharing** control and verifies
  the native stop commands, companion removal, Stage cleanup, Sharing badge,
  settings control, and dock state.

## Release boundary

This fix needs both pieces:

- the control-plane viewer bundle supplies the recovery behavior and truthful
  UI cleanup; and
- a new Windows Echo Desktop binary supplies session-owned native capture.

Updating only the server does not repair the old native handle race. Updating
only Echo Desktop leaves older served viewer code unable to recover when its
volatile flags are missing.

## What could still go wrong?

- An old Echo Desktop binary can still lose its capture handle. The new viewer
  can remove the server-side companion, but fully stopping an already orphaned
  local encoder may require exiting that old client.
- If both native stop commands and the authenticated companion-removal request
  fail, Echo deliberately keeps the Sharing UI visible so the user can retry
  instead of falsely claiming the stream is gone.
