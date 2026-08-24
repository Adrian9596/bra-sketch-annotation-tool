// Style evidence: save-time candidate capture from the live project.
// Source part for app.js. Run `npm run build` after editing.
//
// The durable store schema and CRUD (addStyleEvidence, listStyleEvidence,
// etc.) live in the sibling src/auto/learning/style-evidence-record.js,
// which loads before this file. Generate-time reuse of stored evidence to
// bias/veto fresh drafts lives in src/auto/learning/style-evidence-reuse.js.
//
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
    // US-096: a construction line carries no POM meaning, so learning must not
    // take its geometry as evidence for the POM number it happens to sit on.
    if (!isMeasurementAnnotation(ann)) return false;
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
      if (Array.isArray(ann.points) && ann.points.length) {
        const points = ann.points.map(pt => ({
          point: worldPointToImageNormalized(pt.point, image),
          handleIn: worldPointToImageNormalized(pt.handleIn, image),
          handleOut: worldPointToImageNormalized(pt.handleOut, image),
        })).filter(pt => pt.point && pt.handleIn && pt.handleOut);
        if (points.length) out.points = points;
      }
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
