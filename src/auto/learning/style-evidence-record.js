// Style-scoped evidence store: the durable storage layer for TD-confirmed
// POM lines and anchors a project can reuse next time the same style is
// detected. Source part for app.js. Run `npm run build` after editing.
//
// Separate from bra.learning.v1 (residual buckets) and bra.pomMeanings.v1
// (POM→meaning catalog) on purpose: residuals are statistical, meanings
// are categorical, evidence is concrete (this exact line was right). They
// evolve at different rates and need to stay independently resettable.
//
// Coordinates in stored records are normalized to the source image's
// displayed bbox (same scheme as anchors / manual learn residuals), so
// evidence survives zoom, pan, and image resizing.
//
// This file is schema + CRUD only. Save-time candidate scanning of the
// live project lives in the sibling src/auto/learning/style-evidence-capture.js;
// generate-time reuse of stored evidence to bias/veto fresh drafts lives in
// src/auto/learning/style-evidence-reuse.js. Both load after this file.

  const STYLE_EVIDENCE_KEY = 'bra.styleEvidence.v1';
  const STYLE_EVIDENCE_VERSION = 1;
  // Hard ceiling so a noisy style can't grow unboundedly. The newest
  // records win on overflow — TDs trust their most recent confirmation
  // more than something from six months ago.
  const STYLE_EVIDENCE_MAX_PER_STYLE = 200;

  function emptyStyleEvidenceStore() {
    return { version: STYLE_EVIDENCE_VERSION, styles: {} };
  }

  function emptyStyleEvidenceBucket() {
    return { evidence: [], updatedAt: null };
  }

  // Strict normalization. Drops anything that isn't a plausible record
  // (no id, no POM for absence, no line geometry for confirmed-line
  // evidence) so a corrupted localStorage payload can't crash the panel
  // or detection. Older keys without a version stamp are still accepted
  // — we treat anything in the right shape as v1.
  function normalizeStyleEvidenceStore(parsed) {
    if (!parsed || typeof parsed !== 'object') return emptyStyleEvidenceStore();
    const stylesIn = (parsed.styles && typeof parsed.styles === 'object') ? parsed.styles : {};
    const stylesOut = {};
    for (const styleId of Object.keys(stylesIn)) {
      const bucket = stylesIn[styleId] || {};
      const evidenceIn = Array.isArray(bucket.evidence) ? bucket.evidence : [];
      const evidenceOut = [];
      for (const rec of evidenceIn) {
        const norm = normalizeEvidenceRecord(rec, styleId);
        if (norm) evidenceOut.push(norm);
      }
      stylesOut[styleId] = {
        evidence: evidenceOut,
        updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : null,
      };
    }
    return { version: STYLE_EVIDENCE_VERSION, styles: stylesOut };
  }

  function normalizeEvidenceRecord(rec, fallbackStyleId) {
    if (!rec || typeof rec !== 'object') return null;
    if (!rec.id) return null;
    const absent = rec.tdStatus === 'absent-confirmed' || rec.source === 'td-deleted-auto-line';
    const line = normalizeEvidenceLine(rec.line);
    const rejectedLine = normalizeEvidenceLine(rec.rejectedLine);
    if (!absent && !line) return null;
    if (absent && rec.pom == null) return null;
    return {
      id: String(rec.id),
      styleId: String(rec.styleId || fallbackStyleId || ''),
      annotationId: rec.annotationId != null ? rec.annotationId : null,
      sourceImageId: rec.sourceImageId || null,
      imageFingerprint: rec.imageFingerprint || null,
      savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : null,
      appRuleVersion: rec.appRuleVersion || null,
      templateVersion: rec.templateVersion || null,
      source: rec.source || null,
      tdStatus: rec.tdStatus || null,
      pom: rec.pom != null ? String(rec.pom) : null,
      meaningId: rec.meaningId || null,
      meaningLabel: rec.meaningLabel || null,
      viewRole: rec.viewRole || null,
      line: line || null,
      rejectedLine: rejectedLine || null,
      absentReason: rec.absentReason || null,
      anchors: rec.anchors && typeof rec.anchors === 'object' ? rec.anchors : null,
      quality: rec.quality && typeof rec.quality === 'object' ? rec.quality : null,
    };
  }

  function normalizeEvidencePoint(pt) {
    if (!pt || typeof pt !== 'object') return null;
    const x = Number(pt.x);
    const y = Number(pt.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function normalizeEvidenceLine(line) {
    if (!line || typeof line !== 'object') return null;
    const start = normalizeEvidencePoint(line.start);
    const end = normalizeEvidencePoint(line.end);
    if (!start || !end) return null;
    const out = {
      type: line.type === 'curved' ? 'curved' : 'straight',
      start,
      end,
    };
    const c1 = normalizeEvidencePoint(line.control1);
    const c2 = normalizeEvidencePoint(line.control2);
    if (c1) out.control1 = c1;
    if (c2) out.control2 = c2;
    const mp = normalizeEvidencePoint(line.midPoint);
    if (mp) out.midPoint = mp;
    const mhi = normalizeEvidencePoint(line.midHandleIn);
    const mho = normalizeEvidencePoint(line.midHandleOut);
    if (mhi) out.midHandleIn = mhi;
    if (mho) out.midHandleOut = mho;
    return out;
  }

  let styleEvidenceStore = (function loadStyleEvidenceStore() {
    try {
      const raw = localStorage.getItem(STYLE_EVIDENCE_KEY);
      if (!raw) return emptyStyleEvidenceStore();
      return normalizeStyleEvidenceStore(JSON.parse(raw));
    } catch (_) {
      return emptyStyleEvidenceStore();
    }
  })();

  function saveStyleEvidenceStore() {
    try { localStorage.setItem(STYLE_EVIDENCE_KEY, JSON.stringify(styleEvidenceStore)); }
    catch (_) { /* quota — silently drop, evidence is non-critical */ }
  }

  function getStyleEvidenceBucket(styleId, createIfMissing) {
    if (!styleId) return null;
    let bucket = styleEvidenceStore.styles[styleId];
    if (!bucket && createIfMissing) {
      bucket = emptyStyleEvidenceBucket();
      styleEvidenceStore.styles[styleId] = bucket;
    }
    return bucket || null;
  }

  function listStyleEvidence(styleId) {
    const bucket = getStyleEvidenceBucket(styleId, false);
    if (!bucket) return [];
    // Return a stable, newest-first ordering. Older records are kept but
    // pushed to the bottom of the panel so the most recent TD confirmation
    // is always closest to the eye.
    return bucket.evidence.slice().sort((a, b) => {
      const ta = a.savedAt ? Date.parse(a.savedAt) : 0;
      const tb = b.savedAt ? Date.parse(b.savedAt) : 0;
      return tb - ta;
    });
  }

  function listKnownEvidenceStyleIds() {
    return Object.keys(styleEvidenceStore.styles);
  }

  // Roll-up the panel will render. Groups records by POM so the TD can see
  // at a glance which measurements have prior evidence and which don't.
  // Falls back to a `(no POM)` bucket for records that lost their POM
  // number — shouldn't happen in practice but the panel must not crash.
  function summarizeStyleEvidence(styleId) {
    const records = listStyleEvidence(styleId);
    const byPom = new Map();
    let confirmedCount = 0;
    let absentCount = 0;
    let pendingCount = 0;
    let lastUpdated = null;
    for (const rec of records) {
      const pomKey = rec.pom != null ? String(rec.pom) : '?';
      let row = byPom.get(pomKey);
      if (!row) {
        row = {
          pom: pomKey,
          meaningLabel: null,
          meaningId: rec.meaningId || null,
          viewRole: rec.viewRole || null,
          source: rec.source || null,
          status: rec.tdStatus || null,
          count: 0,
          absentCount: 0,
          lastSavedAt: null,
        };
        byPom.set(pomKey, row);
      }
      row.count += 1;
      if (rec.tdStatus === 'absent-confirmed') row.absentCount += 1;
      if (rec.meaningId && !row.meaningId) row.meaningId = rec.meaningId;
      if (rec.meaningLabel && !row.meaningLabel) row.meaningLabel = rec.meaningLabel;
      if (!row.viewRole && rec.viewRole) row.viewRole = rec.viewRole;
      if (!row.source && rec.source) row.source = rec.source;
      // Status precedence: confirmed beats pending beats null. Even one
      // unconfirmed record shouldn't downgrade a POM that already has a
      // confirmed entry.
      if (rec.tdStatus === 'confirmed') row.status = 'confirmed';
      else if (rec.tdStatus === 'absent-confirmed' && row.status !== 'confirmed') row.status = 'absent-confirmed';
      else if (rec.tdStatus && row.status !== 'confirmed') row.status = rec.tdStatus;
      if (rec.tdStatus === 'confirmed') confirmedCount += 1;
      else if (rec.tdStatus === 'absent-confirmed') { confirmedCount += 1; absentCount += 1; }
      else pendingCount += 1;
      if (rec.savedAt) {
        const ts = Date.parse(rec.savedAt);
        if (!row.lastSavedAt || ts > Date.parse(row.lastSavedAt)) row.lastSavedAt = rec.savedAt;
        if (!lastUpdated || ts > Date.parse(lastUpdated)) lastUpdated = rec.savedAt;
      }
    }

    // Hydrate meaning labels from the meaning catalog when possible. The
    // catalog is loaded by meaning-store.js earlier in the bundle, so the
    // helper is in scope here.
    const rows = [];
    for (const row of byPom.values()) {
      if (row.meaningId && typeof getCatalogEntry === 'function') {
        const entry = getCatalogEntry(row.meaningId);
        if (entry) row.meaningLabel = entry.label;
      }
      rows.push(row);
    }
    rows.sort((a, b) => {
      const na = Number(a.pom);
      const nb = Number(b.pom);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a.pom) < String(b.pom) ? -1 : 1;
    });

    return {
      styleId,
      totalRecords: records.length,
      confirmedCount,
      absentCount,
      pendingCount,
      pomRowCount: rows.length,
      lastUpdated,
      rows,
    };
  }

  // Adds (or updates) one evidence record. Records are keyed by id — if
  // the caller re-saves the same id (same POM on the same image after
  // another TD edit), we replace the prior entry instead of stacking
  // duplicates. Records without an id or line geometry are rejected so
  // the store stays normalized.
  function addStyleEvidence(styleId, record) {
    if (!styleId) return null;
    const normalized = normalizeEvidenceRecord(record, styleId);
    if (!normalized) return null;
    if (!normalized.savedAt) normalized.savedAt = new Date().toISOString();
    normalized.styleId = styleId;
    const bucket = getStyleEvidenceBucket(styleId, true);
    const existingIndex = bucket.evidence.findIndex(e => e.id === normalized.id);
    if (existingIndex >= 0) bucket.evidence[existingIndex] = normalized;
    else bucket.evidence.push(normalized);
    if (bucket.evidence.length > STYLE_EVIDENCE_MAX_PER_STYLE) {
      bucket.evidence.sort((a, b) => {
        const ta = a.savedAt ? Date.parse(a.savedAt) : 0;
        const tb = b.savedAt ? Date.parse(b.savedAt) : 0;
        return tb - ta;
      });
      bucket.evidence.length = STYLE_EVIDENCE_MAX_PER_STYLE;
    }
    bucket.updatedAt = new Date().toISOString();
    saveStyleEvidenceStore();
    return normalized;
  }

  function forgetStyleEvidence(styleId, evidenceId) {
    const bucket = getStyleEvidenceBucket(styleId, false);
    if (!bucket) return false;
    const before = bucket.evidence.length;
    bucket.evidence = bucket.evidence.filter(e => e.id !== evidenceId);
    if (bucket.evidence.length === before) return false;
    bucket.updatedAt = new Date().toISOString();
    saveStyleEvidenceStore();
    return true;
  }

  // Wipe evidence for one style, or every style. Kept separate from the
  // residual / meaning resets so a TD can prune evidence without losing
  // the calibration medians or POM-meaning catalog.
  function clearStyleEvidence(scope, styleId) {
    if (scope === 'all') {
      styleEvidenceStore = emptyStyleEvidenceStore();
    } else if (styleId && styleEvidenceStore.styles[styleId]) {
      delete styleEvidenceStore.styles[styleId];
    } else {
      return false;
    }
    saveStyleEvidenceStore();
    return true;
  }
