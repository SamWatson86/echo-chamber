import { useMemo } from 'react';

/**
 * Parity mode:
 * - Render the legacy viewer 1:1 inside a same-origin iframe.
 * - This preserves existing UX/behavior while we incrementally migrate internals
 *   to React + TS behind the scenes.
 */
export function App() {
  const legacySrc = useMemo(() => {
    const search = window.location.search || '';
    const hash = window.location.hash || '';
    return `/legacy/index.html${search}${hash}`;
  }, []);

  return (
    <div className="parity-shell">
      <iframe
        title="Echo Chamber Viewer"
        src={legacySrc}
        className="parity-frame"
        allow="microphone; camera; display-capture; clipboard-read; clipboard-write; autoplay; fullscreen"
      />
    </div>
  );
}
