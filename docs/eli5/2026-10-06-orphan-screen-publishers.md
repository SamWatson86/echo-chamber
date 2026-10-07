# Screen sharing after room disconnect

ELI5:

**What broke:** Zane left the room, but other users could still watch his moving
screen. The SFU recorded his main connection leaving at 23:06:30 EDT on October 6,
2026; his separate native screen publisher remained until an operator removed it
at 23:09:34 EDT.

**Why it broke:** A screen publisher is a second connection. The earlier privacy
fix corrected End Sharing, but room disconnect did not call that stop routine.
The native publisher also ignored its own terminal disconnection, and the server
did not reconcile orphaned screen connections.

**What changed:** Explicit and unexpected viewer disconnects stop/cancel sharing.
Native publishing disconnect and app exit cancel capture. A server guard checks
actual SFU membership and removes screen publishers left behind by their owner.

**How we know it works:** Regression tests exercise real viewer disconnect handlers,
native terminal-event handling, and an HTTP SFU test double covering orphan
removal, fresh-roster rechecks, replacement sessions, errors, and retries. Incident
containment was independently checked against the live SFU roster. Automated
tests do not replace an end-to-end two-device screen-sharing check of the release.

**Does this need a desktop update:** Yes, Windows 0.6.39 supplies native disconnect
and exit protection. The server and server-served viewer must also be deployed.

**What could still go wrong:** Server reconciliation depends on a reachable SFU
and cannot guarantee immediate removal during an outage. LiveKit removes by
identity, so its API has a final roster-check/removal race; a poller also cannot
reconstruct parent ownership history from before it started. Native shutdown
errors remain visible and retryable instead of reporting that capture stopped.
