// Shared shadow-detection utilities: a per-image cache of a raw (unbiased)
// re-detection, plus the small geometry/label helpers built on top of it.
// Source part for app.js. Run `npm run build` after editing.
//
// These are low-level helpers consumed by meaning-commit.js (and, through
// it, by meaning-store.js's ranking heuristics) — not calibration math, so
// they live apart from src/auto/learning/calibration-store.js even though
// they originally accreted there. calibration-store.js keeps the residual
// buckets and bias math; meaning-store.js keeps the POM-meaning catalog;
// meaning-commit.js is the workflow that spans all three.

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
