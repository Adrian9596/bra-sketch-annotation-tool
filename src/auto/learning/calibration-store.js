// Manual-to-Auto learning loop: per-anchor residual buckets, detection
// parameter calibration, and the bias applier that nudges Auto Mode
// anchors toward where the TD ends up putting them. Source part for
// app.js. Run `npm run build` after editing.
//
// Three contracts: optional (toggle persists in localStorage), measurable
// (sample count + per-bucket medians inspectable), resettable (one-click
// clear). Buckets are keyed by (anchorKind × viewRole). Nothing leaves
// the browser — sketch IP stays local.

  // =============================================================
  // Phase 1: Manual-to-Auto Learning Loop
  //
  // Records (detected → corrected) anchor residuals after every commit
  // and applies the running median as a calibration bias on top of the
  // geometric rules from auto_mode_rules/*.json. The rule data is unchanged.
  //
  // Three properties the design must keep:
  //   - optional   : user toggle persists in localStorage; off => raw rules
  //   - measurable : sample count + per-bucket medians inspectable
  //   - resettable : one-click clear of every bucket
  //
  // Buckets are keyed by (anchorKind × viewRole). View role is explicit on
  // detected anchors where available, with schema-based fallback for older
  // projects.
  // Nothing leaves the browser — sketch IP stays local.
  // =============================================================

  const LEARNING_KEY = 'bra.learning.v1';
  const LEARNING_ENABLED_KEY = 'bra.learning.enabled.v1';
  const LEARNING_MIN_SAMPLES = 5;
  const LEARNING_MAX_PER_BUCKET = 50;
  const LEARNING_CLAMP = 0.05; // ±5% of image dimension
  const DETECTION_PARAM_MIN_SAMPLES = 5;
  const DETECTION_PARAM_MAX_SAMPLES = 50;
  // Anything smaller than ~1px on a 1024-wide image is UI jitter, not a
  // real correction. Keeps fat-finger drags and accidental clicks out
  // of the bucket.
  const LEARNING_MIN_DELTA = 0.001;
  // Hard ceiling on a single residual before it pollutes the bucket
  // median. A 15% drag is almost certainly a mislabel or a fat-finger
  // hand-off — applyMeaningSample already rejects 50% manual residuals
  // for label-collision safety; this is the tighter ceiling for the
  // calibration bucket where the median has to stay representative.
  const LEARNING_OUTLIER_LIMIT = 0.15;

  function emptyLearningStore() {
    return { buckets: {}, paramSamples: {} };
  }

  function normalizeLearningStore(parsed) {
    if (!parsed || typeof parsed !== 'object') return emptyLearningStore();
    return {
      buckets: (parsed.buckets && typeof parsed.buckets === 'object') ? parsed.buckets : {},
      paramSamples: (parsed.paramSamples && typeof parsed.paramSamples === 'object') ? parsed.paramSamples : {},
    };
  }

  function loadLearningStore() {
    try {
      const raw = localStorage.getItem(LEARNING_KEY);
      if (!raw) return emptyLearningStore();
      const parsed = JSON.parse(raw);
      return normalizeLearningStore(parsed);
    } catch (_) {
      return emptyLearningStore();
    }
  }

  function saveLearningStore() {
    try { localStorage.setItem(LEARNING_KEY, JSON.stringify(learningStore)); }
    catch (_) { /* quota — silently drop, no UX regression */ }
  }

  let learningStore = loadLearningStore();

  function isLearningEnabled() {
    try { return localStorage.getItem(LEARNING_ENABLED_KEY) !== '0'; }
    catch (_) { return true; }
  }

  function setLearningEnabled(on) {
    try { localStorage.setItem(LEARNING_ENABLED_KEY, on ? '1' : '0'); }
    catch (_) { /* ignore */ }
    updateUI();
  }

  function anchorView(anchorKind, anchor) {
    if (anchor && anchor.viewRole) return anchor.viewRole;
    const schema = ANCHOR_SCHEMA.find(s => s.kind === anchorKind);
    if (schema && schema.group === 'back') return 'back';
    if (anchorKind && anchorKind.indexOf('inner-cup-') === 0 && hasDetectedViewRole('front_inner')) {
      return 'front_inner';
    }
    return 'front_outer';
  }

  function learningBucketKey(anchorKind, anchor) {
    return anchorKind + '|' + anchorView(anchorKind, anchor);
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  }

  // Median-absolute-deviation — the robust spread metric paired with
  // medianOf. A bucket with [+1%, −5%, +4%] and one with [+0.5%, +0.6%]
  // produce the same median but very different MADs, which is exactly
  // the "this median is unreliable" signal we want surfaced.
  function madOf(arr, median) {
    if (!arr.length) return 0;
    const m = (typeof median === 'number') ? median : medianOf(arr);
    return medianOf(arr.map(v => Math.abs(v - m)));
  }

  // Returns true when the bucket's median is dwarfed by its spread —
  // [+5%, −5%, +4%, −4%] has median ≈ 0 but huge MAD, so applying it
  // would just inject noise. We downweight bias in that case instead of
  // suppressing it entirely so a slowly-stabilizing bucket can still
  // contribute when its spread tightens.
  function isBucketConflicting(samples, medianDx, medianDy) {
    if (!samples || samples.length < LEARNING_MIN_SAMPLES) return false;
    const dxs = samples.map(r => Number(r.dx) || 0);
    const dys = samples.map(r => Number(r.dy) || 0);
    const madDx = madOf(dxs, medianDx);
    const madDy = madOf(dys, medianDy);
    // Both axes wider than 1.5× the median magnitude → noise dominates.
    const noisyDx = madDx > 1.5 * Math.max(Math.abs(medianDx), LEARNING_MIN_DELTA * 4);
    const noisyDy = madDy > 1.5 * Math.max(Math.abs(medianDy), LEARNING_MIN_DELTA * 4);
    return noisyDx && noisyDy;
  }

  function getAnchorBias(anchorKind, anchor) {
    const bucket = learningStore.buckets[learningBucketKey(anchorKind, anchor)];
    if (!bucket || bucket.length < LEARNING_MIN_SAMPLES) {
      return { dx: 0, dy: 0, n: bucket ? bucket.length : 0 };
    }
    const dx = medianOf(bucket.map(r => r.dx));
    const dy = medianOf(bucket.map(r => r.dy));
    // Softly down-weight conflicting buckets — applies half the bias so
    // a stabilizing bucket still nudges, but a thrashing one barely
    // touches the anchor.
    const weight = isBucketConflicting(bucket, dx, dy) ? 0.5 : 1;
    return {
      dx: Math.max(-LEARNING_CLAMP, Math.min(LEARNING_CLAMP, dx)) * weight,
      dy: Math.max(-LEARNING_CLAMP, Math.min(LEARNING_CLAMP, dy)) * weight,
      n: bucket.length,
    };
  }

  function detectionParamBucket(paramName) {
    if (!learningStore.paramSamples || typeof learningStore.paramSamples !== 'object') {
      learningStore.paramSamples = {};
    }
    return learningStore.paramSamples[paramName] || (learningStore.paramSamples[paramName] = []);
  }

  function pushDetectionParamSample(paramName, sample) {
    const bucket = detectionParamBucket(paramName);
    bucket.push({ ...sample, ts: Date.now() });
    if (bucket.length > DETECTION_PARAM_MAX_SAMPLES) {
      bucket.splice(0, bucket.length - DETECTION_PARAM_MAX_SAMPLES);
    }
  }

  function detectionNoiseDelta(anchor, residualMagnitude) {
    const conf = anchor && anchor.confidence;
    if (conf === 'high') return Math.min(0.08, 0.015 + residualMagnitude * 0.5);
    return -Math.min(0.10, 0.02 + residualMagnitude * 0.7);
  }

  function recordDetectionParamResidual(anchorKind, dxNorm, dyNorm, anchor) {
    const sampleAnchor = anchor || { kind: anchorKind };
    const absX = Math.abs(dxNorm);
    const absY = Math.abs(dyNorm);
    const viewRole = anchorView(anchorKind, sampleAnchor);
    const base = {
      kind: anchorKind,
      viewRole,
      confidence: sampleAnchor.confidence || null,
    };

    // Bottom-band anchors are the cleanest signal for the detector's
    // bottom-band preferred row. Store the actual TD residual, then
    // getLearnedDetectionParams converts the running median into a small
    // ratio shift. (cf-bottom is intentionally NOT here: it is a DERIVED
    // anchor, so recordAnchorResidual returns before this runs — A6 removed
    // the dead clause that could never fire.)
    if ((anchorKind === 'band-left' || anchorKind === 'band-right')
        && absY >= LEARNING_MIN_DELTA) {
      pushDetectionParamSample('bandPreferredRatio', {
        ...base,
        residual: dyNorm,
        value: Math.max(-0.08, Math.min(0.08, dyNorm)),
      });
    }

    // Row features that consistently need vertical TD correction imply the
    // horizontal-feature gate is too permissive (high-confidence wrong row)
    // or too strict (fallback / low-confidence row). Store both the residual
    // and the proposed multiplier delta for later median aggregation.
    if (isRowLearnAnchor(anchorKind) && absY >= LEARNING_MIN_DELTA * 4) {
      pushDetectionParamSample('rowNoiseMultiplier', {
        ...base,
        residual: dyNorm,
        value: detectionNoiseDelta(sampleAnchor, absY),
      });
    }

    // Side / back edge anchors teach the column gate in the same way.
    if (isColumnLearnAnchor(anchorKind) && absX >= LEARNING_MIN_DELTA * 4) {
      pushDetectionParamSample('colNoiseMultiplier', {
        ...base,
        residual: dxNorm,
        value: detectionNoiseDelta(sampleAnchor, absX),
      });
    }
  }

  function isRowLearnAnchor(kind) {
    // cf-bottom omitted: it is derived, so it never reaches this gate (A6).
    return kind === 'cf-top'
      || kind === 'chest-left'
      || kind === 'chest-right'
      || kind === 'inner-cup-top'
      || kind === 'inner-cup-bottom'
      || kind === 'back-top'
      || kind === 'back-bottom'
      || kind === 'back-panel-top'
      || kind === 'back-panel-bottom'
      || kind === 'strap-top'
      || kind === 'strap-bottom';
  }

  function isColumnLearnAnchor(kind) {
    return kind === 'band-left'
      || kind === 'band-right'
      || kind === 'chest-left'
      || kind === 'chest-right'
      || kind === 'side-top'
      || kind === 'side-bottom'
      || kind === 'inner-cup-left'
      || kind === 'inner-cup-right'
      || kind === 'back-strap-left'
      || kind === 'back-strap-right'
      || kind === 'apex-left'
      || kind === 'apex-right';
  }

  function getDetectionParamSampleCount(paramName) {
    if (!learningStore.paramSamples || typeof learningStore.paramSamples !== 'object') return 0;
    if (paramName) return (learningStore.paramSamples[paramName] || []).length;
    let n = 0;
    for (const key in learningStore.paramSamples) n += learningStore.paramSamples[key].length;
    return n;
  }

  function getLearnedDetectionParams() {
    if (!isLearningEnabled()) return getDefaultDetectionParams();
    const base = typeof getDefaultDetectionParams === 'function'
      ? getDefaultDetectionParams()
      : { bandSearchStartRatio: 0.58, bandPreferredRatio: 0.82, rowNoiseMultiplier: 1, colNoiseMultiplier: 1 };
    const samples = learningStore.paramSamples || {};
    const medianDelta = (paramName) => {
      const bucket = samples[paramName] || [];
      if (bucket.length < DETECTION_PARAM_MIN_SAMPLES) return 0;
      return medianOf(bucket.map(r => Number(r.value) || 0));
    };
    const bandDelta = medianDelta('bandPreferredRatio');
    const rowDelta = medianDelta('rowNoiseMultiplier');
    const colDelta = medianDelta('colNoiseMultiplier');
    return {
      bandSearchStartRatio: Math.max(0.50, Math.min(0.68, base.bandSearchStartRatio + bandDelta * 0.5)),
      bandPreferredRatio: Math.max(0.72, Math.min(0.90, base.bandPreferredRatio + bandDelta)),
      rowNoiseMultiplier: Math.max(0.75, Math.min(1.25, base.rowNoiseMultiplier + rowDelta)),
      colNoiseMultiplier: Math.max(0.75, Math.min(1.25, base.colNoiseMultiplier + colDelta)),
      sampleCounts: {
        bandPreferredRatio: getDetectionParamSampleCount('bandPreferredRatio'),
        rowNoiseMultiplier: getDetectionParamSampleCount('rowNoiseMultiplier'),
        colNoiseMultiplier: getDetectionParamSampleCount('colNoiseMultiplier'),
      },
    };
  }

  // Stage attribution (Engineering Workflow Phase 8, item 1): which pipeline
  // stage most likely caused the correction the TD just made. Purely
  // diagnostic — the bias math never reads it — but it tells an engineer (via
  // the learning-data dialog and the sample records) WHERE the engine loses
  // accuracy. Precedence follows the pipeline upstream-first: a tiny drag is
  // an anchor nudge whatever the stage flags say; otherwise the deepest weak
  // stage claims the correction (segmentation → contour/seam evidence →
  // geometry frame → the landmark pick itself).
  const RESIDUAL_NUDGE_LIMIT = 0.015; // ≤1.5% of the image dimension = fine-tune
  function classifyResidualStage(anchorKind, dxNorm, dyNorm) {
    const mag = Math.max(Math.abs(Number(dxNorm) || 0), Math.abs(Number(dyNorm) || 0));
    if (mag < RESIDUAL_NUDGE_LIMIT) return 'anchor-nudge';
    const det = state.autoMode && state.autoMode.detection;
    if (!det) return 'unknown';
    if (det.segmentationReviewRequired) return 'segmentation-weak';
    const qa = det.landmarkQa && det.landmarkQa.byKind
      ? det.landmarkQa.byKind[anchorKind]
      : null;
    // 'projected' covers seamProjected / seamDip / ratio / cupRatioFallback —
    // the landmark had no direct contour/seam/ink evidence to rest on.
    if (qa && qa.sourceClass === 'projected') return 'contour-missing';
    if (det.geometryReviewRequired) return 'geometry-wrong';
    return 'landmark-wrong';
  }

  function recordAnchorResidual(anchorKind, dxNorm, dyNorm, anchor) {
    if (!isLearningEnabled()) return false;
    // Derived anchors (Phase 3, plan 2) are geometric consequences of their
    // primaries — a drag on one is a pin, not a detection correction, so it
    // must not train the calibration bias for that kind.
    if (typeof anchorDerivationForKind === 'function' && anchorDerivationForKind(anchorKind)) return false;
    if (!Number.isFinite(dxNorm) || !Number.isFinite(dyNorm)) return false;
    if (Math.abs(dxNorm) < LEARNING_MIN_DELTA && Math.abs(dyNorm) < LEARNING_MIN_DELTA) return false;
    // Drop residuals beyond the outlier ceiling — see LEARNING_OUTLIER_LIMIT.
    // A bucket of 50 samples carries each entry's contribution for a long
    // time, so one bad drag is worth rejecting at the door.
    if (Math.abs(dxNorm) > LEARNING_OUTLIER_LIMIT) return false;
    if (Math.abs(dyNorm) > LEARNING_OUTLIER_LIMIT) return false;
    const sampleAnchor = anchor || { kind: anchorKind };
    const key = learningBucketKey(anchorKind, anchor);
    const bucket = learningStore.buckets[key] || (learningStore.buckets[key] = []);
    // Phase 8 sample context — additive fields the bias math never reads:
    //   stage — suspected pipeline stage behind the correction (item 1);
    //   part  — semantic bra part (item 3 scoping context);
    //   style — the project's style code, so a future scoped-bias pass can
    //           split buckets per style WITHOUT invalidating today's data
    //           (the bucket key stays kind|viewRole on purpose);
    //   conf  — the anchor's confidence tier before the correction.
    const sample = {
      dx: dxNorm, dy: dyNorm, ts: Date.now(),
      stage: classifyResidualStage(anchorKind, dxNorm, dyNorm),
    };
    const part = (typeof semanticPartForAnchorKind === 'function')
      ? semanticPartForAnchorKind(anchorKind)
      : null;
    if (part) sample.part = part;
    const styleId = (typeof currentStyleId === 'function') ? currentStyleId() : null;
    if (styleId) sample.style = styleId;
    if (anchor && anchor.confidence) sample.conf = anchor.confidence;
    bucket.push(sample);
    // Drop the oldest entries first — recent TDs are more representative
    // of the current sketch style than ones from months ago.
    if (bucket.length > LEARNING_MAX_PER_BUCKET) {
      bucket.splice(0, bucket.length - LEARNING_MAX_PER_BUCKET);
    }
    recordDetectionParamResidual(anchorKind, dxNorm, dyNorm, sampleAnchor);
    saveLearningStore();
    return true;
  }

  function getLearningSampleCount() {
    let n = 0;
    for (const key in learningStore.buckets) n += learningStore.buckets[key].length;
    return n;
  }

  // Reset learned residuals only. POM meaning confirmations are kept —
  // those are reset via resetPomMeanings() so the TD can clear bad
  // calibration without losing every catalog choice.
  function resetLearning() {
    const count = getLearningSampleCount();
    if (count === 0) {
      showToast('Nothing learned yet.');
      return;
    }
    if (!window.confirm('Reset learned calibration? This deletes ' + count + ' recorded correction(s). Confirmed POM meanings are kept. Auto Mode will go back to the raw geometric rules.')) return;
    learningStore = emptyLearningStore();
    saveLearningStore();
    clearManualLearnCache();
    showToast('Calibration reset.');
    updateUI();
  }

  // Reset POM meanings only. 'current' wipes the current style bucket
  // ({styleId} or default), 'all' wipes every style + custom meanings.
  // Calibration residuals are untouched.
  function resetPomMeanings(scope) {
    const styleId = currentStyleId();
    if (scope === 'all') {
      let total = 0;
      for (const sid in meaningStore.styles) {
        total += Object.keys(meaningStore.styles[sid].pomMeanings || {}).length;
      }
      const customCount = Object.keys(meaningStore.customMeanings || {}).length;
      if (total === 0 && customCount === 0) {
        showToast('No POM meanings confirmed yet.');
        return;
      }
      if (!window.confirm('Forget every confirmed POM meaning across every style code, plus ' + customCount + ' custom measurement(s)? This cannot be undone.')) return;
      clearMeaningStore('all');
      showToast('All POM meanings forgotten.');
    } else {
      const bucket = getStyleBucket(styleId, false);
      const count = bucket ? Object.keys(bucket.pomMeanings).length : 0;
      if (count === 0) {
        showToast(styleId === DEFAULT_STYLE_ID
          ? 'No POM meanings confirmed for the default bucket yet.'
          : 'No POM meanings confirmed for style "' + styleId + '" yet.');
        return;
      }
      const label = styleId === DEFAULT_STYLE_ID ? 'the default bucket' : 'style "' + styleId + '"';
      if (!window.confirm('Forget ' + count + ' confirmed POM meaning(s) for ' + label + '?')) return;
      clearMeaningStore('current');
      showToast('POM meanings forgotten for ' + label + '.');
    }
    updateUI();
  }

  // Apply the median residual to every anchor in-place. Called by
  // seedAnchorsFromDetection so every code path that re-seeds anchors
  // (Detect Sketch, Reset Anchors) gets the same treatment.
  function applyLearningBiasToAnchors(anchors) {
    if (!Array.isArray(anchors) || !anchors.length) return anchors;
    if (!isLearningEnabled()) return anchors;
    for (const anchor of anchors) {
      // Derived anchors no longer learn residuals (see recordAnchorResidual),
      // so skip applying any bucket recorded before they became derived —
      // stale bias would fight the cascade's geometric projection.
      if (typeof anchorDerivationForKind === 'function' && anchorDerivationForKind(anchor.kind)) continue;
      // A2: stash the UNBIASED prediction so a later TD correction trains the
      // residual against it, not against this biased seed. Recording against
      // the biased seed makes the bucket median (and thus the bias) converge to
      // only HALF the true systematic offset — the loop never fully learns.
      // startAnchorDrag / nudgeSelectedAnchor read predictedX/Y as learnOrigin.
      anchor.predictedX = anchor.x;
      anchor.predictedY = anchor.y;
      const bias = getAnchorBias(anchor.kind, anchor);
      if (!bias.dx && !bias.dy) continue;
      anchor.x = clamp01(anchor.x + bias.dx);
      anchor.y = clamp01(anchor.y + bias.dy);
      // Tag so future UI can show "this anchor was nudged by learning"
      // without recomputing the bias. Harmless if unused.
      anchor.calibrated = true;
    }
    // A3: inner-cup-left and inner-cup-right are biased from independent
    // buckets (up to ±LEARNING_CLAMP each), so a large opposing pair can push
    // left past right on a narrow cup and swap the POM-10 width endpoints. The
    // "left < right" invariant is only guaranteed at seed time, so re-assert it
    // here: if biasing inverted the order, revert BOTH to their unbiased
    // prediction (which seeding kept correctly ordered) rather than trust a
    // bias inappropriate for this cup.
    const icl = anchors.find(a => a && a.kind === 'inner-cup-left');
    const icr = anchors.find(a => a && a.kind === 'inner-cup-right');
    if (icl && icr && icl.x >= icr.x
        && Number.isFinite(icl.predictedX) && Number.isFinite(icr.predictedX)
        && icl.predictedX < icr.predictedX) {
      icl.x = clamp01(icl.predictedX);
      icr.x = clamp01(icr.predictedX);
    }
    return anchors;
  }

  // =============================================================
  // Phase 2 + Phase 3: Manual Mode silently teaches Auto Mode.
  //
  // Trigger: TD labels a manual line with a recognised POM number 1–18.
  // The tool runs a shadow detection on that image (cached per-image),
  // resolves the POM number to a *measurement meaning* (fixed for POMs
  // 1, 3, 5; confirmed once by the TD for POMs 6+), then records the
  // residual between the manual endpoints and the raw anchors of that
  // meaning. Phase 1 store, Auto Mode behavior, Manual Mode UI, and
  // Auto Mode JSON rules all stay untouched.
  //
  // Phase 3 design notes:
  //   - POMs 1, 3, 5 share fixed meanings across styles, so no
  //     confirmation is asked.
  //   - POMs 2, 4 are extension lines with derived endpoints — skipped.
  //   - POMs 6+ vary by style (POM 9 could be cup-height or
  //     side-height). First time the TD labels POM N (N ≥ 6) on this
  //     machine, the UI asks once, remembers in localStorage forever.
  //   - Bucketing remains anchor × view (Phase 1). Different meanings
  //     → different anchor pairs → different buckets. No new store.
  // =============================================================

  // Per-image shadow detection cache. Detection is expensive (~100–300 ms
  // on a 1024-wide sketch) and the result is purely a function of the
  // image pixels — so once per image is enough. Cache lives in module
  // scope, not state, because it never needs to survive save/reopen.
  const manualLearnCache = new Map();

  // Realistic ceiling for a POM number parsed from a label. The regex below
  // already caps at two digits; this bound keeps incidental 2-digit numbers
  // in a label (e.g. "12 cm") from being read as a POM, while still letting
  // custom POMs (19, 20, …) through. Tunable.
  const POM_LABEL_MAX = 40;

  // Pull "1" out of labels like "1", "POM 1", "1A", "Underbust (1)".
  // Accepts any POM in the 1–POM_LABEL_MAX range. POMs above the fixed 1–18
  // core template are not dropped here — they resolve to a style-scoped meaning
  // via the confirmation popover instead of being silently ignored.
  function parsePomNumberFromLabel(text) {
    if (!text) return null;
    const m = /(?:^|[^\d])(\d{1,2})(?:$|[^\d])/.exec(' ' + String(text) + ' ');
    if (!m) return null;
    const n = Number(m[1]);
    return (n >= 1 && n <= POM_LABEL_MAX) ? String(n) : null;
  }

  // World-coord midpoint test — picks the image whose displayed bbox
  // contains the line's midpoint. Works in all standard cases (one
  // image per sketch, or multiple sketches on a board with disjoint
  // images). Returns null when the line is outside every image.
  function pickImageForAnnotation(ann) {
    if (!ann || !ann.start || !ann.end) return null;
    const mx = (ann.start.x + ann.end.x) / 2;
    const my = (ann.start.y + ann.end.y) / 2;
    for (const image of state.images) {
      if (!image || !image.img) continue;
      if (mx >= image.x && mx <= image.x + image.width
       && my >= image.y && my <= image.y + image.height) return image;
    }
    return null;
  }

  // Same normalization scheme anchors use (see anchorWorldPos in
  // auto-detection.js): fraction of the image's displayed width/height.
  // Keeps residuals comparable to the Phase 1 anchor-drag residuals.
  function worldToAnchorSpace(image, world) {
    return {
      x: (world.x - image.x) / image.width,
      y: (world.y - image.y) / image.height,
    };
  }

  // Run (or reuse) a shadow detection on this image. Skips bias so the
  // returned anchors are the raw prediction, not the already-corrected
  // one. Returns null on any failure — Phase 2 stays silent in that case.
  function getShadowAnchorsForImage(image) {
    if (!image || !image.img || !image.img.complete) return null;
    const cached = manualLearnCache.get(image.id);
    if (cached && cached.rawAnchors) return cached.rawAnchors;
    let detection;
    try { detection = detectSketchFromImage(image, { skipLearningParams: true }); }
    catch (_) { return null; }
    if (!detection || !detection.bbox || detection.coverage < 0.001) return null;
    detection.sourceImageId = image.id;
    const rawAnchors = seedAnchorsFromDetection(detection, image, { skipLearning: true });
    manualLearnCache.set(image.id, { detection, rawAnchors });
    return rawAnchors;
  }

  // Clear the shadow detection cache. Called by the working-board reset
  // (images going away) and by Reset Learning (so a fresh learning run
  // starts from a clean shadow too).
  function clearManualLearnCache() {
    manualLearnCache.clear();
  }

  // Transparent Learning panel feed. Aggregates the per-bucket residual
  // store into rows the Learning Data modal can render directly without
  // having to know the persisted shape. The status field encodes the
  // same activation / clamp thresholds used by getAnchorBias:
  //   - 'active'              : >= LEARNING_MIN_SAMPLES samples, normal bias
  //   - 'needs-more-samples'  : 1..LEARNING_MIN_SAMPLES-1 samples
  //   - 'large-correction'    : active AND median delta hit the clamp limit
  //   - 'conflicting'         : active but spread dwarfs the median; bias
  //                             is softly down-weighted at apply time
  function summarizeLearningStore() {
    const buckets = (learningStore && learningStore.buckets) || {};
    const rows = [];
    let totalSamples = 0;
    // Phase 8: corrections by suspected pipeline stage. Samples recorded
    // before stage attribution existed have no stage field — counted as
    // 'unattributed' so the totals still reconcile.
    const stageCounts = {};
    for (const key of Object.keys(buckets)) {
      const bucket = buckets[key] || [];
      const n = bucket.length;
      totalSamples += n;
      for (const r of bucket) {
        const stage = r && r.stage ? r.stage : 'unattributed';
        stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      }
      const pipe = key.indexOf('|');
      const kind = pipe >= 0 ? key.slice(0, pipe) : key;
      const viewRole = pipe >= 0 ? key.slice(pipe + 1) : '';
      const dxs = bucket.map(r => Number(r.dx) || 0);
      const dys = bucket.map(r => Number(r.dy) || 0);
      const medianDx = n ? medianOf(dxs) : 0;
      const medianDy = n ? medianOf(dys) : 0;
      const madDx = n ? madOf(dxs, medianDx) : 0;
      const madDy = n ? madOf(dys, medianDy) : 0;
      const lastTs = n ? bucket.reduce((m, r) => Math.max(m, Number(r.ts) || 0), 0) : 0;
      const conflicting = isBucketConflicting(bucket, medianDx, medianDy);
      let status;
      if (n === 0) status = 'empty';
      else if (n < LEARNING_MIN_SAMPLES) status = 'needs-more-samples';
      else {
        const clamped = Math.abs(medianDx) >= LEARNING_CLAMP - 1e-6
          || Math.abs(medianDy) >= LEARNING_CLAMP - 1e-6;
        if (clamped) status = 'large-correction';
        else if (conflicting) status = 'conflicting';
        else status = 'active';
      }
      rows.push({ key, kind, viewRole, samples: n, medianDx, medianDy, madDx, madDy, lastTs, status });
    }
    rows.sort((a, b) => {
      if (a.viewRole !== b.viewRole) return a.viewRole < b.viewRole ? -1 : 1;
      return a.kind < b.kind ? -1 : (a.kind > b.kind ? 1 : 0);
    });

    const paramSamples = (learningStore && learningStore.paramSamples) || {};
    const params = {};
    let totalParamSamples = 0;
    for (const name of Object.keys(paramSamples)) {
      const count = (paramSamples[name] || []).length;
      params[name] = count;
      totalParamSamples += count;
    }

    return {
      enabled: isLearningEnabled(),
      totalSamples,
      bucketCount: rows.length,
      activeBucketCount: rows.filter(r => r.status === 'active' || r.status === 'large-correction' || r.status === 'conflicting').length,
      needsMoreCount: rows.filter(r => r.status === 'needs-more-samples').length,
      largeCorrectionCount: rows.filter(r => r.status === 'large-correction').length,
      conflictingCount: rows.filter(r => r.status === 'conflicting').length,
      minSamples: LEARNING_MIN_SAMPLES,
      clampLimit: LEARNING_CLAMP,
      outlierLimit: LEARNING_OUTLIER_LIMIT,
      stageCounts,
      paramSampleCounts: params,
      totalParamSamples,
      rows,
    };
  }
