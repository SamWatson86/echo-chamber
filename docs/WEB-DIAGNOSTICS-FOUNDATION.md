# Web Diagnostics Foundation

Date: 2026-07-21
Branch: `codex/web-diagnostics-foundation`
Release impact: control-plane binary only; no viewer or Windows desktop binary change

## Boundary

This branch establishes the private server boundary needed before a browser or
Mac canary may upload automatic diagnostics. It does not enable collection in
the viewer, add an Admin Diagnostics UI, deploy the control plane, or alter the
normal Windows release pipeline. The existing client-stats route keeps its
current authentication and behavior.

The existing `/v1/auth/login` token is intentionally not accepted for reading
diagnostics. That token is issued to ordinary room-password users and therefore
is not owner-private. Diagnostics use the independent, disabled-by-default
`CORE_DIAGNOSTICS_OWNER_SECRET` and a one-hour JWT with a dedicated issuer,
audience, subject, and scope. There is no legacy-admin fallback.

## Ingestion guarantees

- `POST /api/diagnostics/v1/envelopes` accepts at most 256 KiB.
- The bearer must identify the current installation binding in the current room
  and must have completed a successful heartbeat within the last 20 seconds.
- Identity, display name, room, and binding are derived from server state.
- The envelope is versioned, denies unknown fields, allowlists event/detail
  types, and bounds timestamps, strings, arrays, nesting, and total nodes.
- Server ingestion redacts credentials, JWTs, URL queries, email/IP addresses,
  SDP/ICE candidate material, and absolute paths before persistence.
- Free-form event messages and client fingerprints are discarded; persistence
  keeps only closed event codes and allowlisted structured fields.
- Idempotency uses a store-local HMAC of the authenticated identity plus the
  lowercase client envelope UUID and survives control-plane restarts. The HMAC
  key never crosses an API boundary, and a non-empty store missing it fails
  closed.
- Per-IP, current-binding, installation, and global request windows bound abuse;
  per-binding and global in-flight limits bound concurrent work before storage.
- Storage is constrained by age and disk cap. Its path must be provably disjoint
  from every web-readable root, and served roots may not contain filesystem
  links/junctions that could escape that boundary. Startup refuses an existing
  store whose isolation cannot be proven.

## Private owner operations

The owner-only API supports bounded newest-first summaries, compound
timestamp-plus-incident-ID pagination, one redacted record, a stable redacted
JSON download, and atomic deletion by opaque server-generated incident ID. Raw
JSONL files are never served, and owner responses are marked `Cache-Control:
no-store`.

Removing the owner secret disables new collection and owner access. If a store
already exists, the control plane continues applying retention and disk-cap
pruning without reopening either API boundary.

## Follow-up boundary

A separate viewer PR should add explicit first-run consent, an on/off control,
bounded local queue, Send Now/Delete Queued Data, and allowlisted collection for
JavaScript errors, permission/media failures, and connection/reconnect events.
That PR should upload only after a successful heartbeat and must include tests
showing forbidden data never enters the queue. A later owner UI can consume the
private API without weakening this auth boundary.

No live service restart or deployment is authorized by this document.
