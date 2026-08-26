# Participant Session Renewal

## ELI5

**What broke:** Echo's room credential expired after four hours. The heartbeat
then treated an authentication error as proof that the server was restarting,
reloaded the page, and played a restart announcement even when the server never
restarted.

**Why it broke:** LiveKit can keep its transport credential healthy internally,
but Echo continued using the original participant token for heartbeat, Jam,
chat, and related APIs. Heartbeat also gave every 401/403 the wrong meaning.

**What changed:** Echo renews the participant token before expiry through the
existing authentication endpoints without replacing the connected LiveKit
Room. Refreshes are single-flight, fenced to the exact room generation, and
bounded after failure. Only an authenticated `stale: true` heartbeat may force
the viewer-update reload; session and network failures no longer claim a server
restart. The generated jazz and speech were removed.

**How we know it works:** Deterministic tests cover early refresh, concurrency,
admin reauthentication, bounded failures, room-switch/disconnect races,
superseded heartbeats, mobile resume, and truthful update/session messaging.
The full viewer and control quick verification also passes.

**Does this need a desktop update:** No. This is a server-served viewer change
and uses the existing control API.

**What could still go wrong:** A changed room password or unavailable control
server can prevent renewal. Echo keeps working media intact and asks the user to
reconnect; it does not enter an automatic reload or credential-request loop.
