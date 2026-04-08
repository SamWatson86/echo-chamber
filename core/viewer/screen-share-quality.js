/* =========================================================
   SCREEN SHARE — FPS quality warning banner
   Shows a banner when capture FPS drops below threshold.
   ========================================================= */

function _onCaptureStats(stats) {
  if (_qualityWarnDismissed) return;
  if (localStorage.getItem('echo-no-quality-warn') === '1') return;

  var fps = stats && stats.fps;
  if (typeof fps !== 'number') return;

  if (fps < QUALITY_WARN_FPS_THRESHOLD && fps > 0) {
    if (_qualityWarnLowSince === 0) _qualityWarnLowSince = Date.now();
    if (!_qualityWarnShowing && (Date.now() - _qualityWarnLowSince) >= QUALITY_WARN_DURATION_MS) {
      _showQualityWarning(fps);
    }
  } else {
    _qualityWarnLowSince = 0;
    if (_qualityWarnShowing) _hideQualityWarning();
  }
}

function _showQualityWarning(fps) {
  if (_qualityWarnBannerEl) return;
  _qualityWarnShowing = true;

  var banner = document.createElement('div');
  banner.id = 'quality-warn-banner';
  banner.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;' +
    'background:rgba(30,30,30,0.95);color:#fbbf24;padding:8px 16px;border-radius:8px;' +
    'font-size:13px;display:flex;align-items:center;gap:10px;box-shadow:0 2px 12px rgba(0,0,0,0.5);' +
    'border:1px solid rgba(251,191,36,0.3);backdrop-filter:blur(8px);max-width:90vw;';

  var text = document.createElement('span');
  text.textContent = 'Stream FPS is low (' + fps + ' fps) — GPU may be contended';

  var dismissBtn = document.createElement('button');
  dismissBtn.textContent = '\u00d7';
  dismissBtn.title = 'Dismiss';
  dismissBtn.style.cssText = 'background:none;border:none;color:#fbbf24;font-size:18px;cursor:pointer;padding:0 2px;line-height:1;';
  dismissBtn.onclick = function() { _hideQualityWarning(); _qualityWarnDismissed = true; };

  var muteBtn = document.createElement('button');
  muteBtn.textContent = "Don't show again";
  muteBtn.style.cssText = 'background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.3);' +
    'color:#fbbf24;font-size:11px;cursor:pointer;padding:2px 8px;border-radius:4px;white-space:nowrap;';
  muteBtn.onclick = function() {
    localStorage.setItem('echo-no-quality-warn', '1');
    _hideQualityWarning();
    _qualityWarnDismissed = true;
  };

  banner.appendChild(text);
  banner.appendChild(muteBtn);
  banner.appendChild(dismissBtn);
  document.body.appendChild(banner);
  _qualityWarnBannerEl = banner;
}

function _hideQualityWarning() {
  _qualityWarnShowing = false;
  if (_qualityWarnBannerEl) {
    _qualityWarnBannerEl.remove();
    _qualityWarnBannerEl = null;
  }
}

function _startQualityWarnListener() {
  _stopQualityWarnListener();
  _qualityWarnLowSince = 0;
  _qualityWarnDismissed = false;

  if (typeof tauriListen !== 'function') return;

  // Listen to all capture stats events
  var events = ['screen-capture-stats', 'desktop-capture-stats'];
  var unlisteners = [];
  events.forEach(function(evt) {
    tauriListen(evt, function(event) {
      _onCaptureStats(event && event.payload);
    }).then(function(unlisten) {
      unlisteners.push(unlisten);
    }).catch(function() {});
  });
  _qualityWarnUnlisten = function() {
    unlisteners.forEach(function(fn) { try { fn(); } catch(e) {} });
    unlisteners.length = 0;
  };
}

function _stopQualityWarnListener() {
  if (_qualityWarnUnlisten) { _qualityWarnUnlisten(); _qualityWarnUnlisten = null; }
  _hideQualityWarning();
  _qualityWarnLowSince = 0;
}
