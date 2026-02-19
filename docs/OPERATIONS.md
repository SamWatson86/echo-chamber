# Operations Runbook

This runbook is intentionally short and practical for a friend-group service.

## Deployment modes

### Mode A: Central/shared server
- One host runs the control runtime.
- Clients (browser or desktop) connect to that host.
- Most behavior changes are deployed server-side.

### Mode B: Local desktop-hosted runtime
- A desktop app instance runs the runtime locally for usage.
- Updates may require desktop binary refresh depending on what changed.

Use [Release Boundaries](./RELEASE-BOUNDARIES.md) to decide whether a binary release is required.

---

## Daily operator checklist

1. Confirm service is reachable.
2. Confirm logs are being written.
3. Verify a basic room join + audio path.
4. Spot-check room switch and jam join/leave flows.

---

## Incident triage (quick flow)

1. **Classify**
   - Server/API failure
   - Client state regression
   - Media transport issue
2. **Scope**
   - One user vs everyone
   - One room vs all rooms
3. **Gather evidence**
   - timestamps
   - user action sequence
   - relevant logs/console output
4. **Contain**
   - rollback or restart affected component
5. **Document**
   - open/update issue with repro steps and impact

---

## Logs and diagnostics

Capture enough to reproduce, not just enough to speculate.

Recommended minimum in issue reports:
- environment (desktop/browser, OS, app version)
- exact actions performed
- expected vs actual behavior
- timestamps + relevant logs

---

## Change management

- No direct pushes to `main`/`master`.
- PRs only.
- Verification checks must pass before merge.
- Prefer small, focused PRs after foundation lands.
