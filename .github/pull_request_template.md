## Summary
- What changed?
- Why now?
- Linked issue: #

## User-facing impact
- [ ] User-visible behavior changed
- [ ] No user-visible behavior change

## Repro + validation evidence
### Before (bug repro)
1.
2.
3.

### After (fix verification)
1.
2.
3.

### Evidence (required)
- [ ] Logs attached
- [ ] Video/GIF/screenshots attached
- [ ] Manual verification notes attached

## Regression checklist (media/session)
- [ ] Room switch works without UI/state desync
- [ ] Screen-share stop/start retains expected audio behavior
- [ ] Jam join/leave/listen state remains consistent on failures
- [ ] Mic/camera/share indicators match actual publish state
- [ ] Disconnect/reconnect leaves no stale listeners/timers

## Verification commands run
- [ ] `bash tools/verify/quick.sh`
- [ ] `bash tools/verify/extended.sh` (when needed)

## Risk
- [ ] Low
- [ ] Medium
- [ ] High (explain)

## Rollback plan
- How to back this out quickly if regression appears?
