# Screen Audio Isolation

## ELI5

**What broke:** A shared game could include Echo's speaker output, sending other
people's voices back into the room. Battlefield 6 also depended on its window
title because the native picker discarded executable metadata it had already
looked up.

**Why it broke:** Browser capture published unrestricted display audio, and the
native source contract stopped at the process ID instead of carrying the
executable name into the routing decision.

**What changed:** Browser and compatibility-fallback shares are video-only.
The Windows app now carries an optional executable name through the picker, so
Battlefield 6 uses the existing system-audio route that excludes Echo. Native
audio publications also have fixed route names for safe diagnostics.

**How we know it works:** Regression tests prove browsers never publish display
audio, unexpected browser audio tracks are stopped, real picker-shaped BF6
metadata selects the Echo-excluding route, old clients retain the exact-title
fallback, and ultrawide capture geometry is unchanged.

**Does this need a desktop update:** Yes for executable-aware native routing.
The browser video-only safety behavior is delivered by the server-served viewer.

**What could still go wrong:** A Windows-native capture route could still fail
on a specific machine or game. That must be demonstrated with the two-PC spoken
sentinel before changing WASAPI or adding another capture architecture.
