// Detect-to-POM session telemetry. Stores the active event stream in
// sessionStorage and completed sessions in localStorage["auto_telemetry_log"].
// Source part for app.js. Run `npm run build` after editing.

  const AUTO_TELEMETRY_LOG_KEY = 'auto_telemetry_log';
  const AUTO_TELEMETRY_SESSION_KEY = 'auto_telemetry_current';
  const AUTO_TELEMETRY_CAP = 200;

  function recordAutoTelemetryEvent(event, details = {}) {
    if (!event) return null;
    const timestamp = Date.now();
    const entry = makeAutoTelemetryEvent(event, details, timestamp);
    let session = readCurrentAutoTelemetrySession();

    if (!session && event !== 'image_loaded') return null;

    if (event === 'image_loaded') {
      session = {
        id: makeAutoTelemetrySessionId(timestamp),
        sketch_id: entry.sketch_id || null,
        started_at: new Date(timestamp).toISOString(),
        completed_at: null,
        events: [],
      };
    }

    if (!session.sketch_id && entry.sketch_id) session.sketch_id = entry.sketch_id;
    session.events.push(entry);

    if (event === 'auto_session_done') {
      session.completed_at = new Date(timestamp).toISOString();
      session.summary = summarizeAutoTelemetryEvents(session.events);
      appendAutoTelemetrySession(session);
      clearCurrentAutoTelemetrySession();
    } else {
      writeCurrentAutoTelemetrySession(session);
    }
    return entry;
  }

  function makeAutoTelemetryEvent(event, details, timestamp) {
    const sourceImage = details && details.sourceImageId != null
      ? getImageById(details.sourceImageId)
      : (typeof pickAutoSourceImage === 'function' ? pickAutoSourceImage() : null);
    const styleId = (typeof currentStyleId === 'function') ? currentStyleId() : (state.styleId || '');
    const entry = {
      event: String(event),
      timestamp,
      at: new Date(timestamp).toISOString(),
      sketch_id: details.sketch_id || details.sourceImageId || (sourceImage && sourceImage.id) || null,
      style_id: styleId || '',
    };

    const copyFields = [
      'anchor_id', 'anchor_kind', 'pom_id', 'draft_id', 'run_id',
      'count', 'duration_ms', 'status', 'reason', 'image_width',
      'image_height', 'draft_count', 'approved_count',
    ];
    for (const key of copyFields) {
      if (details && details[key] != null) entry[key] = details[key];
    }
    return entry;
  }

  function readCurrentAutoTelemetrySession() {
    try {
      const raw = sessionStorage.getItem(AUTO_TELEMETRY_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeCurrentAutoTelemetrySession(session) {
    try {
      sessionStorage.setItem(AUTO_TELEMETRY_SESSION_KEY, JSON.stringify(session));
    } catch (_) {
      // Telemetry is diagnostic only; quota/private-mode failures should not
      // affect drawing or detection.
    }
  }

  function clearCurrentAutoTelemetrySession() {
    try { sessionStorage.removeItem(AUTO_TELEMETRY_SESSION_KEY); } catch (_) { /* ignore */ }
  }

  function appendAutoTelemetrySession(session) {
    const log = getAutoTelemetryLog();
    log.push(session);
    const trimmed = log.slice(-AUTO_TELEMETRY_CAP);
    try {
      localStorage.setItem(AUTO_TELEMETRY_LOG_KEY, JSON.stringify(trimmed));
    } catch (_) {
      // Keep the UI fast even if localStorage is full.
    }
  }

  function getAutoTelemetryLog() {
    try {
      const raw = localStorage.getItem(AUTO_TELEMETRY_LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function clearAutoTelemetryLog() {
    try { localStorage.removeItem(AUTO_TELEMETRY_LOG_KEY); } catch (_) { /* ignore */ }
    clearCurrentAutoTelemetrySession();
  }

  function getAutoTelemetryReport(limit = 10) {
    const log = getAutoTelemetryLog();
    const latest = log.slice().reverse().slice(0, limit);
    return summarizeAutoTelemetrySessions(latest);
  }

  function makeAutoTelemetrySessionId(timestamp) {
    return 'auto-session-' + timestamp.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
