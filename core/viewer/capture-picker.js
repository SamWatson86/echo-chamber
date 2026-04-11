// ── Capture Source Picker ──
// Custom modal for selecting screen share sources (monitors, games, windows).
// Uses Tauri IPC to enumerate sources and generate thumbnails.

var _capturePickerResolve = null;
var _capturePickerReject = null;
var _selectedSource = null;
var _capturePickerSupport = null;

/**
 * Show the capture source picker modal.
 * Returns a Promise that resolves with the selected source or null if cancelled.
 * @returns {Promise<{id: number, title: string, sourceType: string, isMonitor: boolean} | null>}
 */
function showCapturePicker() {
    return new Promise(function(resolve, reject) {
        _capturePickerResolve = resolve;
        _capturePickerReject = reject;
        _selectedSource = null;
        _buildPickerModal();
    });
}

function _buildPickerModal() {
    // Remove existing picker if any
    var existing = document.getElementById('capture-picker-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'capture-picker-overlay';
    overlay.className = 'capture-picker-overlay';
    overlay.innerHTML =
        '<div class="capture-picker">' +
            '<div class="capture-picker-header">' +
                '<h3>Share Your Screen</h3>' +
                '<button class="capture-picker-close" id="cp-close">&times;</button>' +
            '</div>' +
            '<div class="capture-picker-body" id="cp-body">' +
                '<div style="text-align:center;padding:40px;color:rgba(255,255,255,0.5)">Loading sources...</div>' +
            '</div>' +
            '<div class="capture-picker-footer">' +
                '<button class="capture-picker-btn secondary" id="cp-cancel">Cancel</button>' +
                '<button class="capture-picker-btn primary" id="cp-share" disabled>Share</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(function() {
        overlay.classList.add('visible');
    });

    // Bind close/cancel
    document.getElementById('cp-close').onclick = _cancelPicker;
    document.getElementById('cp-cancel').onclick = _cancelPicker;
    document.getElementById('cp-share').onclick = _confirmPicker;

    // Close on overlay click (not modal body)
    overlay.onclick = function(e) {
        if (e.target === overlay) _cancelPicker();
    };

    // Close on Escape
    document.addEventListener('keydown', _pickerKeyHandler);

    // Load sources
    _loadSources();
}

function _pickerKeyHandler(e) {
    if (e.key === 'Escape') _cancelPicker();
}

function _cancelPicker() {
    _closePicker();
    if (_capturePickerResolve) {
        _capturePickerResolve(null);
        _capturePickerResolve = null;
    }
}

function _confirmPicker() {
    if (!_selectedSource) return;
    _closePicker();
    if (_capturePickerResolve) {
        _capturePickerResolve(_selectedSource);
        _capturePickerResolve = null;
    }
}

function _closePicker() {
    document.removeEventListener('keydown', _pickerKeyHandler);
    var overlay = document.getElementById('capture-picker-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
        setTimeout(function() { overlay.remove(); }, 200);
    }
}

async function _loadSources() {
    var body = document.getElementById('cp-body');
    if (!body) return;

    try {
        if (!_capturePickerSupport) {
            _capturePickerSupport = await _detectCaptureSupport();
        }
        var sources = await tauriInvoke('list_screen_sources');
        if (!sources || sources.length === 0) {
            body.innerHTML = '<div class="capture-source-empty">No capture sources found</div>';
            return;
        }

        // Categorize
        var monitors = sources.filter(function(s) { return s.source_type === 'monitor'; });
        var games = sources.filter(function(s) { return s.source_type === 'game'; });
        var windows = sources.filter(function(s) { return s.source_type === 'window'; });
        var unsupportedWindows = [];
        if (!_capturePickerSupport.windowCaptureSupported) {
            unsupportedWindows = windows;
            windows = [];
        }

        var html = '';

        if (monitors.length > 0) {
            html += _renderSection('Screens', null, monitors);
        }
        if (games.length > 0) {
            html += _renderSection('Games', 'Hook Capture', games);
        }
        if (windows.length > 0) {
            html += _renderSection('Windows', null, windows);
        }
        if (unsupportedWindows.length > 0) {
            html += _renderSection('Windows', 'Requires Win11 24H2+', unsupportedWindows, true);
        }

        body.innerHTML = html;

        // Bind click handlers
        body.querySelectorAll('.capture-source-card').forEach(function(card) {
            if (card.dataset.unsupported === '1') {
                card.onclick = function() {
                    showToast('Window capture on this PC requires Windows 11 24H2+. Use a Screen or Game source instead.', 6000);
                };
                return;
            }
            card.onclick = function() {
                body.querySelectorAll('.capture-source-card').forEach(function(c) {
                    c.classList.remove('selected');
                });
                card.classList.add('selected');
                _selectedSource = {
                    id: parseInt(card.dataset.id),
                    title: card.dataset.title,
                    sourceType: card.dataset.type,
                    isMonitor: card.dataset.type === 'monitor',
                    pid: parseInt(card.dataset.pid) || 0,
                };
                document.getElementById('cp-share').disabled = false;
            };
            // Double-click = select + share immediately
            card.ondblclick = function() {
                card.onclick();
                _confirmPicker();
            };
        });

        // Load thumbnails async
        _loadThumbnails(sources);

    } catch (err) {
        body.innerHTML = '<div class="capture-source-empty">Error loading sources: ' +
            (err.message || err) + '</div>';
    }
}

async function _detectCaptureSupport() {
    var support = {
        osBuild: null,
        windowCaptureSupported: true,
    };
    if (!window.__ECHO_NATIVE__ || typeof tauriInvoke !== 'function') {
        return support;
    }
    try {
        var osBuild = await tauriInvoke('get_os_build_number');
        support.osBuild = osBuild;
        support.windowCaptureSupported = osBuild >= 26100;
    } catch (err) {
        // Older binaries may not expose build detection yet. Leave the picker permissive
        // and let the start path produce the fallback/error instead.
    }
    return support;
}

function _renderSection(title, badge, sources, disabled) {
    var badgeHtml = badge ? ' <span class="badge">' + badge + '</span>' : '';
    var html = '<div class="capture-picker-section">' +
        '<div class="capture-picker-section-title">' + title + badgeHtml + '</div>' +
        '<div class="capture-picker-grid">';

    for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        html += '<div class="capture-source-card' + (disabled ? ' disabled' : '') + '" data-id="' + s.id +
            '" data-title="' + _escHtml(s.title) +
            '" data-type="' + s.source_type +
            '" data-pid="' + (s.pid || 0) +
            '" data-unsupported="' + (disabled ? '1' : '0') + '">' +
            '<div class="capture-source-thumb" id="thumb-container-' + s.id + '">' +
                '<div class="shimmer" id="thumb-' + s.id + '"></div>' +
            '</div>' +
            '<div class="capture-source-name" title="' + _escHtml(s.title) + '">' +
                _escHtml(s.title) + '</div>' +
        '</div>';
    }

    html += '</div></div>';
    return html;
}

async function _loadThumbnails(sources) {
    // Load thumbnails in parallel (max 4 concurrent)
    var queue = sources.slice();
    var active = 0;
    var maxConcurrent = 4;

    function processNext() {
        while (active < maxConcurrent && queue.length > 0) {
            var source = queue.shift();
            active++;
            _loadSingleThumbnail(source).finally(function() {
                active--;
                processNext();
            });
        }
    }

    processNext();
}

async function _loadSingleThumbnail(source) {
    try {
        var dataUri = await tauriInvoke('get_source_thumbnail', {
            sourceId: source.id,
            isMonitor: source.is_monitor,
        });
        var container = document.getElementById('thumb-container-' + source.id);
        if (container && dataUri) {
            container.innerHTML = '<img src="' + dataUri + '" alt="' + _escHtml(source.title) + '">';
        } else if (container) {
            _showThumbFallback(container, source);
        }
    } catch (e) {
        var container = document.getElementById('thumb-container-' + source.id);
        if (container) _showThumbFallback(container, source);
    }
}

function _showThumbFallback(container, source) {
    var icon = source.source_type === 'game' ? '\u{1F3AE}' :
               source.source_type === 'monitor' ? '\u{1F5B5}' : '\u{1FA9F}';
    container.innerHTML = '<div class="capture-thumb-fallback">' +
        '<span class="capture-thumb-icon">' + icon + '</span>' +
        '</div>';
}

function _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
