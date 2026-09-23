// Detection pipeline composer. Wires the four named stages together —
// segment -> contours -> geometry -> landmarks — with per-stage wall-clock
// timing, and holds Stage 3 itself (the contour / topology extraction glue and
// its serializable evidence summary).
//
// The other stages live beside it under src/auto/detect/: segmentation.js
// (Stage 2), geometry-stage.js (Stage 4), landmark-stage.js (Stage 5) and the
// finder / model parts those call. The Auto Mode DOM + state edge that drives
// this composer — Detect Sketch, anchor seeding, aux views, the view-role
// dialog, the CV adapter pick — lives in src/auto/mode/offline-detection-run.js.
// Source part for app.js. Run `npm run build` after editing.

  // detectSketchFromImage — offline shape analysis pipeline.
  //
  // Reads pixels into an offscreen canvas, estimates the paper/background,
  // builds an "ink" mask, removes speckle via connected components, groups
  // likely sketch views, then picks a primary view for landmark extraction.
  // Feature detection is still fully local: no API, no network, no model.
  //
  // All returned coordinates are normalized [0, 1] relative to the source
  // image's native pixel size so they travel with the image.
  // Orchestrator that keeps the public callsite unchanged.
  // 1. Builds the ink analysis from the source image (DOM I/O edge).
  // 2. Hands it to the pure detection pipeline along with the same CV adapter
  //    used for the ink mask, so the components stage stays on one backend.
  function detectSketchFromImage(image, options) {
    const cvAnalysis = buildInkAnalysisFromImage(image);
    return detectSketchFromInkAnalysis(cvAnalysis, {
      // Reuse the exact backend that built the ink mask — do NOT re-pick with
      // getCvApi(), which can flip mid-pipeline and feed a free-path mask into
      // the real-backend component pass (an untested, nondeterministic path).
      cv: cvAnalysis.inkBackend || null,
      params: activeDetectionParams(options),
      debug: !!(options && options.debug),
      // singleView: treat the whole photo as ONE garment view — skip the
      // front/back/inner panel split. Used for auxiliary photos (e.g. a
      // front-inner cutaway added as its own image), which are a single view;
      // the split otherwise carves the cutaway's gore/shading alleys into 3
      // boxes and collapses the "front" onto one cup.
      singleView: !!(options && options.singleView),
    });
  }

  // Pure detection pipeline: ink mask + stats → detection object.
  //
  // From this point on the pipeline is data-in / data-out — no DOM, no state,
  // no globals. The CV adapter (opts.cv) is injected so callers can swap or
  // omit it; passing null forces the in-house components path, which keeps the
  // pipeline runnable from Node with a synthetic ink analysis. Per-stage
  // durations are recorded on detection.stageTimingsMs so each stage can be
  // independently timed.
  // Pure detection pipeline, now composed from four named stage functions:
  //   segmentSketch    → ink mask + connected-component cleanup
  //   extractContours  → junction / endpoint topology on the cleaned mask
  //   analyzeGeometry  → view boxes, symmetry axis, band/chest/cradle rows,
  //                      side-seam columns (geometry facts in pixel space)
  //   detectLandmarks  → apex/strap/cup/back landmarks, confidence, and the
  //                      assembled detection result
  // The stages thread explicit context objects between them (no shared closure
  // state beyond the injected stage marker), and the composed output is the
  // same detection object shape the rest of the app already consumed. This is
  // a pure structural refactor — see Engineering Workflow Phase 2.
  function detectSketchFromInkAnalysis(cvAnalysis, opts) {
    const cv = (opts && opts.cv) || null;
    const detectionParams = normalizeDetectionParams(opts && opts.params);
    const debugEnabled = !!(opts && opts.debug);
    const stageTimingsMs = {};
    const mark = makeStageMarker(stageTimingsMs);

    // Stage 2: segmentation (ink mask + connected-component cleanup).
    const seg = segmentSketch(cvAnalysis, { cv, mark, stageTimingsMs });
    if (seg.earlyReturn) return seg.earlyReturn;

    // Stage 3: contour / topology extraction (the clean evidence bundle).
    const contours = extractContours(seg, { mark });

    // Stage 4: geometry analysis (view roles, axis, band/cup rows, seams).
    // The contour-evidence bundle is threaded in so the geometry stage CAN read
    // endpoints / curve candidates (Phase 4, item 3); geometry decisions are
    // unchanged in this phase — it is availability, not forced consumption.
    const geometry = analyzeGeometry(seg, {
      detectionParams, mark, stageTimingsMs, contourEvidence: contours,
      singleView: !!(opts && opts.singleView),
    });
    if (geometry.earlyReturn) return geometry.earlyReturn;

    // Stage 5: landmark construction + confidence + assembly.
    return detectLandmarks(cvAnalysis, seg, geometry, contours, {
      detectionParams, debugEnabled, stageTimingsMs, mark,
    });
  }

  // Per-stage wall-clock marker. Records the delta (ms, 2dp) since the last
  // mark under `name` on the shared timings object. Timings are diagnostic
  // only and inherently non-deterministic — nothing downstream keys on them.
  function makeStageMarker(timings) {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now()
      : () => Date.now();
    let last = now();
    return function markStage(name) {
      const t = now();
      timings[name] = Math.max(0, Math.round((t - last) * 100) / 100);
      last = t;
    };
  }

  // ---- Stage 3: contour / topology extraction (Engineering Workflow Phase 4) ----
  // Input: the cleaned mask from segmentSketch. Output: a clean CONTOUR-EVIDENCE
  // bundle — { contours, endpoints, junctions, corners, curves, strokeStats }
  // (plus the raw junctionMap handle for back-compat). This is deliberately a
  // bag of SHAPE EVIDENCE, not geometry decisions: nothing here is an anchor or
  // a garment-level verdict, and downstream stages only READ it. Keeping the
  // raw contour data separate from technical meaning is the whole point of the
  // phase (see Engineering Workflow.md §3, "Keep raw contour data separate").
  //
  // Two fields are populated lazily by the deferred Potrace edge pass (its
  // duration is non-deterministic, so it runs at the orchestrator edge, not in
  // this pure stage): `contours` (traced outlines → detection.contours) and
  // `curves` (reusable curve candidates → detection.curveCandidates, built by
  // buildContourCurveCandidates). They are null here by design.
  // Auxiliary data only — a failure here must never sink the detection.
  function extractContours(seg, ctx) {
    const _stageMark = ctx.mark;
    const { dark, w, h } = seg;

    // ---- Stage: junction / endpoint / corner map (Phase 1, plan 2) ----
    // Skeleton-topology features on the CLEANED mask. A failure here must never
    // sink the detection — hence the catch.
    let junctionMap = null;
    try {
      junctionMap = detectJunctions(dark, w, h);
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Auto Mode] junction detection failed (non-fatal):', err);
      }
      junctionMap = null;
    }
    _stageMark('junctions');

    // Split the raw feature points by type and roll up stroke statistics. The
    // shaping lives in the junction module (buildContourTopology) so it stays
    // testable next to detectJunctions.
    const topology = buildContourTopology(junctionMap);

    return {
      // Raw traced outlines — filled by the deferred Potrace edge pass.
      contours: null,
      // Skeleton topology, split so consumers don't re-filter by type.
      junctions: topology.junctions,
      endpoints: topology.endpoints,
      corners: topology.corners,
      // Reusable curve candidates — populated from the trace (see
      // buildContourCurveCandidates) once detection.contours exists.
      curves: null,
      // Deterministic skeleton stroke statistics (px, iterations, counts).
      strokeStats: topology.strokeStats,
      // Internal handle: detectLandmarks maps this to the unchanged
      // detection.junctions / detection.junctionSummary contract.
      junctionMap,
    };
  }

  // Phase 4: build a compact, serializable summary of the contour-evidence
  // bundle for the detection result. Deterministic skeleton-derived counts +
  // stroke stats; the trace-dependent fields (traced / contourCount /
  // curveCandidateCount) start empty here and are filled at the Potrace edge.
  function buildContourEvidenceSummary(contourEvidence) {
    const ce = contourEvidence || {};
    const stroke = ce.strokeStats || null;
    return {
      junctionCount: Array.isArray(ce.junctions) ? ce.junctions.length : 0,
      endpointCount: Array.isArray(ce.endpoints) ? ce.endpoints.length : 0,
      cornerCount: Array.isArray(ce.corners) ? ce.corners.length : 0,
      strokeStats: stroke ? { ...stroke } : null,
      // Raw traced outlines are optional shape evidence attached at the edge.
      traced: false,
      contourCount: null,
      curveCandidateCount: 0,
    };
  }
