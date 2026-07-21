// Style-scoped evidence store: TD-confirmed POM lines and anchors a
// project can reuse next time the same style is detected. Source part
// for app.js. Run `npm run build` after editing.
//
// Separate from bra.learning.v1 (residual buckets) and bra.pomMeanings.v1
// (POM→meaning catalog) on purpose: residuals are statistical, meanings
// are categorical, evidence is concrete (this exact line was right). They
// evolve at different rates and need to stay independently resettable.
//
// Coordinates in stored records are normalized to the source image's
// displayed bbox (same scheme as anchors / manual learn residuals), so
// evidence survives zoom, pan, and image resizing.

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

  // ---- Phase 2: evidence capture from TD-edited Auto lines ----------
  //
  // collectStyleEvidenceCandidates scans the current project annotations
  // and picks rows the save flow can offer to remember for next time:
  //
  //   - auto === true          (line came out of Auto Mode, not a sketch)
  //   - tdEdited === true      (the TD actually moved it after applying)
  //   - drawability !== REVIEW_ONLY
  //   - has start + end + a numeric POM (seq or label)
  //   - sourceImageId resolves to a currently loaded image
  //
  // Output is a list of normalized records the same shape addStyleEvidence
  // accepts. Nothing is written to storage here — the save dialog runs the
  // commit step after the TD confirms.

  function evidenceSourceForAnnotation(ann) {
    if (!ann) return null;
    if (ann.auto === true && ann.tdEdited === true) return 'td-edited-auto-line';
    // Manual confirmed POM line: the meaning popover (or the fixed POM
    // path for 1/3/5) has already stamped these fields after the TD
    // committed a meaning, so the line is durable enough to remember.
    if (ann.auto !== true && ann.learnSampleHash && ann.learnMeaningId) {
      return 'manual-confirmed-line';
    }
    return null;
  }

  function isEligibleEvidenceAnnotation(ann) {
    if (!ann) return false;
    if (ann.drawability === 'REVIEW_ONLY') return false;
    if (!ann.start || !ann.end) return false;
    if (!Number.isFinite(ann.start.x) || !Number.isFinite(ann.start.y)) return false;
    if (!Number.isFinite(ann.end.x) || !Number.isFinite(ann.end.y)) return false;
    if (!evidencePomFromAnnotation(ann)) return false;
    if (!evidenceSourceForAnnotation(ann)) return false;
    return true;
  }

  function evidencePomFromAnnotation(ann) {
    if (!ann) return null;
    // Manual confirmed lines are stamped with the POM number that drove
    // the meaning popover — prefer it over the label since the TD could
    // have appended explanatory text after committing.
    if (ann.learnSamplePom) return String(ann.learnSamplePom);
    if (Number.isFinite(ann.seq) && ann.seq > 0) return String(ann.seq);
    if (ann.text) {
      const parsed = (typeof parsePomNumberFromLabel === 'function')
        ? parsePomNumberFromLabel(ann.text)
        : null;
      if (parsed) return parsed;
    }
    return null;
  }

  function markDeletedAutoAnnotationForEvidence(ann) {
    if (!ann || ann.auto !== true) return false;
    const pom = evidencePomFromAnnotation(ann);
    if (!pom) return false;
    if (!state.deletedAutoAnnotations) state.deletedAutoAnnotations = [];
    const snapshot = clone(ann);
    snapshot.deletedAt = new Date().toISOString();
    snapshot.tdDeleted = true;
    const existingIndex = state.deletedAutoAnnotations.findIndex(row => row && row.id === snapshot.id);
    if (existingIndex >= 0) state.deletedAutoAnnotations[existingIndex] = snapshot;
    else state.deletedAutoAnnotations.push(snapshot);
    return true;
  }

  function findImageById(imageId) {
    if (!imageId || !state || !Array.isArray(state.images)) return null;
    return state.images.find(im => im && im.id === imageId) || null;
  }

  function worldPointToImageNormalized(point, image) {
    if (!point || !image || !image.width || !image.height) return null;
    const x = (Number(point.x) - image.x) / image.width;
    const y = (Number(point.y) - image.y) / image.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function normalizeLineForEvidence(ann, image) {
    const start = worldPointToImageNormalized(ann.start, image);
    const end = worldPointToImageNormalized(ann.end, image);
    if (!start || !end) return null;
    const out = {
      type: ann.type === 'curved' ? 'curved' : 'straight',
      start,
      end,
    };
    if (ann.type === 'curved') {
      const c1 = worldPointToImageNormalized(ann.control1, image);
      const c2 = worldPointToImageNormalized(ann.control2, image);
      if (c1) out.control1 = c1;
      if (c2) out.control2 = c2;
      const mp = worldPointToImageNormalized(ann.midPoint, image);
      if (mp) out.midPoint = mp;
    }
    return out;
  }

  // Stable id per (style, image, POM, source-kind) so re-saving the same
  // project after another edit replaces the previous evidence instead of
  // stacking near-duplicates. The annotation id alone is too volatile —
  // every Apply mints a fresh one, so a second Save would otherwise grow
  // the bucket unboundedly. Source-kind enters the id because a single
  // image can hold both a manual confirmed POM 9 and the auto-applied
  // POM 9 it was correcting — we want both, not a collision.
  function makeEvidenceId(styleId, ann, source, image) {
    const pom = evidencePomFromAnnotation(ann) || '?';
    const imageId = (ann.sourceImageId || (image && image.id) || '?');
    const kind = source === 'manual-confirmed-line'
      ? 'm'
      : (source === 'td-deleted-auto-line' ? 'x' : 'a');
    return 'ev_' + encodeURIComponent(styleId || '_')
      + '_' + encodeURIComponent(imageId) + '_pom-' + pom + '_' + kind;
  }

  function pickImageForEvidence(ann) {
    if (ann.sourceImageId) {
      const direct = findImageById(ann.sourceImageId);
      if (direct) return direct;
    }
    // Manual lines have no sourceImageId — fall back to the midpoint
    // bbox test the meaning store already uses for shadow detection.
    if (typeof pickImageForAnnotation === 'function') {
      return pickImageForAnnotation(ann) || null;
    }
    return null;
  }

  function buildEvidenceCandidate(styleId, ann) {
    const source = evidenceSourceForAnnotation(ann);
    if (!source) return null;
    const image = pickImageForEvidence(ann);
    if (!image) return null;
    const line = normalizeLineForEvidence(ann, image);
    if (!line) return null;
    const pom = evidencePomFromAnnotation(ann);
    // Manual lines record the meaning ID directly on the annotation. Auto
    // lines round-trip through the current style's meaning store. Either
    // way, hydrate a human-readable label from the catalog when possible.
    const meaningIdFromAnn = source === 'manual-confirmed-line' ? (ann.learnMeaningId || null) : null;
    const meaningFromCatalog = (typeof resolvePomMeaning === 'function') ? resolvePomMeaning(pom) : null;
    const meaningId = meaningIdFromAnn || (meaningFromCatalog ? meaningFromCatalog.id : null);
    const catalogEntry = (meaningId && typeof getCatalogEntry === 'function')
      ? getCatalogEntry(meaningId)
      : meaningFromCatalog;
    const ruleVersion = (typeof AUTO_RULE_VERSION === 'string') ? AUTO_RULE_VERSION : null;
    const templateVersion = (typeof AUTO_TEMPLATE_VERSION === 'string') ? AUTO_TEMPLATE_VERSION : null;
    return {
      id: makeEvidenceId(styleId, ann, source, image),
      styleId,
      annotationId: ann.id,
      sourceImageId: ann.sourceImageId || image.id || null,
      savedAt: null, // addStyleEvidence stamps on commit
      appRuleVersion: ruleVersion,
      templateVersion,
      source,
      tdStatus: 'confirmed',
      pom,
      meaningId,
      meaningLabel: catalogEntry ? catalogEntry.label : null,
      viewRole: ann.viewRole || null,
      line,
      quality: {
        sourceConfidence: ann.confidence || null,
        editedFromAuto: source === 'td-edited-auto-line',
        drawability: ann.drawability || null,
      },
    };
  }

  function isDeletedAutoAbsenceStillValid(ann) {
    if (!ann || ann.auto !== true) return false;
    const pom = evidencePomFromAnnotation(ann);
    if (!pom) return false;
    if (!state || !Array.isArray(state.annotations)) return true;
    // Undo, redraw, or manual correction of the same POM means this is not
    // absence evidence anymore. Keep the rule conservative: if any current
    // annotation carries the same POM, don't learn "missing".
    return !state.annotations.some(current => {
      if (!current) return false;
      if (current.id === ann.id) return true;
      return evidencePomFromAnnotation(current) === pom;
    });
  }

  function buildAbsenceEvidenceCandidate(styleId, ann) {
    if (!isDeletedAutoAbsenceStillValid(ann)) return null;
    const image = pickImageForEvidence(ann);
    if (!image) return null;
    const pom = evidencePomFromAnnotation(ann);
    const rejectedLine = normalizeLineForEvidence(ann, image);
    const meaningFromCatalog = (typeof resolvePomMeaning === 'function') ? resolvePomMeaning(pom) : null;
    const catalogEntry = meaningFromCatalog || null;
    const ruleVersion = (typeof AUTO_RULE_VERSION === 'string') ? AUTO_RULE_VERSION : null;
    const templateVersion = (typeof AUTO_TEMPLATE_VERSION === 'string') ? AUTO_TEMPLATE_VERSION : null;
    return {
      id: makeEvidenceId(styleId, ann, 'td-deleted-auto-line', image),
      styleId,
      annotationId: ann.id,
      sourceImageId: ann.sourceImageId || image.id || null,
      savedAt: null,
      appRuleVersion: ruleVersion,
      templateVersion,
      source: 'td-deleted-auto-line',
      tdStatus: 'absent-confirmed',
      pom,
      meaningId: catalogEntry ? catalogEntry.id : null,
      meaningLabel: catalogEntry ? catalogEntry.label : null,
      viewRole: ann.viewRole || null,
      line: null,
      rejectedLine,
      absentReason: 'TD deleted the Auto-applied POM line because this style does not use that measurement.',
      quality: {
        sourceConfidence: ann.confidence || null,
        deletedAutoLine: true,
        drawability: ann.drawability || null,
      },
    };
  }

  function collectStyleEvidenceCandidates(styleId) {
    const targetStyle = (styleId == null ? currentStyleId() : styleId);
    if (!state || !Array.isArray(state.annotations)) return [];
    const out = [];
    for (const ann of state.annotations) {
      if (!isEligibleEvidenceAnnotation(ann)) continue;
      const candidate = buildEvidenceCandidate(targetStyle, ann);
      if (candidate) out.push(candidate);
    }
    const deleted = Array.isArray(state.deletedAutoAnnotations) ? state.deletedAutoAnnotations : [];
    for (const ann of deleted) {
      const candidate = buildAbsenceEvidenceCandidate(targetStyle, ann);
      if (candidate) out.push(candidate);
    }
    return out;
  }

  // Commit a vetted list of candidates. Returns the count of records that
  // actually landed in the store; bad records (missing geometry) are
  // dropped silently because addStyleEvidence already validates them.
  function commitStyleEvidenceCandidates(styleId, candidates) {
    const targetStyle = (styleId == null ? currentStyleId() : styleId);
    if (!targetStyle) return 0;
    if (!Array.isArray(candidates) || candidates.length === 0) return 0;
    let written = 0;
    for (const candidate of candidates) {
      const stored = addStyleEvidence(targetStyle, candidate);
      if (stored) written += 1;
    }
    if (state && Array.isArray(state.deletedAutoAnnotations)) {
      const committedDeletedIds = new Set(candidates
        .filter(c => c && c.source === 'td-deleted-auto-line')
        .map(c => c.annotationId));
      if (committedDeletedIds.size) {
        state.deletedAutoAnnotations = state.deletedAutoAnnotations
          .filter(ann => !committedDeletedIds.has(ann && ann.id));
      }
    }
    return written;
  }

  function latestEvidenceByPom(styleId) {
    const out = new Map();
    for (const rec of listStyleEvidence(styleId)) {
      if (!rec || rec.pom == null) continue;
      const pom = String(rec.pom);
      if (!out.has(pom)) out.set(pom, rec);
    }
    return out;
  }

  function getAbsentEvidenceByPom(styleId) {
    const latest = latestEvidenceByPom(styleId || currentStyleId());
    const out = new Map();
    for (const [pom, rec] of latest.entries()) {
      if (rec && rec.tdStatus === 'absent-confirmed') out.set(pom, rec);
    }
    return out;
  }

  // ---- Phase 3: reuse confirmed evidence to pre-seed drafts ----------
  //
  // Absence evidence (above) wipes the draft when the style is known not to
  // measure a POM. The confirmed side does the symmetric job: when prior
  // TD edits keep landing in roughly the same spot for a POM on this style,
  // pull the freshly generated draft a fraction of the way toward the
  // median of those edits. This is a soft prior — geometry from the
  // current sketch still dominates so a different image doesn't snap to
  // the wrong place — but it shortens TD review when a style has settled.
  //
  // Three guardrails keep the prior honest:
  //   - aggregate across at most the N most-recent confirmed records,
  //   - reject when the evidence is more than a third of the image away
  //     from the current draft (almost certainly a different sketch type),
  //   - never overwrite an absence-flagged draft (REVIEW_ONLY survives).
  const STYLE_EVIDENCE_REUSE_BLEND = 0.4;        // 40% pull toward evidence
  const STYLE_EVIDENCE_REUSE_RECENT = 5;         // last N confirmations per POM
  const STYLE_EVIDENCE_REUSE_MAX_GAP = 0.30;     // reject if >30% of image away

  function getConfirmedEvidenceMediansByPom(styleId) {
    const records = listStyleEvidence(styleId == null ? currentStyleId() : styleId);
    const byPom = new Map();
    for (const rec of records) {
      if (!rec || rec.tdStatus !== 'confirmed' || rec.pom == null || !rec.line) continue;
      if (!rec.line.start || !rec.line.end) continue;
      const pom = String(rec.pom);
      let arr = byPom.get(pom);
      if (!arr) { arr = []; byPom.set(pom, arr); }
      arr.push(rec);
    }
    const out = new Map();
    for (const [pom, recs] of byPom.entries()) {
      // listStyleEvidence already returns newest-first; trim to the most
      // recent N so a stale 6-month-old confirmation can't outvote a
      // freshly-edited one when the TD has reworked the POM lately.
      const recent = recs.slice(0, STYLE_EVIDENCE_REUSE_RECENT);
      if (!recent.length) continue;
      const startXs = recent.map(r => Number(r.line.start.x) || 0);
      const startYs = recent.map(r => Number(r.line.start.y) || 0);
      const endXs   = recent.map(r => Number(r.line.end.x)   || 0);
      const endYs   = recent.map(r => Number(r.line.end.y)   || 0);
      const isCurved = recent.every(r => r.line && r.line.type === 'curved');
      out.set(pom, {
        pom,
        startNorm: { x: medianOf(startXs), y: medianOf(startYs) },
        endNorm:   { x: medianOf(endXs),   y: medianOf(endYs) },
        lineType: isCurved ? 'curved' : 'straight',
        sampleCount: recent.length,
        lastSavedAt: recent[0].savedAt,
        meaningId: recent[0].meaningId || null,
        latestRecordId: recent[0].id,
      });
    }
    return out;
  }

  function applyStyleConfirmedEvidenceToDrafts(drafts, sourceImage) {
    if (!Array.isArray(drafts) || !drafts.length) return 0;
    if (!sourceImage || !sourceImage.width || !sourceImage.height) return 0;
    const confirmedByPom = getConfirmedEvidenceMediansByPom(currentStyleId());
    if (!confirmedByPom.size) return 0;
    const maxGapPx = STYLE_EVIDENCE_REUSE_MAX_GAP
      * Math.max(sourceImage.width, sourceImage.height);
    let changed = 0;
    for (const draft of drafts) {
      if (!draft) continue;
      if (draft.drawability === 'REVIEW_ONLY') continue;
      // Absence evidence already cleared geometry above; don't undo it.
      if (draft.styleEvidenceStatus === 'absent-confirmed') continue;
      if (!draft.start || !draft.end) continue;
      const pom = draft.seq != null ? String(draft.seq) : null;
      const ev = pom ? confirmedByPom.get(pom) : null;
      if (!ev) continue;
      // Curved evidence on a straight draft (or vice versa) means the
      // template intent doesn't match — blending endpoints would warp
      // the line into a meaningless shape. Skip and let detection win.
      if ((draft.type === 'curved') !== (ev.lineType === 'curved')) continue;
      const evStart = {
        x: sourceImage.x + ev.startNorm.x * sourceImage.width,
        y: sourceImage.y + ev.startNorm.y * sourceImage.height,
      };
      const evEnd = {
        x: sourceImage.x + ev.endNorm.x * sourceImage.width,
        y: sourceImage.y + ev.endNorm.y * sourceImage.height,
      };
      // Pair endpoints (start↔start, end↔end) by min total squared distance.
      // Strokes have arbitrary orientation, so a confirmed line drawn
      // bottom-to-top still nudges a top-to-bottom draft correctly.
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      const direct  = d2(draft.start, evStart) + d2(draft.end, evEnd);
      const swapped = d2(draft.start, evEnd)   + d2(draft.end, evStart);
      const [evS, evE] = direct <= swapped ? [evStart, evEnd] : [evEnd, evStart];
      // Reject when evidence is far from current draft — almost certainly
      // a sketch with a different layout or scale.
      const gapStart = Math.hypot(draft.start.x - evS.x, draft.start.y - evS.y);
      const gapEnd   = Math.hypot(draft.end.x   - evE.x, draft.end.y   - evE.y);
      if (gapStart > maxGapPx || gapEnd > maxGapPx) continue;
      const a = STYLE_EVIDENCE_REUSE_BLEND;
      draft.start = {
        x: draft.start.x * (1 - a) + evS.x * a,
        y: draft.start.y * (1 - a) + evS.y * a,
      };
      draft.end = {
        x: draft.end.x * (1 - a) + evE.x * a,
        y: draft.end.y * (1 - a) + evE.y * a,
      };
      draft.styleEvidenceId = ev.latestRecordId;
      draft.styleEvidenceStatus = 'confirmed-prior';
      draft.styleEvidenceSamples = ev.sampleCount;
      // Prior evidence is a stronger signal than vanilla detection on
      // this style — promote the confidence so the TD review chip shows
      // the line as high-trust, but only raise (never demote).
      if (draft.confidence !== 'high') draft.confidence = 'high';
      changed += 1;
    }
    return changed;
  }

  function applyStyleAbsenceEvidenceToDrafts(drafts) {
    if (!Array.isArray(drafts) || !drafts.length) return 0;
    const absentByPom = getAbsentEvidenceByPom(currentStyleId());
    if (!absentByPom.size) return 0;
    let changed = 0;
    for (const draft of drafts) {
      const pom = draft && draft.seq != null ? String(draft.seq) : null;
      const evidence = pom ? absentByPom.get(pom) : null;
      if (!evidence) continue;
      draft.drawability = 'REVIEW_ONLY';
      draft.start = null;
      draft.end = null;
      draft.control1 = null;
      draft.control2 = null;
      draft.label = null;
      draft.confidence = 'low';
      draft.tdApproved = false;
      draft.tdApprovalRequired = true;
      draft.endpointApproximate = false;
      draft.styleEvidenceId = evidence.id;
      draft.styleEvidenceStatus = 'absent-confirmed';
      draft.uncertainty = 'Style evidence says POM ' + pom + ' is absent for this style.';
      draft.reason = draft.uncertainty;
      changed += 1;
    }
    return changed;
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
