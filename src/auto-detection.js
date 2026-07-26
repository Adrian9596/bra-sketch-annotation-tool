// Auto Mode boundaries, offline sketch detection, feature extraction, anchor seeding and dragging.
// Source part for app.js. Run `npm run build` after editing.

  // -------- Offline sketch detection --------
  //
  // First pass of "Detect Sketch": pure pixel analysis on the source image,
  // no model. Estimates a bounding box of the dark line art, the vertical
  // symmetry axis, and the bottom-band y. These will feed anchor placement
  // in the next phase. Everything is normalized to the image's native
  // pixel space [0, 1]^2 so it survives image scaling / canvas pans.

  async function runOfflineDetection() {
    // ---- Edge: precondition checks (state read + toast on failure) ----
    if (state.appMode !== 'auto') {
      showToast('Switch to Auto Mode first.');
      return;
    }
    const sourceImage = pickAutoSourceImage();
    if (!sourceImage) {
      showToast('Add or select an image first, then click Detect Sketch.', 3600);
      return;
    }
    if (!sourceImage.img || !sourceImage.img.complete) {
      showToast('Source image is not ready yet — try again in a moment.');
      return;
    }

    recordAutoTelemetryEvent('detect_clicked', {
      sourceImageId: sourceImage.id,
    });

    // ---- Edge: status flip + render so the chip updates before the scan ----
    state.autoMode.status = 'detecting';
    state.autoMode.lastError = null;
    updateUI();
    requestRender();
    await new Promise((r) => setTimeout(r, 0));
    // Give real opencv.js a short grace window to finish compiling (the
    // vendored script loads from disk; S1 warms it up from init(), so by the
    // first Detect this is usually already settled). Skipped entirely when
    // the harness pins the free path.
    if (!FORCE_FREE_CV && window.RealOpenCVAPI && typeof window.RealOpenCVAPI.whenReady === 'function') {
      try { await window.RealOpenCVAPI.whenReady(2500); } catch (_) { /* fall through */ }
    }

    // ---- Pure middle: image → ink analysis → detection ----
    // detectSketchFromImage is a thin wrapper: buildInkAnalysisFromImage
    // (DOM read) → detectSketchFromInkAnalysis (pure pipeline with per-stage
    // timings on detection.stageTimingsMs).
    // CV debug capture is opt-in: state flag (set via the debug API) OR a
    // ?cvDebug=1 URL flag. The flag is consulted once per detection so a
    // mid-run toggle takes effect on the next click.
    syncCvDebugFromUrl();
    const cvDebugOn = !!(state.autoMode.cvDebug && state.autoMode.cvDebug.enabled);
    let detection;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      detection = detectSketchFromImage(sourceImage, { debug: cvDebugOn });
    } catch (err) {
      console.warn('[Auto Mode] Detect Sketch failed:', err);
      state.autoMode.status = 'error';
      state.autoMode.lastError = 'Detect Sketch failed: ' + (err && err.message ? err.message : err);
      showToast(state.autoMode.lastError, 4200);
      updateUI();
      requestRender();
      return;
    }
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (!detection || !detection.bbox || detection.coverage < 0.001) {
      state.autoMode.detection = null;
      state.autoMode.status = state.autoMode.draftAnnotations.length > 0 ? 'reviewing' : 'ready';
      state.autoMode.lastError = 'Detect Sketch found no dark line art in the source image.';
      showToast(state.autoMode.lastError, 4200);
      updateUI();
      requestRender();
      return;
    }

    // ---- Edge: post-pipeline annotation + optional Potrace contour pass ----
    // Stamping identity / timing onto the detection counts as a side effect
    // because the pure pipeline produced an opaque value; we attach the
    // context only the orchestrator knows. Potrace tracing is async DOM-free
    // work but is non-deterministic in duration, so it lives at the edge.
    detection.sourceImageId = sourceImage.id;
    detection.computedAt = new Date().toISOString();
    detection.durationMs = Math.round(t1 - t0);
    // Mask is normally consumed (and stripped) by the Potrace pass. When CV
    // debug is on, render a PNG of it FIRST so the debug snapshot has an
    // image to display — otherwise the mask is gone before debug runs.
    if (cvDebugOn && detection.debug && detection._mask) {
      try {
        detection.debug.maskPng = encodeMaskToPng(
          detection._mask, detection._maskW, detection._maskH
        );
      } catch (err) {
        console.warn('[Auto Mode] CV debug: mask PNG encode failed:', err);
      }
    }
    await applyPotraceContoursToDetection(detection);
    // Mirror the latest debug capture onto state so it can be exported
    // independently of the live detection object (which gets cleared on
    // mode switches).
    if (state.autoMode.cvDebug) {
      state.autoMode.cvDebug.lastDebug = cvDebugOn && detection.debug
        ? detection.debug
        : null;
    }

    // ---- Edge: commit detection + seed anchors + notify ----
    state.autoMode.detection = detection;
    // US-039: recognize EXTRA board photos (beyond the single detection source)
    // as auxiliary views — e.g. a front-inner cutaway the TD added as its own
    // image. Recognition + labeling ONLY: measurement stays on the source image
    // and no POM moves to these views (ADR 0011).
    detection.auxViews = await buildAuxViews(sourceImage);
    // When view-role classification is uncertain — e.g. a 3-panel board where
    // "back" vs "front_inner" is genuinely ambiguous from the sketch — let the
    // TD confirm/correct the roles BEFORE anchors are seeded, so a corrected
    // front/back/inner assignment places anchors on the right panels. Awaited so
    // seeding uses the confirmed roles. In test/label modes it returns
    // immediately (see maybePromptForViewRoles) and seeding proceeds with the
    // auto roles, so headless suites are unaffected.
    await maybePromptForViewRoles(detection, sourceImage);
    seedAndRelocateAnchors(detection, sourceImage);
    recordAutoTelemetryEvent('anchor_seeded', {
      sourceImageId: sourceImage.id,
      count: state.autoMode.anchors.length,
      duration_ms: detection.durationMs,
    });
    state.autoMode.anchorSelectedId = null;
    state.autoMode.anchorsHidden = false;
    state.autoMode.hiddenAnchorKinds = []; // US-038: fresh detect shows all anchors
    state.autoMode.status = 'detected';
    state.autoMode.lastError = null;
    recordAutoTelemetryEvent('detect_finished', {
      sourceImageId: sourceImage.id,
      duration_ms: detection.durationMs,
      status: 'ok',
    });

    pushHistoryIfChanged();
    updateUI();
    requestRender();
    const traceInfo = detection.contours
      ? ' + ' + detection.contourCount + ' contours (' + detection.traceDurationMs + 'ms)'
      : '';
    showToast('Detected sketch (' + detection.durationMs + 'ms)' + traceInfo + '. Anchors seeded — drag any that look wrong, then Generate POM Drafts.');
  }

  // Seed anchors from the committed detection, then apply the US-049 relocation
  // that moves the cup / neckline / armhole POMs (9/10/17/18) onto a SEPARATE
  // front-inner PHOTO's own seeded anchors when one was recognized as an aux
  // view. (An in-image front-inner PANEL — a 3-view board in a single photo — is
  // handled inside seedAnchorsFromDetection itself, which transfers those anchors
  // from the front-outer box onto the inner box.) Extracted so it can re-run
  // after the TD confirms/corrects view roles, re-placing anchors to follow the
  // corrected front/back/inner assignment.
  function seedAndRelocateAnchors(detection, sourceImage) {
    state.autoMode.anchors = seedAnchorsFromDetection(detection, sourceImage);
    const innerViewSeed = (detection.auxViews || [])
      .find(v => v && v.viewRole === 'front_inner' && Array.isArray(v.anchors) && v.anchors.length);
    if (innerViewSeed) {
      const MOVED_ANCHOR_KINDS = ['inner-cup-top', 'inner-cup-bottom', 'inner-cup-left', 'inner-cup-right', '171', '172', '181', '182'];
      const innerByKind = Object.create(null);
      for (const an of innerViewSeed.anchors) innerByKind[an.kind] = an;
      state.autoMode.anchors = state.autoMode.anchors.map(an =>
        (MOVED_ANCHOR_KINDS.indexOf(an.kind) >= 0 && innerByKind[an.kind]) ? innerByKind[an.kind] : an);
    }
  }

  // US-039: recognize EXTRA board photos as auxiliary views. The main pipeline
  // detects/measures ONE source image; a TD may add a front-inner cutaway (or
  // other reference) as its OWN photo. Each such photo becomes one aux view: an
  // ink bbox normalized to that photo (so it follows pans / zooms / resizes),
  // with a display role. This is recognition + labeling only — no anchors, no
  // POM placement, no change to the measurement detection (ADR 0011: the inner
  // cutaway is a bonus, never a precondition). The primary image already holds
  // front_outer + back, so the first extra photo defaults to the front-inner
  // view; further extras stay 'unknown' for the TD to interpret.
  async function buildAuxViews(sourceImage) {
    if (!sourceImage) return [];
    const others = state.images.filter(
      (im) => im && im.id !== sourceImage.id && im.img && im.img.complete
    );
    const auxViews = [];
    let innerAssigned = false;
    for (const im of others) {
      let box = { x: 0, y: 0, width: 1, height: 1 }; // fallback: whole photo
      let det = null;
      try {
        // singleView: an aux photo is ONE garment view (front-inner cutaway),
        // so detect it without the panel split — otherwise its gore/shading
        // alleys split it into 3 boxes and the cup/neckline/armhole anchors
        // seed off one cup instead of the whole, centered garment.
        det = detectSketchFromImage(im, { debug: false, singleView: true });
        // Union of every detected view box = the full drawn extent, so the
        // label hugs the whole sketch even when an extra photo has more than
        // one panel (or its cups split at the gore). detection.bbox alone is
        // only the primary view's bounds, so it can undercover. Fall back to
        // bbox, then to the whole photo.
        const views = det && Array.isArray(det.viewBoxes) ? det.viewBoxes.filter(Boolean) : [];
        if (views.length) {
          const minX = Math.min(...views.map((v) => v.x));
          const minY = Math.min(...views.map((v) => v.y));
          const maxX = Math.max(...views.map((v) => v.x + v.width));
          const maxY = Math.max(...views.map((v) => v.y + v.height));
          if (maxX > minX && maxY > minY) box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        } else if (det && det.bbox && det.bbox.width > 0 && det.bbox.height > 0) {
          box = { x: det.bbox.x, y: det.bbox.y, width: det.bbox.width, height: det.bbox.height };
        }
      } catch (err) {
        console.warn('[Auto Mode] aux-view bbox failed; boxing whole image:', err);
      }
      const viewRole = innerAssigned ? 'unknown' : 'front_inner';
      innerAssigned = true;
      const auxView = {
        sourceImageId: im.id,
        aux: true,
        viewRole,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
      // US-049: the front-inner view is a MEASUREMENT surface for the cup /
      // neckline / armhole POMs (9, 10, 17, 18 — POM 8 stays on front-outer,
      // ADR 0011 amendment). Persist its detection (minus the heavy ink mask,
      // session-only) plus a full anchor set seeded on THIS photo, so
      // generatePOMDraftsFromAnchors can run a second pass that places those
      // POMs on the inner view.
      if (viewRole === 'front_inner' && det && det.bbox) {
        try {
          det.sourceImageId = im.id;
          // Mark the detection as a single-view (front-inner cutaway) so the
          // anchor seeder drops the top-of-cup POMs (172/182/IC-top) to the
          // strap→cup seam for this view — the front-outer strap-join fraction
          // lands them up at the apex on a molded cutaway.
          det.singleView = true;
          // Trace this photo's contours BEFORE the mask is dropped. The primary
          // pipeline traces only the SOURCE image, but seedAnchorsFromDetection's
          // cup-width extremes (ADR 0036) require detection.contours — without
          // them it silently fell back to the pre-ADR-0036 shared-row placement,
          // so a 2-image board (primary + separate front-inner cutaway) kept the
          // old narrow POM 10 while a single 3-view photo got the new one.
          await applyPotraceContoursToDetection(det);
          delete det._mask; delete det._maskW; delete det._maskH; delete det.debug;
          // Keep the promise in the comment above buildAuxViews: the persisted aux
          // detection carries no heavy raster payload.
          delete det.inkMask; delete det.inkMaskW; delete det.inkMaskH;
          auxView.detection = det;
          auxView.anchors = seedAnchorsFromDetection(det, im);
        } catch (err) {
          console.warn('[Auto Mode] inner-view anchor seeding failed:', err);
        }
      }
      auxViews.push(auxView);
    }
    return auxViews;
  }

  // Vector tracing pass — runs after the raster feature pass so curved
  // landmarks (cup arcs, strap, back hook) have real bezier control points
  // available to the POM generator. Failure is non-fatal: the rest of the
  // pipeline keeps working with the hand-tuned curves. Mutates `detection`
  // in place (adds contours / contourCount / traceDurationMs / engine suffix).
  async function applyPotraceContoursToDetection(detection) {
    const mask = detection._mask;
    const maskW = detection._maskW;
    const maskH = detection._maskH;
    delete detection._mask;
    delete detection._maskW;
    delete detection._maskH;
    if (!mask || !maskW || !maskH) return;
    // U2: keep the binary ink mask (~1 byte per sample px, session-only —
    // detection is never persisted or snapshotted) so snapAnchorToInk can
    // pull a released anchor onto the nearest sketch ink. Moved off the
    // underscore keys, which the debug/PNG path above treats as consumed.
    detection.inkMask = mask;
    detection.inkMaskW = maskW;
    detection.inkMaskH = maskH;
    const traceT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const traced = await tracePotraceFromMask(mask, maskW, maskH);
      if (traced) {
        detection.contours = traced;
        detection.contourCount = traced.paths.length;
        detection.traceDurationMs = Math.round(
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - traceT0
        );
        detection.engine += '+potrace';
        // Phase 4: normalize the traced outlines into reusable curve candidates
        // (one shared classification pass) and complete the contour-evidence
        // summary. Both are the deferred half of extractContours' bundle —
        // shape evidence only, no geometry decision.
        detection.curveCandidates = buildContourCurveCandidates(traced, detection);
        if (detection.contourEvidence) {
          detection.contourEvidence.traced = true;
          detection.contourEvidence.contourCount = traced.paths.length;
          detection.contourEvidence.curveCandidateCount = detection.curveCandidates.length;
        }
      }
    } catch (err) {
      console.warn('[Auto Mode] Potrace tracing failed:', err);
    }
  }

  async function maybePromptForViewRoles(detection, sourceImage) {
    if (!detection || !Array.isArray(detection.views) || detection.views.length < 2) return;
    if (!detection.viewRoleReviewRequired && !detection.views.some(v => !v.viewRole || v.viewRole === 'unknown')) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search || '');
    if (params.has('autoDraft') || params.has('smoke') || params.has('learningTests') || params.has('meaningTests') || params.has('evidenceTests') || params.has('golden') || params.has('accuracy') || params.has('invariants') || params.has('contract') || params.get('label') === '1') return;
    const roles = await askForViewRoles(detection, sourceImage);
    if (!roles || !roles.length) return;
    for (let i = 0; i < detection.views.length && i < roles.length; i += 1) {
      const role = roles[i] || 'unknown';
      detection.views[i].viewRole = role;
      detection.views[i].role = role;
      if (detection.viewBoxes && detection.viewBoxes[i]) {
        detection.viewBoxes[i].viewRole = role;
        detection.viewBoxes[i].role = role === 'front_outer' ? 'front' : role;
      }
    }
    syncDetectionRoleIndexes(detection);
    // The TD may have moved the back role to a different panel than the auto
    // pick. Back POM landmarks (POM 11/12/13/15) were detected on the auto back
    // box, so re-run that detection on the confirmed back box before anchors are
    // (re-)seeded. Cup/neckline/armhole (front-inner) anchors are box-relative
    // and follow the corrected role without re-detection.
    redetectBackLandmarks(detection);
    detection.viewRoleReviewRequired = false;
  }

  // Prefer the in-app dialog (thumbnails + one click per view); fall back to
  // the legacy letter-code window.prompt only where the dialog can't run
  // (no DOM dialog shell available, e.g. stripped-down test harnesses).
  async function askForViewRoles(detection, sourceImage) {
    if (typeof openViewRolesDialog === 'function' && typeof document !== 'undefined' && document.body) {
      return openViewRolesDialog({ views: detection.views, sourceImage });
    }
    if (typeof window.prompt !== 'function') return null;
    const current = detection.views
      .map((v, i) => (i + 1) + ':' + shortViewRole(v.viewRole || v.role || 'unknown'))
      .join(', ');
    const answer = window.prompt(
      'Confirm view roles. Use F=Front Outer, B=Back, I=Front Inner, U=Unknown.\n' +
      'Current: ' + current + '\n' +
      'Enter one letter per detected view, left to right:',
      detection.views.map(v => roleToPromptLetter(v.viewRole || v.role)).join('')
    );
    if (!answer) return null;
    const letters = String(answer).toUpperCase().replace(/[^FBIU]/g, '').split('');
    if (!letters.length) return null;
    const roleByLetter = { F: 'front_outer', B: 'back', I: 'front_inner', U: 'unknown' };
    return letters.map(l => roleByLetter[l] || 'unknown');
  }

  function roleToPromptLetter(role) {
    if (role === 'front_outer' || role === 'front') return 'F';
    if (role === 'back') return 'B';
    if (role === 'front_inner') return 'I';
    return 'U';
  }

  function shortViewRole(role) {
    if (role === 'front_outer' || role === 'front') return 'F';
    if (role === 'back') return 'B';
    if (role === 'front_inner') return 'I';
    return 'U';
  }

  function syncDetectionRoleIndexes(detection) {
    const views = detection.views || detection.viewBoxes || [];
    const roleAt = (role) => views.findIndex(v => v && (v.viewRole === role || v.role === role));
    detection.frontOuterViewIndex = roleAt('front_outer');
    detection.frontViewIndex = detection.frontOuterViewIndex;
    detection.backViewIndex = roleAt('back');
    detection.frontInnerViewIndex = roleAt('front_inner');
    detection.primaryViewIndex = detection.frontOuterViewIndex >= 0
      ? detection.frontOuterViewIndex
      : (detection.primaryViewIndex || 0);
  }

  // Read the ?cvDebug=1 flag once per detection and reflect it into state.
  // Lets a URL-flagged session capture intermediate detector data without
  // requiring the caller to also flip the flag through the debug API.
  // Skipped silently when window/URLSearchParams isn't available (Node tests).
  function syncCvDebugFromUrl() {
    if (typeof window === 'undefined' || !window.location) return;
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('cvDebug')) return;
      const raw = params.get('cvDebug');
      const on = raw === '1' || raw === 'true' || raw === 'on';
      if (state && state.autoMode && state.autoMode.cvDebug) {
        state.autoMode.cvDebug.enabled = on;
      }
    } catch (_) { /* no-op */ }
  }

  // Encode a binary ink mask (1 byte per pixel, row-major) as a base64
  // PNG data URL so the CV debug payload includes a visual mask the TD can
  // open in an image viewer. Dark pixels become black on white.
  function encodeMaskToPng(mask, w, h) {
    if (typeof document === 'undefined' || !mask || !w || !h) return null;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let p = 0, i = 0; p < mask.length; p += 1, i += 4) {
      const v = mask[p] ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    try { return off.toDataURL('image/png'); }
    catch (_) { return null; }
  }

  // Test-harness pin: ?freeCv=1 forces the deterministic FreeOpenCVAPI
  // backend. With opencv.js vendored (served same-origin from vendor/), the
  // harnesses' old `--host-resolver-rules=MAP docs.opencv.org …` CDN block
  // can no longer starve the real backend, so the pin must be explicit.
  // Read once per page load — the golden/accuracy/invariant/contract/demo
  // runners all append it to their target URL.
  const FORCE_FREE_CV = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('freeCv') === '1';

  // Prefer real opencv.js when its WASM has finished compiling; fall back
  // to the in-house FreeOpenCVAPI while the vendored script is still
  // loading (or if it failed). Both adapters return the same data shape,
  // so detectSketchFromImage() never branches on which one it got.
  function getCvApi() {
    if (typeof window === 'undefined') return null;
    if (FORCE_FREE_CV) return window.FreeOpenCVAPI || null;
    const real = window.RealOpenCVAPI;
    if (real && typeof real.isReady === 'function' && real.isReady()) return real;
    return window.FreeOpenCVAPI || null;
  }

  // -------- Segmentation adapter seam (Engineering Workflow Phase 3, item 4) --------
  //
  // A single, null-guarded plug point for a future SAM-like segmenter. The
  // contract mirrors the built-in ink-mask adapters (createInkMaskFromImage):
  // an adapter receives the source bitmap + options and returns the SAME ink
  // analysis shape { engine, width, height, total, mask, stats, threshold,
  // luminanceThreshold, backgroundLum, ... }. When registered it is tried
  // first in buildInkAnalysisFromImage and, on any failure or bad shape, the
  // pipeline falls back to OpenCV / legacy exactly as before.
  //
  // HARD OFFLINE RULE: an adapter MUST run fully locally. It may wrap a
  // vendored/WASM model, but it MUST NOT make any network call that carries
  // sketch or measurement data. Nothing here reaches the network; the default
  // is null, so the runtime is unchanged until a caller opts in.
  let externalSegmentationAdapter = null;
  function registerSegmentationAdapter(fn) {
    externalSegmentationAdapter = (typeof fn === 'function') ? fn : null;
    return !!externalSegmentationAdapter;
  }
  function clearSegmentationAdapter() { externalSegmentationAdapter = null; }
  function getSegmentationAdapter() { return externalSegmentationAdapter; }

  // Normalize the many possible ink-mask engine strings into a small, stable
  // set of backend ids so downstream code / debug summaries never have to
  // pattern-match version-stamped strings.
  function classifySegmentationBackend(engine) {
    const e = String(engine || '');
    if (/^real-opencv/.test(e)) return 'opencv-real';
    if (/^free-opencv/.test(e)) return 'opencv-free';
    if (/^offline-vision-legacy/.test(e)) return 'legacy';
    if (/^external/.test(e)) return 'external-adapter';
    if (/^synthetic/.test(e)) return 'synthetic';
    return e || 'unknown';
  }

  // Deterministic segmentation-quality score in [0,1], derived only from
  // signals the segmentation stage already computes. Same mask in → same
  // number out (no timing, no randomness). Low quality is a review signal,
  // not a failure: the mask still flows downstream, but callers can flag the
  // POMs for extra TD scrutiny.
  //
  // Sub-scores (each in [0,1]):
  //   coverage      — ink is a small-but-real fraction of the canvas; near-zero
  //                   means "found nothing", near-total means "flooded / frame".
  //   retention     — share of raw ink that survived component cleanup; a clean
  //                   line drawing keeps almost all of it, a noisy scan loses a
  //                   lot of speckle.
  //   fragmentation — few raw components is good; hundreds is speckle / dashes.
  //   presence      — at least one ink component survived cleanup.
  // A fail-open ink-cleanup revert halves the score (the mask may carry the
  // page frame / speckle the filter tried to strip).
  function computeSegmentationQuality(sig) {
    const coverage = Number.isFinite(sig.coverage) ? sig.coverage : 0;
    const retainedInk = Number.isFinite(sig.retainedInk) ? sig.retainedInk : 0;
    const componentCount = Number.isFinite(sig.componentCount) ? sig.componentCount : 0;
    const keptComponentCount = Number.isFinite(sig.keptComponentCount) ? sig.keptComponentCount : 0;
    const inkCleanupReverted = !!sig.inkCleanupReverted;

    const c01 = (v) => Math.max(0, Math.min(1, v));
    const rampUp = (v, lo, hi) => (hi <= lo ? (v >= hi ? 1 : 0) : c01((v - lo) / (hi - lo)));
    const rampDown = (v, lo, hi) => (hi <= lo ? (v <= lo ? 1 : 0) : c01((hi - v) / (hi - lo)));

    const coverageScore = Math.min(rampUp(coverage, 0.002, 0.01), rampDown(coverage, 0.35, 0.55));
    const retentionScore = rampUp(retainedInk, 0.45, 0.85);
    const fragScore = rampDown(componentCount, 60, 220);
    const presenceScore = keptComponentCount > 0 ? 1 : 0;

    let quality = c01(
      0.38 * coverageScore
      + 0.30 * retentionScore
      + 0.20 * fragScore
      + 0.12 * presenceScore
    );
    if (inkCleanupReverted) quality = c01(quality * 0.5);
    quality = Math.round(quality * 1e4) / 1e4;

    const reasons = [];
    if (coverage < 0.004) reasons.push('very little ink coverage — segmentation may have missed the garment');
    if (coverage > 0.45) reasons.push('very high ink coverage — segmentation may include the page frame or a fill');
    if (retainedInk < 0.5 && !inkCleanupReverted) reasons.push('component cleanup discarded a large share of the ink — noisy or fragmented source');
    if (componentCount > 160) reasons.push('many disconnected components — speckle or dashed line art');
    if (keptComponentCount === 0 && !inkCleanupReverted) reasons.push('no ink component survived cleanup');
    if (inkCleanupReverted) reasons.push('ink-cleanup revert fired — the outline may include page edges or speckle');

    const weak = inkCleanupReverted || quality < 0.45;
    return {
      quality,
      weak,
      reviewRequired: weak,
      reasons,
      subScores: {
        coverage: Math.round(coverageScore * 1e4) / 1e4,
        retention: Math.round(retentionScore * 1e4) / 1e4,
        fragmentation: Math.round(fragScore * 1e4) / 1e4,
        presence: presenceScore,
      },
    };
  }

  // Serializable view of the normalized segmentation-stage result: everything
  // except the raw mask typed array (the mask travels separately as
  // detection.inkMask, exposed by dimensions only so a JSON clone can't
  // explode it into one key per pixel).
  function serializeSegmentation(seg) {
    if (!seg) return null;
    const { mask, ...rest } = seg;
    return {
      ...rest,
      hasMask: !!mask,
    };
  }

  // Detection analysis resolution. Higher = better small-feature accuracy
  // (cleavage point, hook profile, strap attach) at the cost of CPU. Offline
  // detection is local so this trades CPU for accuracy, not latency or $.
  const DETECTION_TARGET_WIDTH = 1024;
  const DETECTION_DEFAULT_PARAMS = {
    bandSearchStartRatio: 0.58,
    bandPreferredRatio: 0.82,
    rowNoiseMultiplier: 1,
    colNoiseMultiplier: 1,
  };

  function getDefaultDetectionParams() {
    return { ...DETECTION_DEFAULT_PARAMS };
  }

  function normalizeDetectionParams(input) {
    const base = getDefaultDetectionParams();
    const src = input && typeof input === 'object' ? input : {};
    return {
      bandSearchStartRatio: clampNumber(src.bandSearchStartRatio, 0.50, 0.68, base.bandSearchStartRatio),
      bandPreferredRatio: clampNumber(src.bandPreferredRatio, 0.72, 0.90, base.bandPreferredRatio),
      rowNoiseMultiplier: clampNumber(src.rowNoiseMultiplier, 0.75, 1.25, base.rowNoiseMultiplier),
      colNoiseMultiplier: clampNumber(src.colNoiseMultiplier, 0.75, 1.25, base.colNoiseMultiplier),
    };
  }

  function activeDetectionParams(options) {
    const sources = [];
    if (!(options && options.skipLearningParams) && typeof getLearnedDetectionParams === 'function') {
      sources.push(getLearnedDetectionParams());
    }
    if (options && options.params) sources.push(options.params);
    return normalizeDetectionParams(Object.assign({}, ...sources));
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Side-effect-only: reads RGBA pixels off the source image via an offscreen
  // canvas. Returns the data the rest of the detection pipeline needs, with no
  // further dependency on the DOM. Split out of createLegacyInkAnalysis so the
  // pure pixel-math stages below can be unit-tested from Node without a canvas.
  function readSourceImagePixels(src, targetWidth) {
    const naturalW = src.naturalWidth || src.width || 0;
    const naturalH = src.naturalHeight || src.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');
    const TARGET_WIDTH = targetWidth || DETECTION_TARGET_WIDTH;
    const scale = Math.min(1, TARGET_WIDTH / naturalW);
    const w = Math.max(32, Math.round(naturalW * scale));
    const h = Math.max(32, Math.round(naturalH * scale));

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    if (!offCtx) throw new Error('offscreen canvas unavailable');
    offCtx.drawImage(src, 0, 0, w, h);

    let pixels;
    try {
      pixels = offCtx.getImageData(0, 0, w, h).data;
    } catch (err) {
      throw new Error('cannot read pixels (tainted canvas)');
    }
    return { pixels, width: w, height: h, naturalWidth: naturalW, naturalHeight: naturalH };
  }

  function createLegacyInkAnalysis(src, naturalW, naturalH) {
    const { pixels, width: w, height: h } = readSourceImagePixels(src);
    return pixelsToLegacyInkAnalysis(pixels, w, h);
  }

  // Pure ink-mask stage: rgba pixels → { mask, stats, threshold, ... }.
  // Takes a fixed Uint8ClampedArray + dimensions; returns deterministic output.
  // No DOM, no state, no globals — safe to call from a Node test harness.
  function pixelsToLegacyInkAnalysis(pixels, w, h) {
    const total = w * h;
    const lumGrid = new Uint8ClampedArray(total);
    const inkGrid = new Uint8ClampedArray(total);
    const lumHist = new Uint32Array(256);
    const inkHist = new Uint32Array(256);
    const background = estimateBorderBackground(pixels, w, h);
    for (let i = 0, p = 0; p < total; i += 4, p += 1) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const bgDiff = Math.max(0, background.lum - lum);
      const colorDiff = Math.hypot(r - background.r, g - background.g, b - background.b);
      const chromaInk = chroma > 18 && lum < background.lum - 6 ? chroma * 0.7 : 0;
      const ink = clamp(Math.round(Math.max(bgDiff, colorDiff * 0.78, chromaInk)), 0, 255);
      lumGrid[p] = lum;
      inkGrid[p] = ink;
      lumHist[lum] += 1;
      inkHist[ink] += 1;
    }

    const otsuInk = otsuThreshold(inkHist, total);
    const otsuLum = otsuThreshold(lumHist, total);
    const threshold = Math.max(22, Math.min(96, otsuInk));
    const luminanceThreshold = Math.max(55, Math.min(190, otsuLum - 8));
    const rawDark = new Uint8Array(total);
    for (let p = 0; p < total; p += 1) {
      const ink = inkGrid[p];
      const lum = lumGrid[p];
      const localInk = ink >= threshold;
      const darkByLum = lum < luminanceThreshold && background.lum - lum > 18;
      // (Dropped a dead `ink > threshold * 1.45` clause: localInk already
      // covers ink >= threshold, and threshold >= 22 > 0, so that term could
      // never be the deciding condition.)
      if (localInk || darkByLum) rawDark[p] = 1;
    }

    return {
      engine: 'offline-vision-legacy-threshold',
      width: w,
      height: h,
      total,
      mask: rawDark,
      stats: buildMaskStats(rawDark, w, h),
      threshold,
      luminanceThreshold,
      backgroundLum: Math.round(background.lum || 255),
    };
  }

  // detectSketchFromImage — offline shape analysis pipeline.
  //
  // Reads pixels into an offscreen canvas, estimates the paper/background,
  // builds an "ink" mask, removes speckle via connected components, groups
  // likely sketch views, then picks a primary view for landmark extraction.
  // Feature detection is still fully local: no API, no network, no model.
  //
  // All returned coordinates are normalized [0, 1] relative to the source
  // image's native pixel size so they travel with the image.
  // DOM I/O edge: builds the ink-mask analysis for the source image, either via
  // the OpenCV adapter (which reads the canvas itself) or via the pure
  // legacy-pixel pipeline. Returns the same { mask, stats, threshold, ... }
  // shape from either path so the rest of the pipeline never branches on it.
  function buildInkAnalysisFromImage(image) {
    const src = image.img;
    if (!src) throw new Error('image has no bitmap');
    const naturalW = src.naturalWidth || src.width || 0;
    const naturalH = src.naturalHeight || src.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');

    let cvAnalysis = null;
    // Record which backend ACTUALLY produced the mask so the components stage
    // can reuse the same one. getCvApi() can flip (real opencv.js finishes
    // compiling) between calls, so we must not re-pick later — see
    // detectSketchFromImage.
    let inkBackend = null;

    // Phase 3 seam: a registered SAM-like segmentation adapter gets first
    // refusal. Default is null (see registerSegmentationAdapter), so this
    // branch is skipped entirely in normal offline runs. An adapter mask keeps
    // the in-house components path (inkBackend stays null) unless the adapter
    // also exposes connectedComponentsWithStats — same rule as the legacy path.
    const adapter = getSegmentationAdapter();
    if (adapter) {
      try {
        const adapted = adapter(src, { targetWidth: DETECTION_TARGET_WIDTH, minSize: 32 });
        if (adapted && adapted.mask && adapted.stats) {
          cvAnalysis = adapted;
          if (!cvAnalysis.engine) cvAnalysis.engine = 'external-segmentation-adapter';
          inkBackend = (typeof adapted.connectedComponentsWithStats === 'function') ? adapted : null;
        }
      } catch (err) {
        console.warn('[Auto Mode] segmentation adapter failed; using built-in detector:', err);
        cvAnalysis = null;
        inkBackend = null;
      }
    }

    const cv = getCvApi();
    if (!cvAnalysis && cv && typeof cv.createInkMaskFromImage === 'function') {
      try {
        cvAnalysis = cv.createInkMaskFromImage(src, { targetWidth: DETECTION_TARGET_WIDTH, minSize: 32 });
        if (cvAnalysis && cvAnalysis.mask && cvAnalysis.stats) inkBackend = cv;
      } catch (err) {
        console.warn('[Auto Mode] OpenCV ink mask failed; using legacy detector:', err);
      }
    }
    if (!cvAnalysis || !cvAnalysis.mask || !cvAnalysis.stats) {
      // In-house pixel path → keep the components stage in-house too (null).
      cvAnalysis = createLegacyInkAnalysis(src, naturalW, naturalH);
      inkBackend = null;
    }
    cvAnalysis.inkBackend = inkBackend;
    return cvAnalysis;
  }

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

  // ---- Stage 2: segmentation (ink mask + connected-component cleanup) ----
  // Input: the ink analysis (mask + stats + thresholds) from
  // buildInkAnalysisFromImage. Output: the cleaned foreground mask (`dark`),
  // its stats, the kept components, and the raw fallbacks. Returns
  // { earlyReturn } when there is not enough ink to proceed.
  function segmentSketch(cvAnalysis, ctx) {
    const { cv, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;

    const w = cvAnalysis.width;
    const h = cvAnalysis.height;
    const total = cvAnalysis.total;
    const threshold = cvAnalysis.threshold;
    const luminanceThreshold = cvAnalysis.luminanceThreshold;
    const rawDark = cvAnalysis.mask;
    const rawStats = cvAnalysis.stats;
    _stageMark('inkMaskIngest');

    const backend = classifySegmentationBackend(cvAnalysis.engine);

    if (rawStats.maxX < 0 || rawStats.maxY < 0 || rawStats.count < 80) {
      // Too little ink to segment. Still emit a normalized (weak) segmentation
      // block so the "no detection" path is measurable rather than opaque.
      const emptyCoverage = rawStats.count / total;
      const emptyQuality = computeSegmentationQuality({
        coverage: emptyCoverage, retainedInk: 0,
        componentCount: 0, keptComponentCount: 0, inkCleanupReverted: false,
      });
      return {
        earlyReturn: {
          coverage: emptyCoverage, threshold, luminanceThreshold, stageTimingsMs,
          segmentation: {
            backend,
            engine: cvAnalysis.engine || null,
            componentsBackend: cv ? 'opencv' : 'inhouse',
            maskW: w, maskH: h,
            bbox: null,
            coverage: Number(emptyCoverage.toFixed(6)),
            rawCoverage: Number(emptyCoverage.toFixed(6)),
            retainedInk: 0,
            componentCount: 0,
            keptComponentCount: 0,
            inkCleanupReverted: false,
            emptyMask: true,
            ...emptyQuality,
          },
        },
      };
    }

    // ---- Stage: connected-component cleanup ----
    const minComponentCount = Math.max(8, Math.round(rawStats.count * 0.0015));
    let filtered;
    // Reuse the SAME backend that built the ink mask — the caller threads it in
    // via opts.cv (detectSketchFromImage passes cvAnalysis.inkBackend). Picking
    // a backend here with getCvApi() let opencv.js finish loading mid-pipeline
    // and feed a free-path mask into the real-backend component pass — an
    // untested, nondeterministic mixed path. One backend per detection keeps the
    // pipeline coherent and tuning meaningful.
    const componentsApi = cv;
    if (componentsApi && typeof componentsApi.connectedComponentsWithStats === 'function') {
      const cvComponents = componentsApi.connectedComponentsWithStats(rawDark, w, h, minComponentCount);
      filtered = {
        mask: cvComponents.mask,
        keptComponents: cvComponents.components || [],
        componentCount: cvComponents.componentCount || 0,
      };
    } else {
      filtered = filterInkComponents(rawDark, w, h, minComponentCount);
    }
    let dark = filtered.mask;
    let globalStats = buildMaskStats(dark, w, h);
    // D7: when this fail-open revert fires it restores the RAW mask, which can
    // re-introduce the scanned-page frame / speckle that component filtering
    // just stripped — contaminating bbox / axis / every normalized coord. Flag
    // it so the result carries a review hint instead of "succeeding" silently.
    let inkCleanupReverted = false;
    if (globalStats.count < Math.max(60, rawStats.count * 0.20)) {
      // If filtering was too aggressive, fall back to the raw mask. This keeps
      // faint/dashed sketches usable instead of failing closed.
      dark = rawDark;
      globalStats = rawStats;
      filtered.keptComponents = [];
      inkCleanupReverted = true;
    }

    _stageMark('connectedComponents');

    // ---- Normalized segmentation-stage output (Phase 3) ----
    // One shape for every backend (OpenCV real / free, in-house legacy, or a
    // registered adapter): the cleaned foreground mask, its bbox, a backend
    // id, and a deterministic quality score. The mask reference stays here for
    // in-process consumers; the serializable detection view drops it (the mask
    // travels as detection.inkMask, by dimensions only).
    const coverage = globalStats.count / total;
    const rawCoverage = rawStats.count / total;
    const retainedInk = rawStats.count > 0 ? globalStats.count / rawStats.count : 0;
    const componentCount = filtered.componentCount || 0;
    const keptComponentCount = (filtered.keptComponents || []).length;
    const segBbox = globalStats.maxX >= 0
      ? normalizeBounds(statsToBounds(globalStats), w, h)
      : null;
    const segQuality = computeSegmentationQuality({
      coverage, retainedInk, componentCount, keptComponentCount, inkCleanupReverted,
    });
    const segmentation = {
      backend,
      engine: cvAnalysis.engine || null,
      componentsBackend: cv ? 'opencv' : 'inhouse',
      mask: dark,
      maskW: w,
      maskH: h,
      bbox: segBbox,
      coverage: Number(coverage.toFixed(6)),
      rawCoverage: Number(rawCoverage.toFixed(6)),
      retainedInk: Number(retainedInk.toFixed(4)),
      componentCount,
      keptComponentCount,
      inkCleanupReverted,
      emptyMask: false,
      ...segQuality,
    };

    return {
      w, h, total, threshold, luminanceThreshold,
      rawDark, rawStats, dark, globalStats, filtered, inkCleanupReverted,
      segmentation,
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

  // Phase 4: normalize traced contour paths into a reusable curve-candidate
  // list. One classification pass shared by every downstream consumer (cup
  // inner seam, gore bottom, and future geometry/landmark curve reads) instead
  // of each re-scanning contours.paths ad hoc. Pure SHAPE evidence: bbox +
  // orientation + span flags + a back-reference to the source path index (full
  // samples remain available via samplePathPoints on demand, so this list stays
  // lean on the session-only detection object). No garment meaning is baked in.
  function buildContourCurveCandidates(traced, detection) {
    if (!traced || !Array.isArray(traced.paths)) return [];
    const axisX = detection && detection.axisX != null ? detection.axisX : null;
    const round6 = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    for (let i = 0; i < traced.paths.length; i += 1) {
      const p = traced.paths[i];
      const b = p && p.bbox;
      if (!b) continue;
      const width = b.width, height = b.height;
      const orientation = width >= height * 1.6 ? 'horizontal'
        : height >= width * 1.6 ? 'vertical'
        : 'arc';
      const minX = b.x, maxX = b.x + width;
      const spansAxisX = axisX != null && minX < axisX && maxX > axisX;
      out.push({
        id: i,
        pathIndex: i,
        bbox: { x: round6(b.x), y: round6(b.y), width: round6(width), height: round6(height) },
        orientation,
        lengthNorm: round6(Math.hypot(width, height)),
        spansAxisX,
        center: { x: round6(minX + width / 2), y: round6(b.y + height / 2) },
        segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
      });
    }
    return out;
  }

  // Phase 5: build the explicit VIEW-REGION facts. View classification is a
  // GEOMETRY decision (role + confidence per detected garment component) that is
  // produced here, in the geometry stage, BEFORE any anchor is placed — the seed
  // layer only READS these roles, it never re-derives them. Surfacing the
  // regions as a first-class list (with role, confidence, primary flag, and both
  // pixel + normalized bbox) makes that separation visible instead of implicit.
  // Pure restructuring of values classifySketchViewRoles already computed — no
  // numeric change to any role or bbox.
  function buildGeometryViewRegions(viewBoxesPx, viewClassification, primaryViewIndex, w, h) {
    const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1e3) / 1e3 : null);
    return (viewBoxesPx || []).map((box, index) => {
      const role = (viewClassification.roles && viewClassification.roles[index]) || 'unknown';
      const score = (viewClassification.scores && viewClassification.scores[index]) || null;
      const norm = normalizeBounds(box, w, h);
      return {
        index,
        role,
        viewRole: role,
        isPrimary: index === primaryViewIndex,
        roleConfidence: score && score.roleConfidence != null ? round3(score.roleConfidence) : null,
        centroidX: score ? round3(score.centroidX) : null,
        widthRatio: score ? round3(score.widthRatio) : null,
        bboxPx: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, count: box.count || 0 },
        bboxNorm: { x: norm.x, y: norm.y, width: norm.width, height: norm.height },
      };
    });
  }

  // ---- Stage 4: geometry analysis ----
  // Input: the segmentation stage output (cleaned + raw masks, stats,
  // components). Output: geometry facts in pixel space — view boxes and their
  // roles, the symmetry axis, band/chest/cradle/underbust rows, and the
  // side-seam columns. Still not the final POM decision. Returns
  // { earlyReturn } when the primary view has too little ink.
  function analyzeGeometry(seg, ctx) {
    const { detectionParams, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;
    // Phase 4: the contour-evidence bundle (endpoints / curve candidates /
    // stroke stats) is available here via ctx.contourEvidence so geometry can
    // read shape evidence without re-deriving it. Geometry decisions do not
    // consume it yet — wiring that in is Phase 5 — so output stays identical.
    const contourEvidence = ctx.contourEvidence || null;
    void contourEvidence;
    const {
      dark, rawDark, w, h, total, globalStats, filtered,
      threshold, luminanceThreshold,
    } = seg;

    // ---- Stage: view-box grouping + role classification ----
    let viewBoxesPx = detectSketchViewBoxes(filtered.keptComponents, globalStats, w, h);
    if (ctx.singleView) {
      // Auxiliary single-view photo (e.g. a front-inner cutaway): force ONE
      // view spanning ALL ink and skip the panel split. The split + front/back/
      // inner classifier is for multi-panel boards; on a lone cutaway the gore
      // gap and cup shading read as vertical alleys and carve it into 3 boxes,
      // so the "front" primary collapses onto a single cup and axis/apex/side
      // land in the wrong tenth of the image. One whole-garment box keeps the
      // symmetry axis centered and the cup/neckline/armhole landmarks correct.
      viewBoxesPx = [statsToBounds(globalStats)];
    } else {
      // Component grouping keys off horizontal gaps, so unevenly-spaced panels
      // can merge (a 3-panel board where two panels sit closer than the gap
      // threshold collapses into one double-wide box). Split any over-wide box
      // at its empty vertical alley so each garment panel gets its own view
      // box; the single lone-box case (two views bridged by stray ink) is
      // subsumed here.
      viewBoxesPx = splitWideViewBoxes(viewBoxesPx, dark, w, h);
    }
    // Flexible view-role classification. Supports a two-view layout
    // (front_outer + back) and a three-view layout (front_outer + back +
    // front_inner). Role metadata, rather than image position, drives later
    // POM placement.
    const viewClassification = classifySketchViewRoles(dark, w, h, viewBoxesPx);
    const symPrimaryIndex = choosePrimaryViewBox(viewBoxesPx, dark, w, h);
    const primaryViewIndex = viewClassification.frontOuterIndex >= 0
      ? viewClassification.frontOuterIndex
      : symPrimaryIndex;
    const primaryBounds = viewBoxesPx[primaryViewIndex] || statsToBounds(globalStats);
    let localStats = buildMaskStats(dark, w, h, primaryBounds);
    if (localStats.count < 80) localStats = globalStats;

    const colDark = localStats.colDark;
    const rowDark = localStats.rowDark;
    const darkCount = localStats.count;
    let minX = localStats.minX;
    let minY = localStats.minY;
    let maxX = localStats.maxX;
    let maxY = localStats.maxY;

    if (maxX < 0 || maxY < 0 || darkCount < 80) {
      return {
        earlyReturn: {
          coverage: globalStats.count / total, threshold, luminanceThreshold, stageTimingsMs,
          segmentation: seg.segmentation ? serializeSegmentation(seg.segmentation) : null,
        },
      };
    }
    _stageMark('viewBoxes');

    // Bounding box: pad by 1 pixel and clip.
    const padMinX = Math.max(0, minX - 1);
    const padMinY = Math.max(0, minY - 1);
    const padMaxX = Math.min(w - 1, maxX + 1);
    const padMaxY = Math.min(h - 1, maxY + 1);
    const bbox = {
      x: padMinX / w,
      y: padMinY / h,
      width: (padMaxX - padMinX + 1) / w,
      height: (padMaxY - padMinY + 1) / h,
    };
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;

    // ---- Stage: center axis (centroid candidate → symmetry-refined) ----
    let xSum = 0, xWeight = 0;
    for (let x = minX; x <= maxX; x += 1) {
      xSum += x * colDark[x];
      xWeight += colDark[x];
    }
    const centroidX = xWeight > 0 ? xSum / xWeight : (minX + maxX) / 2;
    const axisXpx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const axisX = axisXpx / w;
    const symmetry = computeSymmetryScore(dark, w, axisXpx, minX, maxX, minY, maxY);

    _stageMark('centerAxis');

    // ---- Stage: horizontal features (band, chest, cradle, underbust) ----
    const rowSmooth = smooth1D(rowDark);
    const rowSpan = computeRowSpans(dark, w, minX, maxX, minY, maxY);
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const medianRow = approxMedianNonZero(rowDark, minY, maxY);
    const rowNoiseFloor = Math.max(5, medianRow) * detectionParams.rowNoiseMultiplier;
    const rowPeakScore = (y, preferredY, spread) => {
      const spanNorm = clamp01(rowSpan[y] / Math.max(1, bboxW));
      const base = rowSmooth[y] * (0.58 + spanNorm * 0.42);
      if (preferredY == null) return base;
      const pos = 1 - Math.min(1, Math.abs(y - preferredY) / Math.max(1, spread));
      return base * (0.82 + pos * 0.18);
    };

    // Band: long horizontal ink near the bottom, not just the single darkest row.
    const bandStart = Math.round(minY + bboxH * detectionParams.bandSearchStartRatio);
    let bandRow = -1;
    let bandStrength = 0;
    const bandPreferred = minY + bboxH * detectionParams.bandPreferredRatio;
    for (let y = bandStart; y <= maxY; y += 1) {
      const score = rowPeakScore(y, bandPreferred, bboxH * 0.22);
      if (score > bandStrength) {
        bandStrength = score;
        bandRow = y;
      }
    }
    // bandRow is the band ZONE (used below to bound cup/cradle searches).
    // bandEdgeRow snaps to the solid bottom edge for the band ANCHORS only, so
    // the bottom-band and CF-bottom land on the real edge without disturbing the
    // cup detection that keys off the zone.
    const bandEdgeRow = snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bboxW, bboxH);
    const bandY = bandEdgeRow >= 0 ? bandEdgeRow / h : (minY + maxY) / 2 / h;

    // Chest: long row in the upper cup/underarm zone. Skip the top few rows
    // so straps or page crop marks don't win.
    const chestStart = Math.round(minY + bboxH * 0.08);
    const chestEnd = Math.round(minY + bboxH * 0.50);
    let chestRow = -1;
    let chestStrength = 0;
    const chestPreferred = minY + bboxH * 0.30;
    for (let y = chestStart; y <= chestEnd; y += 1) {
      const score = rowPeakScore(y, chestPreferred, bboxH * 0.26);
      if (score > chestStrength) {
        chestStrength = score;
        chestRow = y;
      }
    }
    const chestY = (chestRow >= 0 && chestStrength > rowNoiseFloor * 1.5)
      ? chestRow / h : null;

    // Cradle / cup-bottom — peak between chest and band, separated from each
    // by at least 5% of bbox height. Used to seed inner-cup-bottom.
    const peakSep = Math.max(4, Math.round(bboxH * 0.05));
    const cradleLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.40)) + peakSep;
    const cradleHi = bandRow - peakSep;
    let cradleRow = -1;
    let cradleStrength = 0;
    for (let y = cradleLo; y <= cradleHi; y += 1) {
      const score = rowPeakScore(y, minY + bboxH * 0.64, bboxH * 0.24);
      if (score > cradleStrength) {
        cradleStrength = score;
        cradleRow = y;
      }
    }
    const cradleY = (cradleRow >= 0 && cradleStrength > rowNoiseFloor * 1.3)
      ? cradleRow / h : null;

    // Chest line (POM 3): the horizontal row in the cup zone where the
    // sketch's outline is widest. In a flat technical sketch this row is
    // (a) the cup-bottom seam (a solid line), OR (b) the bust-point row where
    // the cup outline is at its widest horizontal extent — both register as
    // "row with max left-to-right ink span". We search BETWEEN the upper
    // chest peak and the band, so the band itself isn't a candidate. The
    // preference pulls us toward ~62% bbox height where the cup widens.
    const underbustLo = (chestRow > 0 ? chestRow : Math.round(minY + bboxH * 0.30)) + peakSep;
    const underbustHi = (bandRow > 0 ? bandRow : maxY) - peakSep;
    let underbustRow = -1;
    let underbustStrength = 0;
    const underbustPreferred = minY + bboxH * 0.62;
    const underbustSpread = Math.max(1, bboxH * 0.28);
    const minRowSpan = Math.max(20, Math.round(bboxW * 0.70));
    for (let y = underbustLo; y <= underbustHi; y += 1) {
      const span = rowSpan[y];
      if (span < minRowSpan) continue;
      // Solidity: a real underbust seam is ONE long contiguous run, while a
      // lace band is a wide row made of many short dashes. runFrac rewards
      // solid rows so the seam beats a wider-but-fragmented lace band.
      const runFrac = clamp01(rowRun[y] / Math.max(1, span));
      const pos = 1 - Math.min(1, Math.abs(y - underbustPreferred) / underbustSpread);
      const score = span * (0.55 + 0.45 * runFrac) * (0.7 + pos * 0.3);
      if (score > underbustStrength) {
        underbustStrength = score;
        underbustRow = y;
      }
    }
    const underbustRunPx = underbustRow >= 0 ? rowRun[underbustRow] : 0;
    const underbustY = underbustRow >= 0 ? underbustRow / h : null;

    _stageMark('horizontalFeatures');

    // ---- Stage: vertical features (side seams) ----
    // Scan the FULL bbox height (minY → bandRow), not just chestRow → bandRow.
    // On longline / high-cut / plunge styles the side seam extends well above
    // the chest line; clipping the scan at chestRow throws away the bulk of
    // that ink and the real edge column never beats the noise floor.
    const seamTop = minY;
    const seamBottom = bandRow > 0 ? bandRow : maxY;
    const colTorso = countDarkByColumnInRange(dark, w, minX, maxX, seamTop, seamBottom);
    const colSmooth = smooth1D(colTorso);
    // Noise floor from the inner 20–80% of columns only. On 3-part cups or
    // styles with heavy internal construction (cup seams, underwire channels)
    // every column carries ink — taking the median across the full bbox width
    // inflates the floor and kills the thin outer edge signal. The inner band
    // captures "construction density" without poisoning the floor with the
    // outer silhouette itself.
    const innerLo = minX + Math.round(bboxW * 0.20);
    const innerHi = minX + Math.round(bboxW * 0.80);
    const medianCol = approxMedianNonZero(colTorso, innerLo, innerHi);
    const colNoiseFloor = Math.max(4, medianCol) * detectionParams.colNoiseMultiplier;
    // Keep a guard band around the axis so the center-front seam doesn't win.
    const axisGuard = Math.max(4, Math.round(bboxW * 0.08));
    const axisPx = Math.round(axisXpx);
    // Edge-proximity prior: rewards columns near bbox left/right edges so the
    // outer silhouette outscores interior cup seams (side-panel attach lines)
    // even when those carry more total ink. Linear falloff over a half-width;
    // beyond 50% of bboxW from the relevant edge the bonus is zero.
    const edgeBiasMax = 0.45;
    const colPeakScore = (x, edgePx) => {
      const axisDist = Math.abs(x - axisPx) / Math.max(1, bboxW);
      const edgeDist = Math.abs(x - edgePx) / Math.max(1, bboxW);
      const edgeBias = 1 + edgeBiasMax * Math.max(0, 1 - edgeDist * 2);
      return colSmooth[x] * (0.78 + Math.min(1, axisDist * 2.2) * 0.22) * edgeBias;
    };

    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      const score = colPeakScore(x, minX);
      if (score > sideLeftStrength) {
        sideLeftStrength = score;
        sideLeftCol = x;
      }
    }
    const sideLeftX = (sideLeftCol > 0 && sideLeftStrength > colNoiseFloor * 1.3)
      ? sideLeftCol / w : null;

    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      const score = colPeakScore(x, maxX);
      if (score > sideRightStrength) {
        sideRightStrength = score;
        sideRightCol = x;
      }
    }
    const sideRightX = (sideRightCol > 0 && sideRightStrength > colNoiseFloor * 1.3)
      ? sideRightCol / w : null;

    _stageMark('verticalFeatures');

    // ---- Explicit geometry facts (Engineering Workflow Phase 5, items 1-2) ----
    // Make the frame geometry a first-class, self-describing output: center
    // axis, band line, the horizontal construction rows, the side-seam columns,
    // and the classified view regions — each in BOTH image-pixel and normalized
    // [0,1] space. This is a pure surfacing of values already computed above; no
    // detected coordinate changes, so anchors (and golden) are untouched. The
    // semantic-part facts (cup / strap / seam / back-panel candidates) and the
    // geometry-quality/review verdict are completed in the landmark stage, where
    // those parts exist — see detectLandmarks, which extends this same object.
    const sigConfLocal = (peak, floor) => clamp01((peak - floor) / Math.max(1, floor * 2));
    const geometryFacts = {
      space: 'image-pixel + normalized[0,1]',
      bbox: { ...bbox },
      bboxPx: { minX, minY, maxX, maxY, width: bboxW, height: bboxH },
      symmetryAxis: {
        xPx: Math.round(axisXpx),
        xNorm: axisX,
        symmetry,
        confidence: clamp01(symmetry),
      },
      bandLine: {
        yPx: bandEdgeRow >= 0 ? bandEdgeRow : null,
        yNorm: bandY,
        zoneRowPx: bandRow,
        strength: bandStrength,
        confidence: sigConfLocal(bandStrength, rowNoiseFloor),
      },
      horizontalLines: {
        chest: chestY != null ? { yPx: chestRow, yNorm: chestY, strength: chestStrength } : null,
        cradle: cradleY != null ? { yPx: cradleRow, yNorm: cradleY, strength: cradleStrength } : null,
        underbust: underbustY != null
          ? { yPx: underbustRow, yNorm: underbustY, runPx: underbustRunPx } : null,
      },
      sideSeamColumns: {
        left: sideLeftX != null
          ? { xPx: sideLeftCol, xNorm: sideLeftX, strength: sideLeftStrength } : null,
        right: sideRightX != null
          ? { xPx: sideRightCol, xNorm: sideRightX, strength: sideRightStrength } : null,
      },
      viewRegions: buildGeometryViewRegions(viewBoxesPx, viewClassification, primaryViewIndex, w, h),
      viewClassification: {
        primaryViewIndex,
        frontOuterIndex: viewClassification.frontOuterIndex,
        frontInnerIndex: viewClassification.frontInnerIndex,
        backIndex: viewClassification.backIndex,
        reviewRequired: !!viewClassification.reviewRequired,
      },
    };

    return {
      dark, rawDark, w, h, total, filtered, globalStats,
      threshold, luminanceThreshold,
      viewBoxesPx, viewClassification, primaryViewIndex, darkCount,
      minX, minY, maxX, maxY, bbox, bboxW, bboxH,
      axisXpx, axisX, symmetry, axisPx,
      rowNoiseFloor, colNoiseFloor,
      bandStart, bandRow, bandStrength, bandPreferred, bandEdgeRow, bandY,
      chestRow, chestStrength, chestY,
      peakSep, cradleRow, cradleStrength, cradleY,
      underbustRow, underbustStrength, minRowSpan, underbustRunPx, underbustY,
      medianRow, medianCol, innerLo, innerHi, axisGuard,
      sideLeftCol, sideLeftStrength, sideLeftX,
      sideRightCol, sideRightStrength, sideRightX,
      geometryFacts,
    };
  }

  // ---- Stage 5: landmark construction (+ confidence + assembly) ----
  // Input: segmentation output, geometry facts, and the contour/topology map.
  // Output: the assembled detection result the rest of the app consumes —
  // apex/strap/inner-cup/side/back landmarks, the cup model, per-feature
  // confidence, overall quality, seam evidence, view metadata, and (when
  // requested) the layered CV-debug payload. Landmarks carry technical
  // meaning; normalization to anchors happens later in the anchor seed layer.
  function detectLandmarks(cvAnalysis, seg, geometry, contours, ctx) {
    const { detectionParams, debugEnabled, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;
    const { rawStats, inkCleanupReverted, segmentation } = seg;
    // Contour-evidence bundle (Phase 4). junctionMap keeps the unchanged
    // detection.junctions / junctionSummary contract; endpoints / corners /
    // strokeStats are the reusable shape evidence, exposed additively.
    const { junctionMap } = contours;
    const contourEndpoints = contours.endpoints || [];
    const contourCorners = contours.corners || [];
    const contourStrokeStats = contours.strokeStats || null;
    const {
      dark, rawDark, w, h, total, filtered, globalStats,
      threshold, luminanceThreshold,
      viewBoxesPx, viewClassification, primaryViewIndex, darkCount,
      minX, minY, maxX, maxY, bbox, bboxW, bboxH,
      axisXpx, axisX, symmetry, axisPx,
      rowNoiseFloor, colNoiseFloor,
      bandStart, bandRow, bandStrength, bandPreferred, bandEdgeRow, bandY,
      chestRow, chestStrength, chestY,
      peakSep, cradleRow, cradleStrength, cradleY,
      underbustRow, underbustStrength, minRowSpan, underbustRunPx, underbustY,
      medianRow, medianCol, innerLo, innerHi, axisGuard,
      sideLeftCol, sideLeftStrength, sideLeftX,
      sideRightCol, sideRightStrength, sideRightX,
      geometryFacts,
    } = geometry;

    // ---- Stage: apex + strap landmarks ----
    const bounds = { minX, minY, maxX, maxY };
    const apexLeftCandidate = findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, -1);
    const apexRightCandidate = findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, +1);
    const apexPair = validateCupApexPair(apexLeftCandidate, apexRightCandidate, bounds, w, h);
    const apexLeftInfo = apexPair ? apexPair.left : null;
    const apexRightInfo = apexPair ? apexPair.right : null;
    const apexLeft = apexLeftInfo ? apexLeftInfo.point : null;
    const apexRight = apexRightInfo ? apexRightInfo.point : null;
    // Inner-edge apex points (POM 16 measures inner-edge to inner-edge of the
    // cup/front-strap joining seams). Falls back to the join center when the
    // ink run didn't yield an inner edge.
    const apexLeftInner = (apexLeftInfo && apexLeftInfo.innerEdgeX != null)
      ? { x: apexLeftInfo.innerEdgeX, y: apexLeftInfo.point.y }
      : apexLeft;
    const apexRightInner = (apexRightInfo && apexRightInfo.innerEdgeX != null)
      ? { x: apexRightInfo.innerEdgeX, y: apexRightInfo.point.y }
      : apexRight;
    // Outer-edge apex points (POM 14's fallback strap join sits on the OUTER
    // edge of the cup/strap join — ADR 0017, TD correction 2026-07-10).
    const apexLeftOuter = (apexLeftInfo && apexLeftInfo.outerEdgeX != null)
      ? { x: apexLeftInfo.outerEdgeX, y: apexLeftInfo.point.y }
      : apexLeft;
    const apexRightOuter = (apexRightInfo && apexRightInfo.outerEdgeX != null)
      ? { x: apexRightInfo.outerEdgeX, y: apexRightInfo.point.y }
      : apexRight;
    const strapInfo = findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow);
    // POM 14 starts at the upper joining seam of the stitched section of the
    // FRONT RIGHT shoulder strap (TD-corrected, ADR 0016: the strap adjacent
    // to the back view, so the drawn curve follows one continuous strap over
    // the shoulder). This is a separate semantic landmark from strapInfo.top
    // (the topmost strap ink) and from the back strap/panel join.
    const frontStrapStartInfo = findFrontStrapStartFromInk(
      dark, w, h, bounds, apexRightInfo || apexLeftInfo, chestRow);

    _stageMark('apexStrap');

    // ---- Stage: inner-cup top + side-seam top (audit POMs 9, 10, 11) ----
    const innerCupTopInfo = findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow);
    const sideTopLeftInfo = findSideTopFromInk(dark, w, h, bounds, sideLeftCol, chestRow, -1);
    const sideTopRightInfo = findSideTopFromInk(dark, w, h, bounds, sideRightCol, chestRow, +1);
    const sideBottomRightInfo = sideTopRightInfo
      ? findSideBottomFromInk(dark, w, h, bounds, sideTopRightInfo.point)
      : null;

    _stageMark('innerCupAndSideTop');

    // ---- Stage: front-view ink endpoints (chest L/R, band L/R, CF top) ----
    // The pipeline already detects chest/band ROWS from ink; walk along those
    // rows to find the ink ENDPOINTS too so chest-left/right and band-left/
    // right snap to actual line ends instead of view-box corners.
    const halfRowBand = Math.max(2, Math.round(bboxH * 0.012));
    const halfColBand = Math.max(2, Math.round(bboxW * 0.018));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, maxX, minX, -1) : -1;
    const underbustLeftPx  = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, minX, maxX, +1) : -1;
    const underbustRightPx = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, maxX, minX, -1) : -1;
    const cfTopPx      = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const chestLeftX  = chestLeftPx  > 0 ? chestLeftPx  / w : null;
    const chestRightX = chestRightPx > 0 ? chestRightPx / w : null;
    const bandLeftX   = bandLeftPx   > 0 ? bandLeftPx   / w : null;
    const bandRightX  = bandRightPx  > 0 ? bandRightPx  / w : null;
    const underbustLeftX  = underbustLeftPx  > 0 ? underbustLeftPx  / w : null;
    const underbustRightX = underbustRightPx > 0 ? underbustRightPx / w : null;
    const cfTopY      = cfTopPx      >= 0 ? cfTopPx     / h : null;

    // ---- Cradle-at-CF (POM 6 top endpoint) ----
    // POM 6 measures the cradle / cup-bottom seam height at center front. Per
    // rule.md POM 6 Contract, the start point must come from REAL cradle /
    // cup-bottom seam evidence (not "any ink near cradleRow × axis"). The same
    // Medium evidence pattern from POM 7 §3 applies: clear cradle seam at the
    // axis plus a clean baseline projection beneath it.
    //
    // The CF vertical line trivially inks the column from cf-top to cf-bottom,
    // so a column-ratio / dashed-guide check (POM 7 patterns 1 & 2) would
    // always trip here and give zero discrimination. We instead measure the
    // HORIZONTAL run of the cradle seam across the CF axis — the cradle/
    // cup-bottom seam approaches CF as a horizontal seam extending ~15%+ of
    // bboxW. A decorative tick, a stray ink crossing, or the CF vertical line
    // itself contributes only 1-2 inked columns in this scan.
    //
    // Guards:
    //   - cradleY detected (cradleStrength > rowNoiseFloor * 1.3)
    //   - bandRow detected (POM 6 end must project onto a real baseline)
    //   - row sits strictly below chest/underbust and above band
    //   - row sits well below cf-top so the seam is plausibly a cradle, not a
    //     decorative neckline tick (rule.md: "start is actually CF top, …")
    //   - cradle-row ink inside a small window straddling axisX (seed sanity)
    //   - HORIZONTAL seam continuity at cradleRow ± 1 around axisPx ≥ threshold
    //   - band-row ink at axisPx (baseline projection)
    // When any guard fails the anchor is NOT seeded and POM 6 is forced to
    // REVIEW_ONLY downstream — no ratio fallback.
    let cradleCfTop = null;
    let cradleCfTopInkRatio = 0;
    let cradleCfTopBandInkRatio = 0;
    let cradleCfTopSeamHorizontalRun = 0;
    let cradleCfTopSeamSingleRowRun = 0;
    let cradleCfTopReject = null;
    // True when cradle-cf-top was accepted via the CF-gore dip path (seam
    // crosses CF but the exact axis cell is empty). Downstream tagging drops
    // this anchor to low confidence + reviewRequired.
    let cradleCfTopDipProjected = false;
    // Nearest inked seam column (gap in px) to the CF axis on each side, from
    // the horizontal-continuity scan. -1 when no inked column on that side.
    let cradleCfSeamLeftReachPx = -1;
    let cradleCfSeamRightReachPx = -1;
    if (cradleRow < 0 || cradleStrength <= rowNoiseFloor * 1.3) {
      cradleCfTopReject = 'no cradle row detected';
    } else if (bandRow < 0) {
      cradleCfTopReject = 'no band row detected (POM 6 end cannot be projected)';
    } else {
      const chestGuardRow = chestRow > 0 ? chestRow : (underbustRow > 0 ? underbustRow : -1);
      const aboveBand = cradleRow <= bandRow - peakSep;
      const belowChest = chestGuardRow > 0 ? cradleRow >= chestGuardRow + peakSep : true;
      const cfTopGuardPx = Math.max(peakSep * 2, Math.round(bboxH * 0.15));
      const farFromCfTop = cfTopPx >= 0 ? (cradleRow - cfTopPx) >= cfTopGuardPx : true;
      if (!aboveBand) cradleCfTopReject = 'cradle row too close to band';
      else if (!belowChest) cradleCfTopReject = 'cradle row too close to chest';
      else if (!farFromCfTop) cradleCfTopReject = 'cradle row too close to CF top';
      else {
        const ySpan = 2;
        const xSpan = Math.max(6, Math.round(bboxW * 0.06));
        const yLo = Math.max(0, cradleRow - ySpan);
        const yHi = Math.min(h - 1, cradleRow + ySpan);
        const xLo = Math.max(0, axisPx - xSpan);
        const xHi = Math.min(w - 1, axisPx + xSpan);
        let ink = 0;
        let win = 0;
        for (let y = yLo; y <= yHi; y += 1) {
          for (let x = xLo; x <= xHi; x += 1) {
            win += 1;
            if (dark[y * w + x]) ink += 1;
          }
        }
        cradleCfTopInkRatio = win > 0 ? ink / win : 0;

        // Baseline projection: require band-row ink at the CF axis.
        const yBandSpan = Math.max(2, Math.round(bboxH * 0.012));
        const yBandLo = Math.max(0, bandRow - yBandSpan);
        const yBandHi = Math.min(h - 1, bandRow + yBandSpan);
        let bandInk = 0, bandWin = 0;
        for (let y = yBandLo; y <= yBandHi; y += 1) {
          for (let x = xLo; x <= xHi; x += 1) {
            bandWin += 1;
            if (dark[y * w + x]) bandInk += 1;
          }
        }
        cradleCfTopBandInkRatio = bandWin > 0 ? bandInk / bandWin : 0;

        // Horizontal cradle-seam continuity around the CF axis. Measure the
        // longest run of inked columns at cradleRow ± 1 (3-row band tolerates
        // anti-aliasing) AND at the exact cradleRow inside a wide window. A
        // real cradle seam crosses CF for 15-40% of bboxW; a cup-outline
        // tangent, decorative tick, or the CF vertical line all contribute
        // only a handful of columns. Use the RAW mask so dashed/light seam
        // ink isn't filtered out by the component-size floor.
        const runWin = Math.max(20, Math.round(bboxW * 0.22));
        const runLo = Math.max(0, axisPx - runWin);
        const runHi = Math.min(w - 1, axisPx + runWin);
        const runYLo = Math.max(0, cradleRow - 1);
        const runYHi = Math.min(h - 1, cradleRow + 1);
        // Axis-bridging evidence for the CF-gore dip case. A real cradle /
        // underwire seam approaches CF from BOTH sides and only breaks inside
        // the narrow center-front gore (where the two cups meet and no seam
        // ink is drawn). We record how close the seam's inked columns come to
        // the CF axis from the left and from the right. When the seam brackets
        // the axis with only a small gore gap on each side, the seam clearly
        // crosses CF even though the exact axis window reads empty. A seam that
        // lives entirely on one side (a cup-bottom arm, a stray tick) reaches
        // the axis from at most one direction and is NOT bridging. These two
        // reach counters are declared in the outer scope above.
        //
        // Build the per-column inked-band map ONCE (raw 3-row band), then derive
        // every piece of evidence from it. D6: derive the reaches from a column
        // that belongs to a SOLID run (≥ minReachRun contiguous inked columns),
        // not the nearest lone inked pixel — a single anti-aliased pixel near the
        // gore otherwise shifts a reach by 1px and can flip symmetricReach
        // run-to-run. The min-run is the hysteresis. Horizontal-run and
        // single-row-run discriminators are unchanged.
        const colCount = runHi - runLo + 1;
        const bandInked = new Array(Math.max(0, colCount)).fill(false);
        for (let xi = 0; xi < colCount; xi += 1) {
          const x = runLo + xi;
          for (let y = runYLo; y <= runYHi; y += 1) {
            if (rawDark[y * w + x]) { bandInked[xi] = true; break; }
          }
        }
        // Longest contiguous inked run in the 3-row band.
        let currentRun = 0;
        for (let xi = 0; xi < colCount; xi += 1) {
          if (bandInked[xi]) {
            currentRun += 1;
            if (currentRun > cradleCfTopSeamHorizontalRun) cradleCfTopSeamHorizontalRun = currentRun;
          } else {
            currentRun = 0;
          }
        }
        // Longest contiguous inked run at the EXACT cradle row.
        let currentSingle = 0;
        for (let x = runLo; x <= runHi; x += 1) {
          if (rawDark[cradleRow * w + x]) {
            currentSingle += 1;
            if (currentSingle > cradleCfTopSeamSingleRowRun) cradleCfTopSeamSingleRowRun = currentSingle;
          } else {
            currentSingle = 0;
          }
        }
        // Reaches: nearest column to the CF axis that belongs to a solid seam
        // run (≥ minReachRun), scanning each maximal run once it closes. Set to
        // 2 so a single isolated anti-aliased pixel (run length 1) can't define
        // a reach — the run-to-run flip source — while a genuine thin/dashed
        // gore seam (demo7's tuned dip win) still counts.
        const minReachRun = 2;
        let runStart = -1;
        for (let xi = 0; xi <= colCount; xi += 1) {
          const inked = xi < colCount && bandInked[xi];
          if (inked) {
            if (runStart < 0) runStart = xi;
          } else if (runStart >= 0) {
            if (xi - runStart >= minReachRun) {
              for (let k = runStart; k < xi; k += 1) {
                const x = runLo + k;
                if (x <= axisPx) {
                  const gap = axisPx - x;
                  if (cradleCfSeamLeftReachPx < 0 || gap < cradleCfSeamLeftReachPx) cradleCfSeamLeftReachPx = gap;
                }
                if (x >= axisPx) {
                  const gap = x - axisPx;
                  if (cradleCfSeamRightReachPx < 0 || gap < cradleCfSeamRightReachPx) cradleCfSeamRightReachPx = gap;
                }
              }
            }
            runStart = -1;
          }
        }
        // Discriminator thresholds. We need to reject:
        //   - the CF vertical line crossing cradleRow alone (~1-2 inked cols)
        //   - decorative ticks crossing cradleRow (~3-5 inked cols)
        //   - stray sparse noise (~< 6 inked cols)
        // while accepting real cradle seams that may curve at the CF dip
        // (only ~10-15 contiguous inked cols at cradleRow in some styles).
        //
        // Thresholds count inked COLUMNS on the analysis grid. That grid is the
        // fixed 1024 px target ONLY when the source is ≥ 1024 px wide; a smaller
        // upload is analysed at its native width (scale is capped at 1), so the
        // same physical seam spans fewer sample columns. D2: scale the absolute
        // column thresholds by gridScale = w / 1024 so a seam of a given real
        // width clears the same fraction regardless of source resolution — and
        // gridScale is exactly 1 for every ≥ 1024 px source, leaving their
        // detection unchanged. We still do NOT scale by bboxW: seam-ink width is
        // style-dependent, not garment-size-dependent, at a fixed grid.
        //
        // EITHER pathway also accepts: a dense local ink ratio (≥ 0.20) at
        // (axisPx, cradleRow) — the cradle seam IS at the axis cell, even if
        // its horizontal arm is short. BUT require a minimum horizontal
        // extent (≥ 3 inked columns at the exact cradle row) so an isolated
        // decorative blob (bow/nơ centered on the CF axis at the cradle row,
        // typically 1-2 columns wide) cannot pass — rule.md: "start is
        // actually CF top, neckline, or decorative tick" reject reason.
        // Round UP (ceil): rounding a rejection threshold DOWN would let a
        // feature just under the true scaled bar (e.g. a 3-col decorative tick
        // at a 640px grid, where 5*0.625 = 3.125) slip through as a seam. Ceil
        // keeps the discrimination margin on the reject side; at a ≥1024 source
        // gridScale is 1 so these equal the original 8 / 5 / 3.
        const gridScale = w / DETECTION_TARGET_WIDTH;
        const minBandRun = Math.max(3, Math.ceil(8 * gridScale));
        const minSingleRun = Math.max(2, Math.ceil(5 * gridScale));
        const minDenseSingleRun = Math.max(2, Math.ceil(3 * gridScale));
        const seamRunOK = (cradleCfTopSeamHorizontalRun >= minBandRun)
                          || (cradleCfTopSeamSingleRowRun >= minSingleRun);
        const denseLocalInk = cradleCfTopInkRatio >= 0.20
          && cradleCfTopSeamSingleRowRun >= minDenseSingleRun;
        const seamStrong = seamRunOK || denseLocalInk;

        // CF-gore dip: the seam clearly crosses CF (a strong contiguous run
        // that brackets the axis SYMMETRICALLY from both sides) but no ink sits
        // in the exact axis window, because the two cups separate at center
        // front and the seam is not drawn across the narrow gore. This is a
        // real cradle / underwire seam whose CF endpoint we must PROJECT onto
        // the axis rather than reject outright. Empirically (demo3/demo7) the
        // seam retreats from CF by ~9-13% of bbox width on BOTH sides by nearly
        // the SAME amount — the tell-tale of a symmetric gore, as opposed to a
        // one-sided cup-bottom arm (which inks only one side, or reaches the
        // two sides by very different amounts). We accept only under strict
        // guards, and downstream tag the anchor low-confidence + reviewRequired
        // so the TD verifies the projected start:
        //   - the exact axis window is empty (what makes this a "dip", not a
        //     normally-inked seam that the primary path already handles),
        //   - a strong seam RUN exists (reuse the seamRunOK evidence; a long
        //     run, not a stray tick),
        //   - inked seam ink brackets the axis from BOTH sides,
        //   - the two reaches are near-symmetric (|L − R| ≤ symTolPx): a
        //     genuine gore dip retreats evenly; a one-sided arm does not,
        //   - the wider reach is still bounded to the CF zone (≤ maxGorePx =
        //     16% of bbox width — the same scale POM 7 uses to hold its
        //     bottom-cup line OFF the CF axis), so we never re-label a POM 7
        //     bottom-cup arc as a CF seam,
        //   - a baseline projection still requires band-row ink under the axis
        //     (unchanged cradleCfTopBandInkRatio gate) so POM 6's bottom is
        //     never drawn onto an empty baseline (this correctly leaves demo5,
        //     whose CF band ink is zero, as REVIEW_ONLY).
        const symTolPx = Math.max(6, Math.round(bboxW * 0.04));
        const maxGorePx = Math.round(bboxW * 0.16);
        const bothSidesReach = cradleCfSeamLeftReachPx >= 0 && cradleCfSeamRightReachPx >= 0;
        const symmetricReach = bothSidesReach
          && Math.abs(cradleCfSeamLeftReachPx - cradleCfSeamRightReachPx) <= symTolPx;
        const reachBounded = bothSidesReach
          && Math.max(cradleCfSeamLeftReachPx, cradleCfSeamRightReachPx) <= maxGorePx;
        const seamBridgesAxis = seamRunOK && symmetricReach && reachBounded;

        if (cradleCfTopInkRatio < 0.05) {
          // Normal path requires ink at the axis; the dip path is the sole
          // exception, and only when the seam demonstrably crosses CF and a
          // baseline exists to project onto.
          if (seamBridgesAxis && cradleCfTopBandInkRatio >= 0.02) {
            cradleCfTop = { x: axisXpx / w, y: cradleRow / h };
            cradleCfTopDipProjected = true;
          } else {
            cradleCfTopReject = 'no ink support at cradle row near CF axis';
          }
        } else if (!seamStrong) {
          cradleCfTopReject = 'no clear cradle/cup-bottom seam approaching CF axis (weak or ambiguous horizontal seam ink)';
        } else if (cradleCfTopBandInkRatio < 0.02) {
          cradleCfTopReject = 'no baseline ink under CF axis to project POM 6 endpoint';
        } else {
          // Direct accept — but on a front-closure style (zip/hook placket at
          // CF) the ink that satisfied the axis-window test is the PLACKET's
          // own vertical structure, which inks the axis zone at EVERY row, so
          // (axis, cradleRow) can sit below the real cup-seam ↔ CF junction
          // (TD correction 2026-07-10, zip-front sketch: POM 6 starts where
          // the cradle seam MEETS the placket, not at the flat cradle row).
          // Detect a placket — near-continuous vertical ink columns
          // bracketing the axis — and snap y UP to the topmost row where
          // seam ink adjoins the placket from BOTH sides. Classic gores have
          // no such columns and keep the flat-cradle-row behavior unchanged.
          let cfSeamRow = cradleRow;
          {
            const xz = Math.max(4, Math.round(bboxW * 0.06));
            const vTop = Math.max(0, cradleRow - Math.round(bboxH * 0.15));
            const vBot = Math.min(h - 1, bandRow - 2);
            let placketL = -1, placketR = -1;
            if (vBot > vTop + 4) {
              for (let x = Math.max(0, axisPx - xz); x <= Math.min(w - 1, axisPx + xz); x += 1) {
                let inked = 0;
                for (let y = vTop; y <= vBot; y += 1) {
                  if (rawDark[y * w + x]) inked += 1;
                }
                // ≥ 0.85: a placket edge is a continuous drawn LINE. A dotted
                // mesh-gore fill also stacks ink in a column but stays well
                // under this bar, and must not be mistaken for a placket.
                if (inked / (vBot - vTop + 1) >= 0.85) {
                  if (x <= axisPx && (placketL < 0 || x < placketL)) placketL = x;
                  if (x >= axisPx && x > placketR) placketR = x;
                }
              }
            }
            // A real placket (zip/hook/button stand) has WIDTH. A single CF
            // seam line under the gore also reads as a continuous vertical
            // column but is 1-3 px wide — snapping along it would drag POM 6
            // up the gore's converging lace edges (TD-annotated fixture
            // "need TD correction.png" pins the start at the gore bottom).
            const minPlacketW = Math.max(6, Math.round(w * 0.015));
            if (placketL >= 0 && placketR - placketL >= minPlacketW) {
              // Adjacency gap in IMAGE-width terms, not bbox terms: the ink
              // bbox spans BOTH views on two-view sketches, so a bbox-relative
              // gap balloons to ~10px and lets scattered lace-texture dots
              // "adjoin" the placket (same failure class as the B4 seam-pad
              // fix). 0.4% of the analysis width ≈ a real seam-to-placket
              // touch distance.
              const gmax = Math.max(2, Math.round(w * 0.004));
              const jTop = Math.max(0, cradleRow - Math.round(bboxH * 0.12));
              // Two adjacency strengths. FINDING the junction (scanning up
              // from the cradle row) accepts any real ink touch (≥2 px) — a
              // thin dashed cup seam crosses the placket edge with only a
              // couple of pixels per row pair. EXTENDING upward to the seam's
              // top line demands a solid run (≥4 px): sparse lace-texture
              // dots peak at 2-3 and would otherwise form stepping stones
              // that walk the junction up a decorative lace edge.
              const strip = gmax + 4;
              const adjoins = (y, x0, x1, minHits) => {
                let hits = 0;
                for (let y2 = y; y2 <= Math.min(h - 1, y + 1); y2 += 1) {
                  for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x += 1) {
                    if (rawDark[y2 * w + x]) hits += 1;
                  }
                }
                return hits >= minHits;
              };
              const adjoinsBoth = (y, minHits) => adjoins(y, placketL - strip, placketL - 1, minHits)
                && adjoins(y, placketR + 1, placketR + strip, minHits);
              // Scan UP from the cradle row and take the FIRST adjoining seam
              // block — the cradle seam is the structure nearest the cradle
              // row. Taking the topmost adjoining row in the window instead
              // would snap to an unrelated upper junction (a lace neckline
              // edge also adjoins the placket on some styles). Then extend to
              // the seam's TOP ink line: the seam is drawn as paired/dashed
              // stitch lines that adjoin at slightly different rows, so hop
              // small non-adjoining gaps (≤ hop rows, relative to the latest
              // top) — but never far enough to leave the seam block for a
              // distant structure. The TD arrow tip sits on the upper line.
              const hop = Math.max(3, Math.round(bboxH * 0.03));
              for (let y = cradleRow - 2; y >= jTop; y -= 1) {
                if (adjoinsBoth(y, 2)) {
                  let top = y;
                  let probe = y - 1;
                  while (probe >= jTop && (top - probe) <= hop) {
                    if (adjoinsBoth(probe, 4)) top = probe;
                    probe -= 1;
                  }
                  cfSeamRow = top;
                  break;
                }
              }
            }
          }
          cradleCfTop = { x: axisXpx / w, y: cfSeamRow / h };
        }
      }
    }

    // Interrupted-seam junction tier (US-015 / ADR 0023): on front-closure
    // styles the cradle/band seam is interrupted AT the CF axis by the
    // placket, so the direct paths above (which need ink on the winning
    // cradle row at the axis) miss — and on such styles the cradle ROW prior
    // itself can lock onto the neckline far above the true seam (demo4: row
    // 0.54, rejected 'too close to CF top' while the seam sits at 0.83).
    // Recover it row-agnostically: scan rows below cf-top for the junction
    // signature — a long horizontal seam run approaching the axis from BOTH
    // sides, a narrow CF gap roughly centered on the axis, and VERTICAL
    // closure-edge ink bounding the gap (the placket sides; a curved wire
    // bounding a gore gap is locally horizontal and fails this). Topmost
    // qualifying row wins (the seam's upper stitch line — where the TD arrow
    // tip sits, per the amorafit correction). Seeds low-confidence +
    // reviewRequired via the seamJunction provenance; never trusted further.
    let cradleCfTopJunction = false;
    if (!cradleCfTop && cfTopPx >= 0 && bandRow > 0) {
      const jStart = Math.min(h - 1, cfTopPx + Math.max(4, Math.round(bboxH * 0.05)));
      const jEnd = Math.max(jStart, (bandEdgeRow > 0 ? bandEdgeRow : bandRow) - Math.max(3, Math.round(bboxH * 0.02)));
      const minRunPx = Math.max(10, Math.round(bboxW * 0.12));
      const maxGapPx = Math.max(8, Math.round(bboxW * 0.18));
      const maxHole = 1;                                   // tolerate anti-aliased seams
      const vEdgeRun = Math.max(6, Math.round(bboxH * 0.10));
      const inkAt = (x, y) => rawDark[y * w + x];
      for (let y = jStart; y <= jEnd && !cradleCfTopJunction; y += 1) {
        const rowInk = (x) => inkAt(x, y)
          || (y > 0 && inkAt(x, y - 1))
          || (y < h - 1 && inkAt(x, y + 1));
        let leftEdge = -1;
        for (let x = axisPx; x >= minX; x -= 1) { if (rowInk(x)) { leftEdge = x; break; } }
        if (leftEdge < 0) continue;
        let rightEdge = -1;
        for (let x = axisPx + 1; x <= maxX; x += 1) { if (rowInk(x)) { rightEdge = x; break; } }
        if (rightEdge < 0) continue;
        // The junction signature REQUIRES an empty gap at the axis — the
        // placket interior. Ink on/next to the axis cell means this row is a
        // continuous structure (band interior, drawn CF line, gore ink), not
        // an interrupted seam; the direct paths above own those cases.
        if (leftEdge >= axisPx - 1 || rightEdge <= axisPx + 1) continue;
        if (rightEdge - leftEdge > maxGapPx) continue;
        if (Math.abs((leftEdge + rightEdge) / 2 - axisPx) > Math.max(4, bboxW * 0.04)) continue;
        const runFrom = (x0, dir) => {
          let run = 0, hole = 0, x = x0;
          while (x >= minX && x <= maxX) {
            if (rowInk(x)) { run += 1; hole = 0; }
            else { hole += 1; if (hole > maxHole) break; }
            x += dir;
          }
          return run;
        };
        if (runFrom(leftEdge, -1) < minRunPx) continue;
        if (runFrom(rightEdge, +1) < minRunPx) continue;
        const vRun = (x) => {
          let run = 0;
          for (let yy = Math.max(minY, y - vEdgeRun); yy <= Math.min(maxY, y + vEdgeRun); yy += 1) {
            if (inkAt(x, yy)
              || (x > 0 && inkAt(x - 1, yy))
              || (x < w - 1 && inkAt(x + 1, yy))) run += 1;
          }
          return run;
        };
        if (vRun(leftEdge) < vEdgeRun) continue;
        if (vRun(rightEdge) < vEdgeRun) continue;
        cradleCfTop = { x: axisPx / w, y: y / h };
        cradleCfTopJunction = true;
        cradleCfTopReject = null;
      }
    }

    // ---- Cradle-at-bottom-cup (POM 7 endpoints) ----
    // POM 7 measures the cradle/cup-bottom seam height at the BOTTOM-CUP
    // position (away from the CF axis, inside the cup-side region). Its top
    // endpoint sits where the cup-bottom seam meets the cradle row outside the
    // CF guard; its bottom endpoint sits directly below on the band baseline.
    //
    // We require:
    //   - cradleY detected (cradleStrength > rowNoiseFloor * 1.3, already gated)
    //   - bandRow detected
    //   - a column x between the CF axis (with a generous distance buffer so
    //     POM 7 reads as distinct from POM 6) and the side seam (with a buffer
    //     so it doesn't snap to the POM 11 side seam ink)
    //   - that column carries cradle-row ink (cup-bottom seam evidence)
    //   - that column also carries band-row ink (real baseline beneath it)
    // When any guard fails the anchors are NOT seeded and POM 7 demotes to
    // REVIEW_ONLY downstream — no horizontal-ratio fallback.
    let cradleCupTop = null;
    let cradleCupBottom = null;
    let cradleCupSide = 0;
    // Provenance tier of the committed seam: 'strong' (vertical guide),
    // 'seam' (pattern-3 seam+baseline), or 'guide' (sparse dashed guide —
    // NEW relaxed tier; drawn for TD review but NEVER fed to the cupModel,
    // see buildCupModel and ADR 0021).
    let cradleCupTier = null;
    let cradleCupTopInkRatio = 0;
    let cradleCupBandInkRatio = 0;
    let cradleCupColInkRatio = 0;
    let cradleCupSegmentsWithInk = 0;
    let cradleCupSegmentCount = 0;
    let cradleCupEdgePenalty = 1;
    let cradleCupReject = null;
    if (cradleRow < 0 || cradleStrength <= rowNoiseFloor * 1.3) {
      cradleCupReject = 'no cradle row detected';
    } else if (bandRow < 0) {
      cradleCupReject = 'no band row detected';
    } else {
      // Distance buffers (in px). CF-side buffer keeps POM 7 well off the
      // CF axis (≥ 18% of bbox width, no smaller than 2× peakSep). Side
      // buffer is intentionally small: real POM 7 lines often sit close to
      // the side seam, so we only push off by ~3% of bbox width (just enough
      // to avoid snapping directly onto POM 11) and rely on a soft edge
      // penalty in scoring to bias away from the seam when the line is
      // ambiguous.
      const cfAxisBuffer = Math.max(peakSep * 2, Math.round(bboxW * 0.18));
      const sideBuffer  = Math.max(2, Math.round(bboxW * 0.03));
      const ySpan = 2;
      const xWin = Math.max(3, Math.round(bboxW * 0.03));
      const yBandSpan = Math.max(2, Math.round(bboxH * 0.012));
      const yLo = Math.max(0, cradleRow - ySpan);
      const yHi = Math.min(h - 1, cradleRow + ySpan);
      const yBandLo = Math.max(0, bandRow - yBandSpan);
      const yBandHi = Math.min(h - 1, bandRow + yBandSpan);

      // For each side (left=-1, right=+1) sweep candidate columns and score
      // by cradle-row ink, weighted by band-row support, vertical evidence,
      // and position priors (bonus for being far from CF, soft penalty when
      // pressed against the side seam).
      //
      // Vertical-line evidence (colRatio / segmentsWithInk) is a CONFIDENCE
      // BOOSTER, not a hard requirement. Per rule.md POM 7 contract, three
      // evidence patterns are acceptable:
      //   1. explicit vertical guide line from cradle to baseline
      //   2. segmented/dashed vertical support spanning cradle-to-baseline
      //   3. strong cradle-bottom-cup seam plus clean baseline projection,
      //      with no conflicting negative evidence
      // Patterns 1 and 2 light up colRatio/segmentsWithInk. Pattern 3 does
      // not — most real bra sketches show the cup-bottom seam + band but
      // no drawn vertical measurement line (that's what the tool drafts).
      // So we measure vertical-guide quality but accept candidates without
      // it as long as the side-seam discriminator (below) does NOT fire and
      // the cradle/band seam ink itself is strong.
      //   - colRatio = fraction of rows between cradleRow and bandRow that
      //     carry any ink inside the candidate column window.
      //   - segmentsWithInk / segmentCount = how many evenly-spaced segments
      //     of the gap have at least one inked row.
      const colMinRatio = 0.28;
      const segmentCount = 5;
      const segmentMin = 4;
      // Minimum cradle-row ink ratio when NO vertical guide is present. The
      // permissive 0.05 floor at line ~1028 lets faint cup-arc tangent ink
      // qualify; for pattern 3 (no guide) we need actual seam ink at the
      // candidate column, not just a single grazing curve point.
      const cradleRatioNoGuide = 0.25;
      // Guide tier (ADR 0021): a sparse dashed guide (gap ≥ ~8 px) hits every
      // segment but its continuous colRatio sits below the strong floor. When
      // BOTH today's acceptance paths fail, such a candidate may still commit
      // at tier 'guide' — drawn low-confidence + reviewRequired, and ignored
      // by the cupModel. 0.18 admits real sparse dashes (2px dash / 8px gap
      // ≈ 0.25) while genuinely ambiguous patterns (gap 12 ≈ 0.17) stay out.
      const dashedColMinRatio = 0.18;
      // Span between rows for the vertical check — strictly INSIDE the gap
      // so cradleRow / bandRow ink doesn't contribute.
      const vGapLo = Math.min(cradleRow + ySpan + 1, bandRow - yBandSpan - 1);
      const vGapHi = Math.max(cradleRow + ySpan + 1, bandRow - yBandSpan - 1);
      // Side-seam-discriminator range: a narrow band ABOVE the cradle row.
      // POM 7 is bounded above by the cradle (no ink there), while the side
      // seam runs from the chest line down through the cradle down to the
      // band so it has full ink in this region. A column whose window has
      // dense ink here is the side seam, not POM 7.
      const aboveLo = Math.max(0, cradleRow - Math.max(6, Math.round(bboxH * 0.10)));
      const aboveHi = Math.max(0, cradleRow - ySpan - 1);
      const aboveMaxRatio = 0.35;
      const sideCandidates = [];
      const guideCandidates = [];      // dashed-guide tier pool (ADR 0021)
      let anyPassedRows = false;       // ≥1 candidate passed cradle+band rows
      let anyPassedColumn = false;     // ≥1 candidate also had vertical ink
      let anyRejectedAsSideSeam = false;
      for (const side of [-1, +1]) {
        let edgeCol;
        if (side < 0) {
          edgeCol = sideLeftCol > 0 ? sideLeftCol : minX + Math.round(bboxW * 0.05);
        } else {
          edgeCol = sideRightCol > 0 ? sideRightCol : maxX - Math.round(bboxW * 0.05);
        }
        const xLo = side < 0
          ? Math.max(minX + 1, edgeCol + sideBuffer)
          : Math.max(minX + 1, axisPx + cfAxisBuffer);
        const xHi = side < 0
          ? Math.min(maxX - 1, axisPx - cfAxisBuffer)
          : Math.min(maxX - 1, edgeCol - sideBuffer);
        if (xHi <= xLo) continue;
        let bestX = -1;
        let bestScore = 0;
        let bestCradleInk = 0;
        let bestBandInk = 0;
        let bestColRatio = 0;
        let bestSegmentsHit = 0;
        let bestEdgePenalty = 1;
        let bestTier = null;
        let bestGuideX = -1;
        let bestGuideScore = 0;
        let bestGuideCradleInk = 0;
        let bestGuideBandInk = 0;
        let bestGuideColRatio = 0;
        let bestGuideSegmentsHit = 0;
        let bestGuideEdgePenalty = 1;
        for (let xc = xLo; xc <= xHi; xc += 1) {
          const cxLo = Math.max(0, xc - xWin);
          const cxHi = Math.min(w - 1, xc + xWin);
          let cradleInk = 0, cradleWin = 0;
          for (let y = yLo; y <= yHi; y += 1) {
            for (let x = cxLo; x <= cxHi; x += 1) {
              cradleWin += 1;
              if (dark[y * w + x]) cradleInk += 1;
            }
          }
          const cradleRatio = cradleWin > 0 ? cradleInk / cradleWin : 0;
          if (cradleRatio < 0.05) continue;
          let bandInk = 0, bandWin = 0;
          for (let y = yBandLo; y <= yBandHi; y += 1) {
            for (let x = cxLo; x <= cxHi; x += 1) {
              bandWin += 1;
              if (dark[y * w + x]) bandInk += 1;
            }
          }
          const bandRatio = bandWin > 0 ? bandInk / bandWin : 0;
          if (bandRatio < 0.05) continue;
          anyPassedRows = true;
          // Vertical column ink between rows. Count rows-with-ink (for the
          // overall ratio) AND segments-with-ink (for span coverage). A
          // dashed line has ~40% rows inked but hits every segment; a short
          // decorative tick may exceed the ratio locally but only hits 1-2
          // segments and fails the span check.
          // Use the RAW mask (before connected-components filtering) for the
          // vertical ink scan. The component filter drops tiny shapes, and
          // each individual dash of a dashed POM 7 line is a 3×2 px component
          // that falls below the floor — so reading from `dark` here would
          // report zero ink for an obvious dashed line. The raw mask still
          // shows the dashes.
          let colRows = 0;
          let colRowsWithInk = 0;
          const segHits = new Uint8Array(segmentCount);
          if (vGapHi > vGapLo) {
            const gapLen = vGapHi - vGapLo + 1;
            for (let y = vGapLo; y <= vGapHi; y += 1) {
              colRows += 1;
              let inked = false;
              for (let x = cxLo; x <= cxHi; x += 1) {
                if (rawDark[y * w + x]) { inked = true; break; }
              }
              if (inked) {
                colRowsWithInk += 1;
                let segIdx = Math.floor(((y - vGapLo) / gapLen) * segmentCount);
                if (segIdx >= segmentCount) segIdx = segmentCount - 1;
                segHits[segIdx] = 1;
              }
            }
          }
          const colRatio = colRows > 0 ? colRowsWithInk / colRows : 0;
          let segmentsHit = 0;
          for (let s = 0; s < segmentCount; s += 1) {
            if (segHits[s]) segmentsHit += 1;
          }
          // verticalGuideStrong = pattern 1/2 (explicit or dashed guide
          // line). Without it we fall back to pattern 3 (semantic seam +
          // baseline projection) which requires both a stronger cradle
          // window ink ratio AND horizontal seam continuity (the cradle/
          // cup-bottom seam extends across the bottom-cup zone, whereas a
          // cup-outline arc tangent only piles ink at a single point).
          const verticalGuideStrong = (colRatio >= colMinRatio) && (segmentsHit >= segmentMin);
          // Sparse dashed guide: every segment inked but the continuous ratio
          // is below the strong floor. Only relevant when pattern 3 ALSO
          // fails — then the candidate survives as guide-tier (ADR 0021)
          // instead of being rejected outright.
          const dashedGuidePresent = !verticalGuideStrong
            && (segmentsHit >= segmentMin)
            && (colRatio >= dashedColMinRatio);
          // dashedOnly = this candidate exists only via the guide tier. Such
          // candidates must not disturb today's reject-reason flags or score
          // pool — the tier is strictly additive.
          let dashedOnly = false;
          let seamHorizontalRun = 0;
          if (!verticalGuideStrong) {
            if (cradleRatio < cradleRatioNoGuide) {
              if (!dashedGuidePresent) continue;
              dashedOnly = true;
            }
            // Horizontal seam extent: a real cradle/cup-bottom seam draws
            // ink continuously across the bottom-cup region; a cup-outline
            // arc tangent piles ink only in ~10-15 contiguous columns
            // around the cup ellipse center. Measure the LONGEST run of
            // inked columns at cradleRow ± 1 (3-row band tolerates
            // anti-aliasing) inside a wider window so a real seam
            // (spanning 30%+ of bboxW) easily clears the threshold while a
            // cup tangent (~8% of bboxW) does not.
            const runWin = Math.max(20, Math.round(bboxW * 0.18));
            const runLo = Math.max(0, xc - runWin);
            const runHi = Math.min(w - 1, xc + runWin);
            const runYLo = Math.max(0, cradleRow - 1);
            const runYHi = Math.min(h - 1, cradleRow + 1);
            let currentRun = 0;
            let singleRowRun = 0;
            let currentSingle = 0;
            for (let x = runLo; x <= runHi; x += 1) {
              let inkedBand = false;
              for (let y = runYLo; y <= runYHi; y += 1) {
                if (rawDark[y * w + x]) { inkedBand = true; break; }
              }
              if (inkedBand) {
                currentRun += 1;
                if (currentRun > seamHorizontalRun) seamHorizontalRun = currentRun;
              } else {
                currentRun = 0;
              }
              if (rawDark[cradleRow * w + x]) {
                currentSingle += 1;
                if (currentSingle > singleRowRun) singleRowRun = currentSingle;
              } else {
                currentSingle = 0;
              }
            }
            // Accept either: a long contiguous run in the 3-row band (lets
            // anti-aliased seams pass even when no single row is fully
            // continuous), OR a meaningful run at the exact cradleRow.
            const minBandRun = Math.max(28, Math.round(bboxW * 0.16));
            const minSingleRun = Math.max(18, Math.round(bboxW * 0.10));
            if (!dashedOnly && seamHorizontalRun < minBandRun && singleRowRun < minSingleRun) {
              if (!dashedGuidePresent) continue;
              dashedOnly = true;
            }
          }
          // Reject side-seam-like columns: a long, continuous vertical run of
          // ink ABOVE the cradle row in any column of the candidate window
          // means we're sampling a vertical seam that runs from chest to
          // band, not a measurement line that starts at the cup-bottom.
          //
          // We use a per-column maximum instead of "rows with any ink"
          // because a cup outline curve that arcs across the window inks
          // ~half the rows in the above range (each row hit by a single x
          // value where the curve crosses) but no single column is densely
          // filled. The side seam, in contrast, fills one column for the
          // entire vertical span.
          let aboveRows = 0;
          let aboveMaxColRun = 0;
          if (aboveHi > aboveLo) {
            aboveRows = aboveHi - aboveLo + 1;
            for (let x = cxLo; x <= cxHi; x += 1) {
              let run = 0;
              for (let y = aboveLo; y <= aboveHi; y += 1) {
                if (rawDark[y * w + x]) run += 1;
              }
              if (run > aboveMaxColRun) aboveMaxColRun = run;
            }
          }
          const aboveRatio = aboveRows > 0 ? aboveMaxColRun / aboveRows : 0;
          if (aboveRatio > aboveMaxRatio) {
            // Guide-only candidates would have been rejected before reaching
            // this guard under today's rules — keep the reject-reason flags
            // (and therefore the user-facing messages) byte-identical.
            if (!dashedOnly) anyRejectedAsSideSeam = true;
            continue;
          }
          // HARD reject candidates that sit within 5% of the side seam
          // column AND do NOT have an explicit/dashed guide line (pattern
          // 1 or 2). The "seam + baseline projection" path (pattern 3) is
          // too easy to spoof with a band-zigzag tail near the side seam:
          // there's enough cradleRow ink in the bottom-cup region and
          // enough bandRow ink at the seam itself for `cradleRatio` and
          // `bandRatio` to clear, but the candidate column is really the
          // bottom of the side seam, not a cup-bottom measurement. With
          // an explicit guide line we trust the TD drew the POM 7 line on
          // purpose; without one, we require a real bottom-cup gap.
          const distFromEdgePx = Math.abs(xc - edgeCol);
          const minDistFromSide = Math.max(6, Math.round(bboxW * 0.05));
          // Without an explicit guide, require a real 5%-of-bbox gap from the
          // side seam. WITH a guide we normally trust the TD drew POM 7 on
          // purpose — but a band ZIG-ZAG TAIL can spoof verticalGuideStrong AND
          // land right on the seam column, so still hard-reject a candidate
          // essentially COINCIDENT with the side seam even when guided (D8): a
          // genuine hand-drawn POM 7 line sits clearly inboard of the seam.
          const guardDistPx = verticalGuideStrong
            ? Math.max(3, Math.round(bboxW * 0.02))
            : minDistFromSide;
          if (distFromEdgePx < guardDistPx) {
            if (!dashedOnly) anyRejectedAsSideSeam = true;
            continue;
          }
          if (!dashedOnly) anyPassedColumn = true;
          // Distance prior — reward being far from CF (≥ 20% of bbox width
          // earns full bonus). Apply a SOFT penalty for closeness to the
          // side seam: never below 0.5 even when adjacent, smoothly
          // increasing to 1.0 by 10% of bbox width. This biases scoring
          // away from POM 11 without hard-rejecting real POM 7 lines that
          // genuinely sit close to the side.
          const distFromAxis = Math.abs(xc - axisPx) / Math.max(1, bboxW);
          const distFromEdge = Math.abs(xc - edgeCol) / Math.max(1, bboxW);
          const farBonus = Math.min(1, distFromAxis / 0.2);
          const edgePenalty = 0.5 + 0.5 * Math.min(1, distFromEdge / 0.10);
          const segmentBonus = segmentsHit / segmentCount;
          // Vertical-guide multiplier: candidates with a clear guide line
          // outscore those without. Floor at 0.35 so pattern-3 candidates
          // (no guide, but real cradle seam) can still win when no guide
          // candidate exists. Guide-tier (dashed-only) candidates score into
          // their OWN pool — they can never displace a candidate accepted by
          // today's rules (ADR 0021 additivity).
          if (dashedOnly) {
            const guideScore = cradleRatio * (0.6 + 0.4 * bandRatio)
              * (0.55 + 0.45 * farBonus) * edgePenalty
              * (0.45 + 0.25 * colRatio * segmentBonus);
            if (guideScore > bestGuideScore) {
              bestGuideScore = guideScore;
              bestGuideX = xc;
              bestGuideCradleInk = cradleRatio;
              bestGuideBandInk = bandRatio;
              bestGuideColRatio = colRatio;
              bestGuideSegmentsHit = segmentsHit;
              bestGuideEdgePenalty = edgePenalty;
            }
            continue;
          }
          const guideMultiplier = verticalGuideStrong
            ? (0.6 + 0.4 * colRatio * segmentBonus)
            : 0.35;
          const score = cradleRatio * (0.6 + 0.4 * bandRatio)
            * (0.55 + 0.45 * farBonus) * edgePenalty * guideMultiplier;
          if (score > bestScore) {
            bestScore = score;
            bestX = xc;
            bestCradleInk = cradleRatio;
            bestBandInk = bandRatio;
            bestColRatio = colRatio;
            bestSegmentsHit = segmentsHit;
            bestEdgePenalty = edgePenalty;
            bestTier = verticalGuideStrong ? 'strong' : 'seam';
          }
        }
        if (bestX > 0) {
          sideCandidates.push({
            side, x: bestX, score: bestScore,
            cradleInk: bestCradleInk, bandInk: bestBandInk,
            colRatio: bestColRatio, segmentsHit: bestSegmentsHit,
            edgePenalty: bestEdgePenalty,
            tier: bestTier,
          });
        }
        if (bestGuideX > 0) {
          guideCandidates.push({
            side, x: bestGuideX, score: bestGuideScore,
            cradleInk: bestGuideCradleInk, bandInk: bestGuideBandInk,
            colRatio: bestGuideColRatio, segmentsHit: bestGuideSegmentsHit,
            edgePenalty: bestGuideEdgePenalty,
            tier: 'guide',
          });
        }
      }
      // Guide-tier fallback (ADR 0021): considered ONLY when today's
      // acceptance found nothing on either side, so images that detect today
      // are byte-identical. A guide winner commits at tier 'guide' — seeded
      // low-confidence + reviewRequired, and ignored by the cupModel.
      const acceptedPool = sideCandidates.length ? sideCandidates : guideCandidates;
      if (!acceptedPool.length) {
        if (anyRejectedAsSideSeam && !anyPassedColumn) {
          cradleCupReject = 'candidate column looks like the side seam, not a POM 7 line (ink extends above the cradle row)';
        } else if (anyPassedRows && !anyPassedColumn) {
          // Reached when every cradle+band candidate column also failed the
          // side-seam discriminator OR the no-guide cradle threshold. The
          // user-facing reason favours "weak seam evidence" since that is
          // the more common cause on real sketches (the side-seam case is
          // covered above when it dominated).
          cradleCupReject = 'no clear cradle/cup-bottom seam at bottom-cup zone (weak or ambiguous seam ink)';
        } else {
          cradleCupReject = 'no cradle/band ink support in either bottom-cup region';
        }
      } else {
        acceptedPool.sort((a, b) => b.score - a.score);
        const winner = acceptedPool[0];
        cradleCupSide = winner.side;
        cradleCupTopInkRatio = winner.cradleInk;
        cradleCupBandInkRatio = winner.bandInk;
        cradleCupColInkRatio = winner.colRatio;
        cradleCupSegmentsWithInk = winner.segmentsHit;
        cradleCupSegmentCount = segmentCount;
        cradleCupEdgePenalty = winner.edgePenalty;
        cradleCupTop = { x: winner.x / w, y: cradleRow / h };
        cradleCupBottom = { x: winner.x / w, y: bandRow / h };
        cradleCupTier = winner.tier || 'seam';
      }
    }

    // POM 7 arc tier (US-014 / ADR 0022): when neither the seam tiers nor the
    // dashed-guide tier committed, read the cup-bottom structure itself — the
    // traced underwire/cup-bottom arc (the same evidence the cupModel already
    // trusts for POM 9's bottom). Requires a validated apex on the same side.
    // Commits at tier 'arc': seeded low-confidence + reviewRequired, ignored
    // by the cupModel side-picker and bottom (only 'strong'/'seam' feed it).
    // The right cup is preferred to match the TD labeling convention (demo3).
    if (!cradleCupTop && cradleY != null && bandY != null) {
      for (const side of [+1, -1]) {
        const apexPoint = side < 0 ? apexLeft : apexRight;
        if (!apexPoint) continue;
        const arcSideColPx = side < 0
          ? (Number.isFinite(sideLeftX) ? Math.round(sideLeftX * w) : minX + Math.round(bboxW * 0.05))
          : (Number.isFinite(sideRightX) ? Math.round(sideRightX * w) : maxX - Math.round(bboxW * 0.05));
        const arc = findCupBottomFromInk(dark, w, h, bounds, axisPx, arcSideColPx, apexPoint.y, cradleY, side);
        if (arc && arc.bottomX != null
            && arc.support >= 0.30
            && arc.bottomY > apexPoint.y + 0.08
            && arc.bottomY >= cradleY - 0.05
            && arc.bottomY < bandY - 0.01) {
          cradleCupTop = { x: arc.bottomX, y: arc.bottomY };
          cradleCupBottom = { x: arc.bottomX, y: bandY };
          cradleCupSide = side;
          cradleCupTier = 'arc';
          cradleCupReject = null;
          break;
        }
      }
    }

    _stageMark('frontInkEndpoints');

    const sigConf = (peak, floor) => clamp01((peak - floor) / Math.max(1, floor * 2));

    // ---- Stage: cup model for POM 9 / POM 10 ----
    // POM 9 (inner cup height) and POM 10 (inner cup width) belong to ONE cup.
    // Build that cup model from real structure (apex + cradle-cup seam) so
    // both POMs share side/view/center. See buildCupModel above.
    const cradleCupConfidence = cradleCupTop
      ? sigConf(cradleStrength, rowNoiseFloor)
      : 0;
    const cupModel = buildCupModel({
      bounds, w, h, dark,
      axisPx,
      cradleY,
      apexLeft, apexLeftConf: apexLeftInfo ? apexLeftInfo.confidence : 0,
      apexRight, apexRightConf: apexRightInfo ? apexRightInfo.confidence : 0,
      cradleCupTop, cradleCupSide, cradleCupTier, cradleCupConfidence,
      sideLeftX, sideRightX,
      hasFrontInner: viewClassification.frontInnerIndex >= 0,
    });

    _stageMark('cupModel');

    // ---- Stage: back-view features (center axis, panel, strap, side) ----
    // Use the front/back classifier's pick when it produced one. Fall back to
    // "largest non-primary view" only when the classifier is unsure (e.g. one
    // view in the source, or two ambiguous views). These seed back-top /
    // back-bottom for POM 12.
    let backViewIndex = viewClassification.backIndex;
    if (backViewIndex < 0 && viewBoxesPx.length > 1) {
      const candidates = viewBoxesPx
        .map((view, index) => ({ view, index }))
        .filter(item => item.index !== primaryViewIndex)
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0));
      if (candidates.length) backViewIndex = candidates[0].index;
    }
    const backBox = (backViewIndex >= 0 && viewBoxesPx[backViewIndex]) ? viewBoxesPx[backViewIndex] : null;
    // All back-view landmarks (center axis, panel edges/height, strap top/inner,
    // side seam) come from detectBackLandmarks so the identical pass can re-run
    // if the TD reassigns the back role in the view-role dialog — needed on a
    // 3-panel board where "back" vs "front_inner" was ambiguous and the auto
    // pick was wrong (see maybePromptForViewRoles / redetectBackLandmarks).
    const {
      backInfo, backFeatures, backPanelInfo, backPanelHeightInfo,
      backStrapTopInfo, backStrapInnerInfo, backSideTopInfo, backSideBottomInfo, backSideInfo,
    } = detectBackLandmarks(dark, w, h, backBox);

    _stageMark('backFeatures');

    // ---- Stage: confidence per feature + overall quality ----
    // Layer-1 frame confidences (per rule.md): the symmetry-derived axis is
    // the coordinate prior and the longest-run band row is the baseline prior.
    // Surfaced both at the top level (for downstream POM gating) and inside
    // the layered debug payload so the TD can answer "do we trust the frame?"
    const axisConfidence = clamp01(symmetry);
    const baselineConfidence = sigConf(bandStrength, rowNoiseFloor);
    const confidence = {
      axis: axisConfidence,
      band: baselineConfidence,
      chest: chestY != null ? sigConf(chestStrength, rowNoiseFloor) : 0,
      cradle: cradleY != null ? sigConf(cradleStrength, rowNoiseFloor) : 0,
      cradleCfTop: cradleCfTop
        ? (cradleCfTopDipProjected
            ? Math.min(0.19, sigConf(cradleStrength, rowNoiseFloor))
            : sigConf(cradleStrength, rowNoiseFloor))
        : 0,
      cradleCupTop: cradleCupTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
      cradleCupBottom: cradleCupBottom ? sigConf(bandStrength, rowNoiseFloor) : 0,
      sideLeft: sideLeftX != null ? sigConf(sideLeftStrength, colNoiseFloor) : 0,
      sideRight: sideRightX != null ? sigConf(sideRightStrength, colNoiseFloor) : 0,
      apexLeft: apexLeftInfo ? apexLeftInfo.confidence : 0,
      apexRight: apexRightInfo ? apexRightInfo.confidence : 0,
      strap: strapInfo ? strapInfo.confidence : 0,
      frontStrapStart: frontStrapStartInfo ? frontStrapStartInfo.confidence : 0,
      back: backInfo ? backInfo.confidence : 0,
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.confidence : 0,
      sideTopLeft: sideTopLeftInfo ? sideTopLeftInfo.confidence : 0,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.confidence : 0,
      backPanel: backPanelHeightInfo ? backPanelHeightInfo.confidence : (backPanelInfo ? backPanelInfo.confidence : 0),
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.confidence : 0,
    };
    // Overall detection quality: weighted mix of axis symmetry and band/chest
    // strength. Surfaces in the spec-panel header so the TD knows whether to
    // trust the seeds or expect to drag a lot.
    const quality = clamp01(
      0.45 * confidence.axis
      + 0.30 * confidence.band
      + 0.15 * (confidence.chest || 0.25)
      + 0.05 * (confidence.sideLeft || 0)
      + 0.05 * (confidence.sideRight || 0)
    );
    _stageMark('confidence');

    // ---- Stage: assemble detection result ----
    const detectionResult = {
      bbox,
      axisX,
      bandY,
      chestY,
      cradleY,
      sideLeftX,
      sideRightX,
      apexLeft,
      apexRight,
      apexLeftInner,
      apexRightInner,
      apexLeftOuter,
      apexRightOuter,
      apexMissingReason: apexPair ? null : 'No reliable strap-cup joining seam / highest cup point was detected.',
      // Front-view ink endpoints — see "Front-view ink endpoints" pass above.
      chestLeftX,
      chestRightX,
      bandLeftX,
      bandRightX,
      underbustY,
      underbustLeftX,
      underbustRightX,
      underbustRunPx,
      underbustRowPx: underbustRow,
      underbustMinSpanPx: minRowSpan,
      cfTopY,
      cradleCfTop,
      cradleCfTopInkRatio: Number(cradleCfTopInkRatio.toFixed(4)),
      cradleCfTopBandInkRatio: Number(cradleCfTopBandInkRatio.toFixed(4)),
      cradleCfTopSeamHorizontalRun,
      cradleCfTopSeamSingleRowRun,
      cradleCfTopMissingReason: cradleCfTopReject,
      cradleCfTopDipProjected,
      cradleCfTopJunction,
      cradleCupTop,
      cradleCupBottom,
      cradleCupSide,
      cradleCupTier,
      cradleCupTopInkRatio: Number(cradleCupTopInkRatio.toFixed(4)),
      cradleCupBandInkRatio: Number(cradleCupBandInkRatio.toFixed(4)),
      cradleCupColInkRatio: Number(cradleCupColInkRatio.toFixed(4)),
      cradleCupSegmentsWithInk,
      cradleCupSegmentCount,
      cradleCupEdgePenalty: Number(cradleCupEdgePenalty.toFixed(4)),
      cradleCupMissingReason: cradleCupReject,
      strapTop: strapInfo ? strapInfo.top : null,
      strapBottom: strapInfo ? strapInfo.bottom : null,
      frontStrapStart: frontStrapStartInfo ? frontStrapStartInfo.point : null,
      back: backInfo,
      backFeatures,
      // Cup model — shared backbone for POM 9 (height) and POM 10 (width).
      // See buildCupModel for fields. visibility ∈ {direct, inferred, hidden};
      // when 'hidden' the seed layer skips inner-cup-* anchors so POM 9/10
      // demote to REVIEW_ONLY via the requiredAnchors guard.
      cupModel,
      // Audit-driven extra signals (POMs 9, 10, 11, 13).
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.point : null,
      sideTopLeft:  sideTopLeftInfo  ? sideTopLeftInfo.point  : null,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.point : null,
      sideBottomRight: sideBottomRightInfo ? sideBottomRightInfo.point : null,
      backPanel: backPanelInfo,
      backPanelHeight: backPanelHeightInfo,
      backStrapInner: backStrapInnerInfo,
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.point : null,
      backSideTop: backSideTopInfo ? backSideTopInfo.point : null,
      backSideBottom: backSideBottomInfo ? backSideBottomInfo.point : null,
      backSide: backSideInfo,
      // Junction / endpoint / corner map (Phase 1, plan 2). Normalized
      // coords; consumed by the semantic-snap engine (Phase 4) and the
      // __braDebug.junctions overlay. Empty array when the pass failed.
      // NOTE: detection.junctions is the FULL feature-point list (junctions +
      // endpoints + corners) — the junction-tests / pipeline-tests contract.
      junctions: junctionMap ? junctionMap.points : [],
      junctionSummary: junctionMap ? junctionMap.summary : null,
      // Contour evidence bundle (Engineering Workflow Phase 4). Raw SHAPE
      // evidence kept SEPARATE from the geometry / landmark decisions above:
      // type-split feature points, deterministic stroke stats, and a compact
      // serializable summary. Additive — the junctions / junctionSummary
      // contract above is unchanged. The trace-dependent parts (contours,
      // curveCandidates) are attached later at the Potrace edge.
      endpoints: contourEndpoints,
      corners: contourCorners,
      strokeStats: contourStrokeStats,
      contourEvidence: buildContourEvidenceSummary(contours),
      coverage: globalStats.count / total,
      primaryCoverage: darkCount / total,
      sampleWidth: w,
      sampleHeight: h,
      threshold,
      luminanceThreshold,
      backgroundLum: Math.round(cvAnalysis.backgroundLum || 255),
      detectionParams,
      componentCount: filtered.componentCount,
      keptComponentCount: filtered.keptComponents.length,
      // Normalized segmentation-stage result (Phase 3): one shape across
      // OpenCV / legacy / adapter backends, with a deterministic quality score.
      // Metadata only — the mask itself is exposed separately as inkMask.
      segmentation: serializeSegmentation(segmentation),
      // Top-level mirrors so downstream review logic can read the segmentation
      // verdict without reaching into the block. segmentationReviewRequired is
      // the weak-segmentation review signal (Phase 3, item 3).
      segmentationBackend: segmentation ? segmentation.backend : null,
      segmentationQuality: segmentation ? segmentation.quality : null,
      segmentationWeak: segmentation ? !!segmentation.weak : false,
      segmentationReviewRequired: segmentation ? !!segmentation.reviewRequired : false,
      views: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      viewBoxes: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const legacyRole = role === 'front_outer' ? 'front' : role;
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role: legacyRole,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      primaryViewIndex,
      frontViewIndex: viewClassification.frontOuterIndex,
      frontOuterViewIndex: viewClassification.frontOuterIndex,
      frontInnerViewIndex: viewClassification.frontInnerIndex,
      backViewIndex,
      viewRoleReviewRequired: viewClassification.reviewRequired,
      symmetry,
      // Layer-1 frame confidences (rule.md L1). Surfaced top-level so the
      // POM emitter / drafter can read them without diving into the debug
      // payload. axisConfidence is the symmetry-based axis prior;
      // baselineConfidence is the band-row strength above noise.
      axisConfidence,
      baselineConfidence,
      quality,
      confidence,
      engine: (cvAnalysis.engine || 'offline-vision-legacy-threshold') + '+auto-pom-v4-layers',
      // Non-serializable side channel for the Potrace tracer in
      // runOfflineDetection. Stripped before the detection is stored.
      _mask: dark,
      _maskW: w,
      _maskH: h,
    };
    _stageMark('assembleDetection');
    detectionResult.stageTimingsMs = stageTimingsMs;

    // Compact seam-evidence summary at the top level so contract tests (and
    // the spec panel) can read it without enabling cvDebug. Mirrors the
    // detailed payload in detectionResult.debug.layered.seams (which only
    // exists when debugEnabled), but with the minimum fields needed for
    // DRAWABLE / REVIEW_ONLY decisions per rule.md.
    detectionResult.seamEvidence = {
      cradleCfSeam: {
        present: !!cradleCfTop,
        confidence: cradleCfTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
        missingReason: cradleCfTopReject,
        seamHorizontalRun: cradleCfTopSeamHorizontalRun || 0,
      },
      cradleCupSeam: {
        present: !!cradleCupTop,
        confidence: cradleCupTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
        side: cradleCupSide || 0,
        tier: cradleCupTier,
        missingReason: cradleCupReject,
      },
      upperCupCfSeam: {
        present: cfTopY != null,
        source: cfTopY != null ? 'cfTopInkBound' : 'viewBoxFallback',
        missingReason: cfTopY != null ? null : 'No CF-column ink found above the band region.',
      },
    };
    // Apex join (POM 16) — confidence + provenance per side. `source` is
    // 'cup-curve' when the strap-cup join seam was the support, 'inferred'
    // when the seed came from a weaker secondary cue, null when no apex
    // anchor was seeded. The detector scans only inside the cup body
    // (below chestRow), so 'strap-ring' is never the source — tests assert
    // this explicitly.
    detectionResult.apexJoin = {
      left: apexLeftInfo
        ? { confidence: apexLeftInfo.confidence, source: 'cup-curve' }
        : { confidence: 0, source: null },
      right: apexRightInfo
        ? { confidence: apexRightInfo.confidence, source: 'cup-curve' }
        : { confidence: 0, source: null },
      pairValidated: !!apexPair,
    };
    // Synthesize a short cupModel id so POM 9 / POM 10 anchors can be
    // asserted to belong to the SAME cup (same side, same view, same
    // top/bottom Y references). Identity-only — never used for geometry.
    if (cupModel) {
      const sidePart = cupModel.side === +1 ? 'R' : (cupModel.side === -1 ? 'L' : 'X');
      const vis = cupModel.visibility ? cupModel.visibility[0] : 'x';
      const topY = cupModel.topPoint ? Math.round(cupModel.topPoint.y * 1000) : 0;
      const botY = cupModel.bottomPoint ? Math.round(cupModel.bottomPoint.y * 1000) : 0;
      cupModel.id = sidePart + ':' + vis + ':' + topY + ':' + botY;
    }

    // ---- Complete the geometry facts with the semantic-part candidates ----
    // (Engineering Workflow Phase 5, items 2-3.) The frame facts (axis, band,
    // rows, side seams, view regions) were built in analyzeGeometry; here we add
    // the cup / strap / seam / back-panel candidate geometry (already computed
    // above as the cup model, apex/strap landmarks, seam evidence, and back-view
    // features) plus an explicit geometry-quality verdict. All values are copies
    // of numbers computed above — nothing is re-detected, so anchors and golden
    // are unchanged. The quality.reviewRequired flag is the geometry stage's own
    // "do we trust the frame?" signal; it is fed into the landmark/anchor review
    // decision (see seedAnchorsFromDetection) so weak geometry raises TD review
    // instead of faking certainty.
    if (geometryFacts) {
      geometryFacts.cupGeometry = cupModel ? {
        id: cupModel.id || null,
        side: cupModel.side,
        viewRole: cupModel.viewRole || null,
        visibility: cupModel.visibility || null,
        topPoint: cupModel.topPoint || null,
        bottomPoint: cupModel.bottomPoint || null,
        innerEdge: cupModel.innerEdge || null,
        outerEdgeNearArmhole: cupModel.outerEdgeNearArmhole || null,
        centerPoint: cupModel.centerPoint || null,
        contourConfidence: cupModel.contourConfidence != null ? cupModel.contourConfidence : null,
        seamConfidence: cupModel.seamConfidence != null ? cupModel.seamConfidence : null,
      } : null;
      geometryFacts.strapGeometry = {
        top: strapInfo ? strapInfo.top : null,
        bottom: strapInfo ? strapInfo.bottom : null,
        confidence: strapInfo ? strapInfo.confidence : 0,
        frontStart: frontStrapStartInfo ? frontStrapStartInfo.point : null,
        frontStartConfidence: frontStrapStartInfo ? frontStrapStartInfo.confidence : 0,
        apexLeft: apexLeft || null,
        apexRight: apexRight || null,
        apexPairValidated: !!apexPair,
      };
      geometryFacts.seamGeometry = {
        cradleCfTop: cradleCfTop || null,
        cradleCfDipProjected: !!cradleCfTopDipProjected,
        cradleCfJunction: !!cradleCfTopJunction,
        cradleCupTop: cradleCupTop || null,
        cradleCupBottom: cradleCupBottom || null,
        cradleCupSide: cradleCupSide || 0,
        cradleCupTier,
        upperCupCfSeamPresent: cfTopY != null,
      };
      geometryFacts.backPanelGeometry = {
        present: backViewIndex >= 0,
        viewIndex: backViewIndex,
        panelTop: backPanelInfo && backPanelInfo.top ? backPanelInfo.top : null,
        panelBottom: backPanelInfo && backPanelInfo.bottom ? backPanelInfo.bottom : null,
        panelHeightConfidence: backPanelHeightInfo
          ? backPanelHeightInfo.confidence
          : (backPanelInfo ? backPanelInfo.confidence : 0),
        strapTop: backStrapTopInfo ? backStrapTopInfo.point : null,
        sideTop: backSideTopInfo ? backSideTopInfo.point : null,
        sideBottom: backSideBottomInfo ? backSideBottomInfo.point : null,
      };
      // Geometry-quality verdict. Deterministic mix of the axis/band frame
      // priors and the view-classification confidence. reviewRequired fires only
      // when the geometry is genuinely weak (ambiguous view roles, or a frame
      // prior near the floor) — on a cleanly detected sketch every term is
      // strong, so the flag is false and no well-detected landmark is disturbed.
      const geomAxisConf = clamp01(symmetry);
      const geomBandConf = baselineConfidence;
      const roleRegions = (geometryFacts.viewRegions || [])
        .filter(r => r.role && r.role !== 'unknown' && r.roleConfidence != null);
      const viewConfidence = roleRegions.length
        ? clamp01(roleRegions.reduce((s, r) => s + r.roleConfidence, 0) / roleRegions.length)
        : (geometryFacts.viewRegions && geometryFacts.viewRegions.length ? 0.35 : 0);
      const geometryOverall = clamp01(
        0.45 * geomAxisConf + 0.30 * geomBandConf + 0.25 * viewConfidence
      );
      const geometryReasons = [];
      if (viewClassification.reviewRequired) geometryReasons.push('view roles are ambiguous — confirm which region is front/back/inner');
      if (geomAxisConf < 0.15) geometryReasons.push('weak symmetry axis — the center-front prior is unreliable');
      if (geomBandConf < 0.15) geometryReasons.push('weak band line — the baseline prior is unreliable');
      const geometryReviewRequired = !!viewClassification.reviewRequired
        || geomAxisConf < 0.15
        || geomBandConf < 0.15;
      geometryFacts.quality = {
        axisConfidence: Number(geomAxisConf.toFixed(4)),
        baselineConfidence: Number(geomBandConf.toFixed(4)),
        viewConfidence: Number(viewConfidence.toFixed(4)),
        overall: Number(geometryOverall.toFixed(4)),
        reviewRequired: geometryReviewRequired,
        reasons: geometryReasons,
      };
      detectionResult.geometryFacts = geometryFacts;
      detectionResult.geometryReviewRequired = geometryReviewRequired;
    }

    // ---- Landmark QA layer (Engineering Workflow Phase 6) ----
    // Classify every anchor-schema kind — source class (detected / derived /
    // projected / missing), confidence tier, review verdict, and QA notes —
    // BEFORE anchor placement. Read-only over the assembled result; the seed
    // layer recomputes it at seed time (the detection object can be mutated
    // between runs) and consumes the same verdicts, so this attach is the
    // stage-level record, not a second decision path.
    detectionResult.landmarkQa = buildLandmarkQaFromDetection(detectionResult);
    _stageMark('landmarkQa');

    // CV Debug snapshot — intermediate detector state in pixel coords.
    // Mirrors the locals used to pick anchors so the TD can answer "why did
    // the detector choose this row/column?" without sprinkling console.logs.
    // Capture summary fields only — masks and per-row arrays are large; the
    // mask itself is encoded later (DOM edge) when debug.includeMask is set.
    if (debugEnabled) {
      const safeNum = (v, digits) => {
        if (!Number.isFinite(v)) return null;
        const f = Math.pow(10, digits || 4);
        return Math.round(v * f) / f;
      };
      const keptComponents = filtered.keptComponents || [];
      detectionResult.debug = {
        version: 1,
        engine: detectionResult.engine,
        sampleWidth: w,
        sampleHeight: h,
        thresholds: {
          ink: threshold,
          luminance: luminanceThreshold,
          backgroundLum: Math.round(cvAnalysis.backgroundLum || 255),
        },
        detectionParams: { ...detectionParams },
        rawInk: {
          count: rawStats.count,
          minX: rawStats.minX, minY: rawStats.minY,
          maxX: rawStats.maxX, maxY: rawStats.maxY,
        },
        components: {
          componentCount: filtered.componentCount || 0,
          keptComponentCount: keptComponents.length,
          // Cap to keep the payload bounded — pathological sketches can yield
          // hundreds of stray components; the top ones by ink count are what
          // a debugger actually wants to see.
          kept: keptComponents
            .slice()
            .sort((a, b) => (b.count || 0) - (a.count || 0))
            .slice(0, 64)
            .map(c => ({
              minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
              count: c.count,
              cx: Math.round(c.cx || 0), cy: Math.round(c.cy || 0),
              density: safeNum(c.density, 4),
            })),
        },
        viewBoxes: viewBoxesPx.map((box, i) => ({
          minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY,
          count: box.count || 0,
          role: (viewClassification.roles && viewClassification.roles[i]) || 'unknown',
          roleConfidence: viewClassification.scores && viewClassification.scores[i]
            ? safeNum(viewClassification.scores[i].roleConfidence, 3)
            : null,
        })),
        primaryViewIndex,
        frontOuterViewIndex: viewClassification.frontOuterIndex,
        frontInnerViewIndex: viewClassification.frontInnerIndex,
        backViewIndex,
        primary: {
          minX, minY, maxX, maxY,
          count: darkCount,
          axisPx: Math.round(axisXpx),
          symmetry: safeNum(symmetry, 4),
        },
        rows: {
          noiseFloor: safeNum(rowNoiseFloor, 2),
          medianRow,
          bandRow,
          bandEdgeRow,
          bandStrength: safeNum(bandStrength, 2),
          bandSearchStartPx: bandStart,
          bandPreferredPx: Math.round(bandPreferred),
          chestRow,
          chestStrength: safeNum(chestStrength, 2),
          chestY: chestY != null ? safeNum(chestY, 4) : null,
          cradleRow,
          cradleStrength: safeNum(cradleStrength, 2),
          cradleY: cradleY != null ? safeNum(cradleY, 4) : null,
          cradleCfTop: cradleCfTop
            ? { x: safeNum(cradleCfTop.x, 4), y: safeNum(cradleCfTop.y, 4) }
            : null,
          cradleCfTopInkRatio: safeNum(cradleCfTopInkRatio, 4),
          cradleCfTopBandInkRatio: safeNum(cradleCfTopBandInkRatio, 4),
          cradleCfTopSeamHorizontalRun,
          cradleCfTopSeamSingleRowRun,
          cradleCfTopMissingReason: cradleCfTopReject,
          cradleCfTopDipProjected,
          cradleCfTopJunction,
          cradleCfSeamLeftReachPx,
          cradleCfSeamRightReachPx,
          cradleCupTop: cradleCupTop
            ? { x: safeNum(cradleCupTop.x, 4), y: safeNum(cradleCupTop.y, 4) }
            : null,
          cradleCupBottom: cradleCupBottom
            ? { x: safeNum(cradleCupBottom.x, 4), y: safeNum(cradleCupBottom.y, 4) }
            : null,
          cradleCupSide,
          cradleCupTier,
          cradleCupTopInkRatio: safeNum(cradleCupTopInkRatio, 4),
          cradleCupBandInkRatio: safeNum(cradleCupBandInkRatio, 4),
          cradleCupColInkRatio: safeNum(cradleCupColInkRatio, 4),
          cradleCupSegmentsWithInk,
          cradleCupSegmentCount,
          cradleCupEdgePenalty: safeNum(cradleCupEdgePenalty, 4),
          cradleCupMissingReason: cradleCupReject,
          underbustRow,
          underbustStrength: safeNum(underbustStrength, 2),
          underbustRunPx,
          minRowSpanPx: minRowSpan,
        },
        apex: {
          leftCandidate: apexLeftCandidate ? {
            x: safeNum(apexLeftCandidate.point.x, 4),
            y: safeNum(apexLeftCandidate.point.y, 4),
            confidence: safeNum(apexLeftCandidate.confidence, 3),
            support: apexLeftCandidate.support || null,
          } : null,
          rightCandidate: apexRightCandidate ? {
            x: safeNum(apexRightCandidate.point.x, 4),
            y: safeNum(apexRightCandidate.point.y, 4),
            confidence: safeNum(apexRightCandidate.confidence, 3),
            support: apexRightCandidate.support || null,
          } : null,
          accepted: !!apexPair,
          missingReason: apexPair ? null : 'No reliable strap-cup joining seam / highest cup point was detected.',
        },
        cupModel: cupModel ? {
          side: cupModel.side,
          viewRole: cupModel.viewRole,
          visibility: cupModel.visibility,
          topFromApex: cupModel.topFromApex,
          bottomFromSeam: cupModel.bottomFromSeam,
          topPoint: cupModel.topPoint
            ? { x: safeNum(cupModel.topPoint.x, 4), y: safeNum(cupModel.topPoint.y, 4) }
            : null,
          bottomPoint: cupModel.bottomPoint
            ? { x: safeNum(cupModel.bottomPoint.x, 4), y: safeNum(cupModel.bottomPoint.y, 4) }
            : null,
          innerEdge: cupModel.innerEdge
            ? { x: safeNum(cupModel.innerEdge.x, 4), y: safeNum(cupModel.innerEdge.y, 4) }
            : null,
          outerEdgeNearArmhole: cupModel.outerEdgeNearArmhole
            ? { x: safeNum(cupModel.outerEdgeNearArmhole.x, 4), y: safeNum(cupModel.outerEdgeNearArmhole.y, 4) }
            : null,
          centerPoint: cupModel.centerPoint
            ? { x: safeNum(cupModel.centerPoint.x, 4), y: safeNum(cupModel.centerPoint.y, 4) }
            : null,
          apexAnchor: cupModel.apexAnchor
            ? { x: safeNum(cupModel.apexAnchor.x, 4), y: safeNum(cupModel.apexAnchor.y, 4) }
            : null,
          seamAnchor: cupModel.seamAnchor
            ? { x: safeNum(cupModel.seamAnchor.x, 4), y: safeNum(cupModel.seamAnchor.y, 4) }
            : null,
          contourConfidence: safeNum(cupModel.contourConfidence, 3),
          seamConfidence: safeNum(cupModel.seamConfidence, 3),
          texturePenalty: safeNum(cupModel.texturePenalty, 3),
          sideReason: cupModel.sideReason,
          visibilityReason: cupModel.visibilityReason,
          rejectedTextureReason: cupModel.rejectedTextureReason,
          reason: cupModel.reason,
          diagnostics: cupModel.diagnostics
            ? {
                hasFrontInner: !!cupModel.diagnostics.hasFrontInner,
                apexLeftPresent: !!cupModel.diagnostics.apexLeftPresent,
                apexRightPresent: !!cupModel.diagnostics.apexRightPresent,
                apexLeftConf: safeNum(cupModel.diagnostics.apexLeftConf, 3),
                apexRightConf: safeNum(cupModel.diagnostics.apexRightConf, 3),
                sidePicked: cupModel.diagnostics.sidePicked,
                apexPointPresent: !!cupModel.diagnostics.apexPointPresent,
                apexConfPicked: safeNum(cupModel.diagnostics.apexConfPicked, 3),
                cradleCupTopPresent: !!cupModel.diagnostics.cradleCupTopPresent,
                cradleCupSide: cupModel.diagnostics.cradleCupSide,
                cradleCupSideMatches: !!cupModel.diagnostics.cradleCupSideMatches,
                cradleYPresent: !!cupModel.diagnostics.cradleYPresent,
                cradleCupConfidence: safeNum(cupModel.diagnostics.cradleCupConfidence, 3),
                apexY: safeNum(cupModel.diagnostics.apexY, 4),
                seamY: safeNum(cupModel.diagnostics.seamY, 4),
                topFromApex: !!cupModel.diagnostics.topFromApex,
                bottomFromSeam: !!cupModel.diagnostics.bottomFromSeam,
                visibility: cupModel.diagnostics.visibility,
                visibilityReason: cupModel.diagnostics.visibilityReason,
                innerEdgeSource: cupModel.diagnostics.innerEdgeSource || null,
                innerEdgeX: safeNum(cupModel.diagnostics.innerEdgeX, 4),
                outerEdgeX: safeNum(cupModel.diagnostics.outerEdgeX, 4),
                innerEdgeSupported: cupModel.diagnostics.innerEdgeSupported !== false,
              }
            : null,
        } : null,
        cols: {
          noiseFloor: safeNum(colNoiseFloor, 2),
          medianCol,
          sideLeftCol,
          sideLeftStrength: safeNum(sideLeftStrength, 2),
          sideRightCol,
          sideRightStrength: safeNum(sideRightStrength, 2),
          axisGuardPx: axisGuard,
          innerScanLoPx: innerLo,
          innerScanHiPx: innerHi,
        },
        backFeatures: backFeatures ? {
          axisX: backFeatures.axisX,
          chestY: backFeatures.chestY,
          bandY: backFeatures.bandY,
          sideLeftX: backFeatures.sideLeftX,
          sideRightX: backFeatures.sideRightX,
        } : null,
        confidence: { ...detectionResult.confidence },
        quality: safeNum(detectionResult.quality, 4),
        // Normalized segmentation-stage verdict (Phase 3): backend, coverage,
        // deterministic quality, and the weak-segmentation review signal.
        segmentation: detectionResult.segmentation,
        stageTimingsMs,
        // Layer-by-layer view of the POM 6 / 7 / 8 decision pipeline per
        // rule.md. Each layer summarises the evidence that feeds into the
        // next so the TD can answer "why is this POM REVIEW_ONLY?" without
        // reading the detection source.
        //
        // L1 frame:    coordinate-prior confidences (axis from symmetry,
        //              baseline from band-row strength).
        // L2 regions:  semantic search zones in pixel coords (CF / cup-side
        //              / band / above-cradle).
        // L3 seams:    per-seam evidence and decision. confidence in [0,1].
        //              missingReason is null on accept, populated on reject.
        // L4/L5/L6:    POM emission + cross-POM validation lives in the
        //              drafter (auto-drafts.js POM_TEMPLATE.requiredAnchors).
        //              The detector exposes the inputs; the drafter applies
        //              the missing-anchor guard that drives REVIEW_ONLY.
        layers: {
          frame: {
            axisXpx: Math.round(axisXpx),
            bandRowPx: bandRow,
            axisConfidence: safeNum(axisConfidence, 4),
            baselineConfidence: safeNum(baselineConfidence, 4),
            // Per rule.md L1, low axis/baseline confidence should bias POM
            // 6 / 7 / 8 toward REVIEW_ONLY even if downstream signals look
            // OK. Surface a single flag so the drafter / spec-panel can
            // present a coherent reason.
            frameWarning: inkCleanupReverted
              ? 'Ink cleanup was reverted (very faint/dashed sketch or a heavy scan frame) — the outline may include page edges or speckle; verify the detected shape and all POMs.'
              : ((axisConfidence < 0.4 || baselineConfidence < 0.4)
                ? 'Low axis or baseline confidence — treat POM 6/7/8 with caution.'
                : ((segmentation && segmentation.weak)
                  ? 'Weak segmentation (low mask quality) — the detected ink may be noisy or incomplete; verify all POMs.'
                  : null)),
            // D7: raw boolean so the spec-panel / drafter can react
            // specifically to a fail-open ink-cleanup revert if desired.
            inkCleanupReverted: inkCleanupReverted,
          },
          regions: {
            // CF zone: narrow band around the symmetry axis. POM 6 / POM 8
            // candidates must live inside this zone.
            cfZonePx: {
              xLo: Math.max(0, axisPx - Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18))),
              xHi: Math.min(w - 1, axisPx + Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18))),
            },
            // Bottom-cup zone: between the CF axis buffer and the side seam
            // buffer. POM 7 candidates must live inside this zone.
            bottomCupZonePx: {
              left:  { xLo: sideLeftCol > 0 ? sideLeftCol + Math.max(2, Math.round((maxX - minX) * 0.03)) : null,
                       xHi: axisPx - Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18)) },
              right: { xLo: axisPx + Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18)),
                       xHi: sideRightCol > 0 ? sideRightCol - Math.max(2, Math.round((maxX - minX) * 0.03)) : null },
            },
            bandRowPx: bandRow,
            cradleRowPx: cradleRow,
          },
          seams: {
            // Cradle/cup-bottom seam at center front — POM 6 start endpoint.
            // Accepted only with real ink near the cradle row × axis cell.
            cradleCfSeam: {
              accepted: !!cradleCfTop,
              point: cradleCfTop
                ? { x: safeNum(cradleCfTop.x, 4), y: safeNum(cradleCfTop.y, 4) }
                : null,
              inkRatio: safeNum(cradleCfTopInkRatio, 4),
              bandInkRatio: safeNum(cradleCfTopBandInkRatio, 4),
              seamHorizontalRun: cradleCfTopSeamHorizontalRun,
              seamSingleRowRun: cradleCfTopSeamSingleRowRun,
              confidence: cradleCfTop ? safeNum(sigConf(cradleStrength, rowNoiseFloor), 4) : 0,
              missingReason: cradleCfTopReject,
            },
            // Cradle/cup-bottom seam at the bottom-cup position — POM 7
            // start endpoint. Accepted only when cradle ink + band ink +
            // vertical column ink (continuous OR dashed via segments)
            // co-occur at a column off the CF axis and off the side seam.
            cradleBottomCupSeam: {
              accepted: !!cradleCupTop,
              point: cradleCupTop
                ? { x: safeNum(cradleCupTop.x, 4), y: safeNum(cradleCupTop.y, 4) }
                : null,
              side: cradleCupSide,
              cradleInkRatio: safeNum(cradleCupTopInkRatio, 4),
              bandInkRatio: safeNum(cradleCupBandInkRatio, 4),
              colInkRatio: safeNum(cradleCupColInkRatio, 4),
              segmentsWithInk: cradleCupSegmentsWithInk,
              segmentCount: cradleCupSegmentCount,
              edgePenalty: safeNum(cradleCupEdgePenalty, 4),
              confidence: cradleCupTop ? safeNum(sigConf(cradleStrength, rowNoiseFloor), 4) : 0,
              missingReason: cradleCupReject,
            },
            // Upper-cup seam at center front — POM 8 start endpoint. For now
            // sourced from cfTopY (topmost CF-column ink); the drafter
            // currently consumes the cf-top anchor, which falls back to
            // view-box ratio when cfTopY is null. The frame warning above
            // tracks whether that fallback is happening.
            upperCupCfSeam: {
              accepted: cfTopY != null,
              point: cfTopY != null ? { x: safeNum(axisX, 4), y: safeNum(cfTopY, 4) } : null,
              source: cfTopY != null ? 'cfTopInkBound' : 'viewBoxFallback',
              missingReason: cfTopY != null ? null : 'No CF-column ink found above the band region.',
            },
            // Side seam (POM 11). Listed so cross-POM validation can compare
            // POM 7 candidates against the side seam x.
            sideSeam: {
              left:  sideLeftX  != null ? { x: safeNum(sideLeftX, 4) }  : null,
              right: sideRightX != null ? { x: safeNum(sideRightX, 4) } : null,
            },
          },
          // Cross-POM rule status (rule.md L5). These rules are enforced
          // either by construction (POM 8 end == POM 6 start because both
          // read cradle-cf-top) or by the detector's search-window buffers
          // (POM 7 ≥ 18% bbox width off CF, ≥ 3% off side seam). Surface
          // the status so the TD can confirm.
          crossPom: {
            pom8EndEqualsPom6Start: !!cradleCfTop,
            pom7DistinctFromPom6:
              !!(cradleCupTop && cradleCfTop)
                ? Math.abs(cradleCupTop.x - cradleCfTop.x) > 0.05
                : null,
            pom7OffSideSeam: !!cradleCupTop
              ? (cradleCupSide < 0
                  ? (sideLeftX  == null || Math.abs(cradleCupTop.x - sideLeftX)  > 0.03)
                  : (sideRightX == null || Math.abs(cradleCupTop.x - sideRightX) > 0.03))
              : null,
          },
        },
      };
    }
    return detectionResult;
  }

  function estimateBorderBackground(pixels, w, h) {
    const samples = [];
    const step = Math.max(1, Math.floor(Math.min(w, h) / 40));
    const add = (x, y) => {
      const i = (y * w + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push({ r, g, b, lum });
    };
    for (let x = 0; x < w; x += step) {
      add(x, 0);
      add(x, h - 1);
    }
    // Start at `step` and stop before the last row so the four corners aren't
    // sampled twice (the top/bottom loop already covered y = 0 and y = h - 1),
    // which slightly over-weighted them in the brightest-40% background mean.
    for (let y = step; y < h - 1; y += step) {
      add(0, y);
      add(w - 1, y);
    }
    if (!samples.length) return { r: 255, g: 255, b: 255, lum: 255 };
    samples.sort((a, b) => a.lum - b.lum);
    const start = Math.floor(samples.length * 0.60);
    const bright = samples.slice(start);
    const src = bright.length ? bright : samples;
    let r = 0, g = 0, b = 0, lum = 0;
    for (const s of src) {
      r += s.r; g += s.g; b += s.b; lum += s.lum;
    }
    const n = src.length || 1;
    return { r: r / n, g: g / n, b: b / n, lum: lum / n };
  }

  function buildMaskStats(mask, w, h, bounds) {
    const x0 = bounds ? clamp(Math.floor(bounds.minX), 0, w - 1) : 0;
    const y0 = bounds ? clamp(Math.floor(bounds.minY), 0, h - 1) : 0;
    const x1 = bounds ? clamp(Math.ceil(bounds.maxX), 0, w - 1) : w - 1;
    const y1 = bounds ? clamp(Math.ceil(bounds.maxY), 0, h - 1) : h - 1;
    const colDark = new Uint32Array(w);
    const rowDark = new Uint32Array(h);
    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = y0; y <= y1; y += 1) {
      const base = y * w;
      for (let x = x0; x <= x1; x += 1) {
        if (!mask[base + x]) continue;
        colDark[x] += 1;
        rowDark[y] += 1;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { count, minX, minY, maxX, maxY, colDark, rowDark };
  }

  function statsToBounds(stats) {
    return {
      minX: stats.minX,
      minY: stats.minY,
      maxX: stats.maxX,
      maxY: stats.maxY,
      count: stats.count,
    };
  }

  function normalizeBounds(bounds, w, h) {
    return {
      x: clamp01(bounds.minX / w),
      y: clamp01(bounds.minY / h),
      width: clamp01((bounds.maxX - bounds.minX + 1) / w),
      height: clamp01((bounds.maxY - bounds.minY + 1) / h),
      count: bounds.count || 0,
    };
  }

  function filterInkComponents(rawMask, w, h, minCount) {
    const total = w * h;
    const visited = new Uint8Array(total);
    const out = new Uint8Array(total);
    const queue = new Int32Array(total);
    const keptComponents = [];
    let componentCount = 0;

    for (let start = 0; start < total; start += 1) {
      if (!rawMask[start] || visited[start]) continue;
      componentCount += 1;
      let head = 0, tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let count = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      let sumX = 0, sumY = 0;
      let touches = 0;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = Math.floor(idx / w);
        count += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        for (let yy = y - 1; yy <= y + 1; yy += 1) {
          if (yy < 0 || yy >= h) continue;
          const rowBase = yy * w;
          for (let xx = x - 1; xx <= x + 1; xx += 1) {
            if (xx < 0 || xx >= w || (xx === x && yy === y)) continue;
            const ni = rowBase + xx;
            if (visited[ni] || !rawMask[ni]) continue;
            visited[ni] = 1;
            queue[tail++] = ni;
          }
        }
      }

      if (minX === 0) touches += 1;
      if (maxX === w - 1) touches += 1;
      if (minY === 0) touches += 1;
      if (maxY === h - 1) touches += 1;

      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const area = Math.max(1, width * height);
      const density = count / area;
      const longStroke = Math.max(width, height) >= Math.min(w, h) * 0.08 && count >= minCount * 0.45;
      const likelyFrame = touches >= 2 && width > w * 0.82 && height > h * 0.82 && density < 0.10;
      const keep = !likelyFrame && (count >= minCount || longStroke);
      if (!keep) continue;

      for (let i = 0; i < tail; i += 1) out[queue[i]] = 1;
      keptComponents.push({
        count, minX, minY, maxX, maxY, width, height, area, density,
        cx: sumX / count,
        cy: sumY / count,
        touches,
      });
    }

    return { mask: out, keptComponents, componentCount };
  }

  function detectSketchViewBoxes(components, fallbackStats, w, h) {
    if (!components || !components.length) {
      return fallbackStats && fallbackStats.maxX >= 0 ? [statsToBounds(fallbackStats)] : [];
    }
    const largest = components.reduce((m, c) => Math.max(m, c.count), 0);
    const minCount = Math.max(8, largest * 0.04);
    const candidates = components
      .filter(c => c.count >= minCount || c.area >= w * h * 0.002)
      .sort((a, b) => a.minX - b.minX);
    if (!candidates.length) return [statsToBounds(fallbackStats)];

    const groups = [];
    for (const c of candidates) {
      const last = groups[groups.length - 1];
      if (!last) {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
        continue;
      }
      const gap = c.minX - last.maxX;
      const lastW = Math.max(1, last.maxX - last.minX + 1);
      const cW = Math.max(1, c.maxX - c.minX + 1);
      const yOverlap = Math.max(0, Math.min(last.maxY, c.maxY) - Math.max(last.minY, c.minY) + 1);
      const yOverlapRatio = yOverlap / Math.max(1, Math.min(last.maxY - last.minY + 1, c.maxY - c.minY + 1));
      const allowedGap = Math.max(10, Math.min(lastW, cW) * 0.28, w * 0.035);
      const alignedCloseGap = gap <= Math.max(allowedGap, w * 0.08) && yOverlapRatio > 0.55;
      if (gap <= allowedGap || alignedCloseGap) {
        last.minX = Math.min(last.minX, c.minX);
        last.minY = Math.min(last.minY, c.minY);
        last.maxX = Math.max(last.maxX, c.maxX);
        last.maxY = Math.max(last.maxY, c.maxY);
        last.count += c.count;
      } else {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
      }
    }
    return groups;
  }

  function choosePrimaryViewBox(viewBoxes, dark, w, h) {
    if (!viewBoxes || !viewBoxes.length) return -1;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < viewBoxes.length; i += 1) {
      const b = viewBoxes[i];
      const width = Math.max(1, b.maxX - b.minX + 1);
      const height = Math.max(1, b.maxY - b.minY + 1);
      const centroid = (b.minX + b.maxX) / 2;
      const axis = refineAxisBySymmetry(dark, w, b.minX, b.maxX, b.minY, b.maxY, centroid);
      const sym = computeSymmetryScore(dark, w, axis, b.minX, b.maxX, b.minY, b.maxY);
      const center = (b.minX + b.maxX) / 2 / w;
      const centerBonus = 1 - Math.min(1, Math.abs(center - 0.5) * 1.4);
      const shapeBonus = Math.min(1, height / Math.max(1, width)) * 0.18;
      const score = (b.count || 1) * (0.62 + sym * 0.55 + centerBonus * 0.10 + shapeBonus);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function computeRowSpans(mask, w, minX, maxX, minY, maxY) {
    const spans = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let left = -1, right = -1;
      for (let x = minX; x <= maxX; x += 1) {
        if (!mask[base + x]) continue;
        if (left < 0) left = x;
        right = x;
      }
      spans[y] = left >= 0 ? right - left + 1 : 0;
    }
    return spans;
  }

  // Longest contiguous dark run per row. Solid seam lines have a long single
  // run; dense lace patterns have many short runs at high total density. This
  // is the signal that lets the underbust-seam detector beat the lace band.
  function computeRowMaxRun(mask, w, minX, maxX, minY, maxY) {
    const runs = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let cur = 0, best = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) {
          cur += 1;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      runs[y] = best;
    }
    return runs;
  }

  // Snap a detected band row to the SOLID bottom edge of the band, not a zig-zag
  // elastic line drawn above it. Scanned row by row, a zig-zag has only short
  // horizontal runs (its diagonal strokes crossing each row), while the solid
  // edge is one long continuous run. We search a tight window around the detected
  // band zone and take the LOWEST row that reads as solid, so the bottom-band and
  // center-front-bottom anchors land on the real edge under any decorative
  // stitching. Returns the original row when no solid line stands out (e.g. a
  // band drawn only as a zig-zag), so non-banded sketches are untouched.
  function snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bandWidth, bandHeight) {
    if (bandRow <= 0) return bandRow;
    const lo = Math.max(minY, bandRow - Math.round(bandHeight * 0.04));
    const hi = Math.min(maxY, bandRow + Math.round(bandHeight * 0.12));
    let peakRun = 0;
    for (let y = lo; y <= hi; y += 1) if (rowRun[y] > peakRun) peakRun = rowRun[y];
    if (peakRun < bandWidth * 0.30) return bandRow;
    const solidThresh = Math.max(bandWidth * 0.30, peakRun * 0.6);
    for (let y = hi; y >= lo; y -= 1) if (rowRun[y] >= solidThresh) return y;
    return bandRow;
  }

  function countDarkByColumnInRange(mask, w, minX, maxX, minY, maxY) {
    const counts = new Uint32Array(w);
    const y0 = Math.max(0, minY);
    const y1 = Math.max(y0, maxY);
    for (let y = y0; y <= y1; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) counts[x] += 1;
      }
    }
    return counts;
  }

  // Walk inward along a horizontal band of rows and return the first column
  // where ink appears. Used to snap chest-left/right (and band-left/right) to
  // the actual ink endpoints instead of view-box edges. halfBand widens the
  // search vertically so a slightly-off chest row still finds the line.
  function findHorizontalInkBound(dark, w, rowCenter, halfBand, fromX, toX, direction) {
    const yLo = Math.max(0, rowCenter - halfBand);
    const yHi = rowCenter + halfBand;
    if (direction > 0) {
      for (let x = fromX; x <= toX; x += 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    } else {
      for (let x = fromX; x >= toX; x -= 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    }
    return -1;
  }

  // Walk vertically along a thin column-band and return the first row with
  // ink. Used to snap CF-top to where the cleavage actually begins instead of
  // a hardcoded 4% offset from the view-box top.
  function findVerticalInkBound(dark, w, colCenter, halfBand, fromY, toY, direction) {
    const xLo = Math.max(0, colCenter - halfBand);
    const xHi = colCenter + halfBand;
    if (direction > 0) {
      for (let y = fromY; y <= toY; y += 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    } else {
      for (let y = fromY; y >= toY; y -= 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    }
    return -1;
  }

  // Potrace vector tracer — wraps the singleton Potrace API (potrace.js) into
  // a Promise that takes the ink mask and returns normalized contour paths.
  //
  // Why we trace at all: the row/column peak detector finds straight reference
  // lines well (chest, band, axis), but cup arcs, strap curves and the back
  // hook are curved. Tracing gives real cubic-Bezier control points instead of
  // hand-tuned guesses.
  //
  // Returns: { paths: [{ start: {x,y}, segments: [{type:'C'|'L', c1?, c2?, end}], bbox }], sampleWidth, sampleHeight }
  // All coordinates are normalized to [0,1] of the source image.
  function tracePotraceFromMask(dark, w, h) {
    if (typeof Potrace === 'undefined' || !Potrace || typeof Potrace.process !== 'function') {
      return Promise.resolve(null);
    }
    // Render the binary mask as black ink on white background. Potrace
    // expects a normal raster image; it re-binarises from luminance.
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let p = 0, i = 0; p < dark.length; p += 1, i += 4) {
      const v = dark[p] ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    let url;
    try {
      url = off.toDataURL('image/png');
    } catch (err) {
      console.warn('[Auto Mode] Potrace: cannot encode mask to PNG:', err);
      return Promise.resolve(null);
    }

    // Tracing params tuned for technical-sketch ink: small turdsize so we
    // keep thin strap edges; alphamax 1.0 keeps smooth curves; optcurve so we
    // emit beziers instead of dense polylines.
    Potrace.setParameter({
      turdsize: 4,
      alphamax: 1.0,
      optcurve: true,
      opttolerance: 0.2,
      turnpolicy: 'minority',
    });
    Potrace.loadImageFromUrl(url);

    return new Promise((resolve) => {
      let waited = 0;
      function tick() {
        // potrace.js sets isReady inside img.onload — poll until it flips.
        if (!Potrace.img || !Potrace.img.complete) {
          waited += 1;
          if (waited > 200) { resolve(null); return; } // 4s ceiling
          setTimeout(tick, 20);
          return;
        }
        try {
          Potrace.process(() => {
            try {
              const svg = Potrace.getSVG(1, 'curve');
              const paths = parsePotraceSvgPaths(svg, w, h);
              resolve({ paths, sampleWidth: w, sampleHeight: h });
            } catch (err) {
              console.warn('[Auto Mode] Potrace: SVG parse failed:', err);
              resolve(null);
            }
          });
        } catch (err) {
          console.warn('[Auto Mode] Potrace.process failed:', err);
          resolve(null);
        }
      }
      tick();
    });
  }

  // Parse the SVG that Potrace emits. The SVG contains one <path d="...">
  // built from absolute M / C / L commands (no relatives, no arcs). We split
  // on M to get subpaths, then walk each subpath's commands.
  function parsePotraceSvgPaths(svg, w, h) {
    const match = /<path[^>]*\sd="([^"]+)"/.exec(svg);
    if (!match) return [];
    const d = match[1];
    // Tokens: command letter OR a signed decimal number.
    const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) || [];
    const paths = [];
    let current = null;
    let cursorX = 0, cursorY = 0;
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === 'M') {
        if (current && current.segments.length) paths.push(finalizePath(current, w, h));
        cursorX = num(); cursorY = num();
        current = { start: { x: cursorX, y: cursorY }, segments: [] };
      } else if (t === 'L' && current) {
        // Potrace's CORNER segment emits FOUR numbers: an interior corner
        // vertex then the endpoint ("L x1 y1 x2 y2"). Push both as polyline
        // samples and advance the cursor to the true endpoint. (Reading only
        // two took the corner as the endpoint and desynced every later segment.)
        const x1 = num(); const y1 = num();
        const x2 = num(); const y2 = num();
        current.segments.push({ type: 'L', end: { x: x1, y: y1 } });
        current.segments.push({ type: 'L', end: { x: x2, y: y2 } });
        cursorX = x2; cursorY = y2;
      } else if (t === 'C' && current) {
        const c1x = num(); const c1y = num();
        const c2x = num(); const c2y = num();
        const ex  = num(); const ey  = num();
        current.segments.push({
          type: 'C',
          c1: { x: c1x, y: c1y },
          c2: { x: c2x, y: c2y },
          end:{ x: ex,  y: ey  },
        });
        cursorX = ex; cursorY = ey;
      } else {
        // Unknown token — number outside a command (shouldn't happen with
        // Potrace's output). Skip.
      }
    }
    if (current && current.segments.length) paths.push(finalizePath(current, w, h));
    return paths;
  }

  function finalizePath(path, w, h) {
    const pts = [path.start, ...path.segments.map(s => s.end)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Normalize to [0,1] over the source image so the consumer doesn't need
    // to know the analysis sample dimensions.
    const norm = (p) => ({ x: p.x / w, y: p.y / h });
    return {
      start: norm(path.start),
      segments: path.segments.map(s => {
        if (s.type === 'C') return { type: 'C', c1: norm(s.c1), c2: norm(s.c2), end: norm(s.end) };
        return { type: 'L', end: norm(s.end) };
      }),
      bbox: {
        x: minX / w,
        y: minY / h,
        width: (maxX - minX) / w,
        height: (maxY - minY) / h,
      },
      pointCount: pts.length,
    };
  }

  // Score how well a traced contour fits the line segment AB. The returned
  // shape contains bezier control points sampled from the matching arc — the
  // POM generator uses these for POM 9 / 10 / 14 instead of guessed S-curves.
  //
  // "preferThin" weights thin contours (real seam lines, strap edges) higher
  // than the bra outline.
  function matchContourForCurve(paths, A, B, options) {
    if (!paths || !paths.length || !A || !B) return null;
    const preferThin = !!(options && options.preferThin);
    const ax = A.x, ay = A.y, bx = B.x, by = B.y;
    const lineLen = Math.hypot(bx - ax, by - ay);
    if (lineLen < 1e-6) return null;
    // Tolerance: how far from the AB line a contour's nearest sample can be.
    const tol = Math.max(0.04, lineLen * 0.35);

    let best = null;
    let bestScore = -Infinity;
    for (const path of paths) {
      if (!path || !path.segments || !path.segments.length) continue;
      const bbox = path.bbox || { width: 1, height: 1 };
      // Reject paths whose bbox can't possibly contain both endpoints.
      const x0 = bbox.x - tol, y0 = bbox.y - tol;
      const x1 = bbox.x + bbox.width + tol, y1 = bbox.y + bbox.height + tol;
      if (ax < x0 || ax > x1 || bx < x0 || bx > x1 ||
          ay < y0 || ay > y1 || by < y0 || by > y1) continue;
      const samples = samplePathPoints(path);
      if (samples.length < 4) continue;
      let nearestA = Infinity, nearestB = Infinity;
      let idxA = -1, idxB = -1;
      for (let i = 0; i < samples.length; i += 1) {
        const dA = Math.hypot(samples[i].x - ax, samples[i].y - ay);
        const dB = Math.hypot(samples[i].x - bx, samples[i].y - by);
        if (dA < nearestA) { nearestA = dA; idxA = i; }
        if (dB < nearestB) { nearestB = dB; idxB = i; }
      }
      if (nearestA > tol || nearestB > tol) continue;
      // Thin contours score higher when preferThin is set — strap edges /
      // seam lines beat the bra outline.
      const aspect = Math.min(bbox.width, bbox.height) / Math.max(1e-6, Math.max(bbox.width, bbox.height));
      const thinness = preferThin ? clamp01(1 - aspect) : 0;
      const proximity = 1 - clamp01((nearestA + nearestB) / (2 * tol));
      const score = proximity * 1.0 + thinness * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { path, samples, idxA, idxB };
      }
    }
    if (!best) return null;

    // Walk the closed contour from idxA → idxB the short way around (the seam
    // is one side of the loop). Sample 4 evenly-spaced points along that arc
    // and fit a cubic bezier to them by setting c1/c2 at the 1/3 and 2/3
    // sample positions.
    const arc = takeShortestArc(best.samples, best.idxA, best.idxB);
    if (arc.length < 4) return null;
    const p1 = arc[Math.floor(arc.length / 3)];
    const p2 = arc[Math.floor((2 * arc.length) / 3)];
    // A cubic does NOT pass through its control points, so using on-curve arc
    // samples directly as controls makes the curve overshoot the seam. Solve in
    // closed form for the controls C1,C2 of the cubic [A,C1,C2,B] that PASSES
    // THROUGH p1 at t=1/3 and p2 at t=2/3. Controls may fall outside [0,1].
    const fitControls = (a, b, q1, q2) => {
      const u = 27 * q1 - 8 * a - b;
      const v = 27 * q2 - a - 8 * b;
      return { c1: (2 * u - v) / 18, c2: (2 * v - u) / 18 };
    };
    const fitX = fitControls(A.x, B.x, p1.x, p2.x);
    const fitY = fitControls(A.y, B.y, p1.y, p2.y);
    return {
      c1: { x: fitX.c1, y: fitY.c1 },
      c2: { x: fitX.c2, y: fitY.c2 },
      arcLength: arc.length,
      score: bestScore,
    };
  }

  // Convert a path into a flat array of polyline samples. Cubic-segment
  // sampling at 6 points is enough to find the nearest-to-endpoint vertex.
  function samplePathPoints(path) {
    const out = [path.start];
    for (const seg of path.segments) {
      if (seg.type === 'C') {
        const prev = out[out.length - 1];
        for (let t = 0.2; t < 1; t += 0.2) {
          out.push(cubicBezierPoint(prev, seg.c1, seg.c2, seg.end, t));
        }
        out.push(seg.end);
      } else {
        out.push(seg.end);
      }
    }
    return out;
  }

  function cubicBezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const uu = u * u;
    const uuu = uu * u;
    const tt = t * t;
    const ttt = tt * t;
    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    };
  }

  function takeShortestArc(samples, idxA, idxB) {
    if (samples.length === 0) return [];
    const n = samples.length;
    let a = idxA, b = idxB;
    if (a === b) return [samples[a]];
    // Forward arc length idxA→idxB
    const forwardLen = (b - a + n) % n;
    const backwardLen = n - forwardLen;
    const arc = [];
    if (forwardLen <= backwardLen) {
      for (let k = 0; k <= forwardLen; k += 1) arc.push(samples[(a + k) % n]);
    } else {
      for (let k = 0; k <= backwardLen; k += 1) arc.push(samples[(a - k + n) % n]);
    }
    return arc;
  }

  // Per-view feature pass: a self-contained mini-detector that runs inside a
  // single view's bounding box. Used to give the back view its own axis,
  // chest/band rows, side seams, and ink endpoints — so back-view anchors
  // snap to actual ink rather than hardcoded view-box ratios.
  function detectFeaturesInViewBox(dark, w, h, viewBoxPx) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;

    // Local row/column ink counts restricted to the view box.
    const rowDark = new Uint32Array(h);
    const colDark = new Uint32Array(w);
    let count = 0;
    let xSum = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let rowCount = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) {
          rowCount += 1;
          colDark[x] += 1;
          xSum += x;
          count += 1;
        }
      }
      rowDark[y] = rowCount;
    }
    if (count < 60) return null;
    const centroidX = xSum / count;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);

    // Smoothed peak picks (mirror of the front-view logic).
    const rowSmooth = smooth1D(rowDark);
    const colSmooth = smooth1D(colDark);

    // Band: bottom 40% of the view height, strongest horizontal row.
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const bandStart = Math.round(minY + bh * 0.58);
    let bandRow = -1; let bandStrength = 0;
    for (let y = bandStart; y <= maxY; y += 1) {
      if (rowSmooth[y] > bandStrength) { bandStrength = rowSmooth[y]; bandRow = y; }
    }
    const bandEdgeRow = snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bw, bh);
    // Chest / top-band: upper 50% of the view height.
    const chestEnd = Math.round(minY + bh * 0.50);
    let chestRow = -1; let chestStrength = 0;
    for (let y = minY + Math.round(bh * 0.06); y <= chestEnd; y += 1) {
      if (rowSmooth[y] > chestStrength) { chestStrength = rowSmooth[y]; chestRow = y; }
    }

    // Side seams: strongest verticals on either side of the axis, with a
    // small guard band so the centerline doesn't win.
    const axisGuard = Math.max(4, Math.round(bw * 0.08));
    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      if (colSmooth[x] > sideLeftStrength) { sideLeftStrength = colSmooth[x]; sideLeftCol = x; }
    }
    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      if (colSmooth[x] > sideRightStrength) { sideRightStrength = colSmooth[x]; sideRightCol = x; }
    }

    // Walk inward along chest / band rows to find ink endpoints.
    const halfRowBand = Math.max(2, Math.round(bh * 0.012));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, maxX, minX, -1) : -1;

    // Walk down the symmetry axis to find the topmost ink (cleavage / strap
    // notch). halfColBand widens it slightly so a center-line off by 1px
    // still scores.
    const halfColBand = Math.max(2, Math.round(bw * 0.020));
    const axisTopPx = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const axisBottomPx = findVerticalInkBound(dark, w, axisPx, halfColBand, maxY, minY, -1);

    return {
      bbox: {
        x: minX / w, y: minY / h,
        width: bw / w, height: bh / h,
      },
      axisX: axisPx / w,
      chestY:    chestRow >= 0 ? chestRow / h : null,
      bandY:     bandEdgeRow >= 0 ? bandEdgeRow / h : null,
      sideLeftX: sideLeftCol  > 0 ? sideLeftCol  / w : null,
      sideRightX:sideRightCol > 0 ? sideRightCol / w : null,
      chestLeftX:  chestLeftPx  > 0 ? chestLeftPx  / w : null,
      chestRightX: chestRightPx > 0 ? chestRightPx / w : null,
      bandLeftX:   bandLeftPx   > 0 ? bandLeftPx   / w : null,
      bandRightX:  bandRightPx  > 0 ? bandRightPx  / w : null,
      axisTopY:    axisTopPx    >= 0 ? axisTopPx    / h : null,
      axisBottomY: axisBottomPx >= 0 ? axisBottomPx / h : null,
    };
  }

  function findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, side) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const guard = Math.max(4, Math.round(bboxW * 0.075));
    const y1 = bounds.minY + Math.round(bboxH * 0.08);
    const y2 = Math.min(
      bounds.maxY,
      chestRow > 0 ? chestRow + Math.round(bboxH * 0.05) : bounds.minY + Math.round(bboxH * 0.48)
    );
    const x1 = side < 0
      ? bounds.minX + Math.round(bboxW * 0.05)
      : axisPx + guard;
    const x2 = side < 0
      ? axisPx - guard
      : bounds.maxX - Math.round(bboxW * 0.05);
    if (x2 <= x1 || y2 <= y1) return null;

    const minSupport = Math.max(3, Math.round(bboxW * 0.012));
    const localRows = Math.max(5, Math.round(bboxH * 0.035));
    let best = null;
    for (let y = y1; y <= y2; y += 1) {
      const base = y * w;
      let runStart = -1;
      for (let x = x1; x <= x2 + 1; x += 1) {
        const on = x <= x2 && !!dark[base + x];
        if (on && runStart < 0) {
          runStart = x;
          continue;
        }
        if (on) continue;
        if (runStart < 0) continue;
        const startX = runStart;
        const runEnd = x - 1;
        const runWidth = runEnd - startX + 1;
        runStart = -1;
        if (runWidth < minSupport) continue;
        const cx = (startX + runEnd) / 2;
        if (side < 0 && cx > axisPx - guard) continue;
        if (side > 0 && cx < axisPx + guard) continue;

        let support = 0;
        let supportBottomY = y;
        const sx1 = Math.max(x1, Math.round(cx - bboxW * 0.035));
        const sx2 = Math.min(x2, Math.round(cx + bboxW * 0.035));
        for (let yy = y; yy <= Math.min(y2, y + localRows); yy += 1) {
          const b = yy * w;
          let rowSupport = 0;
          for (let xx = sx1; xx <= sx2; xx += 1) {
            if (dark[b + xx]) rowSupport += 1;
          }
          support += rowSupport;
          if (rowSupport > 0) supportBottomY = yy;
        }
        const verticalSpan = supportBottomY - y + 1;
        if (support < Math.max(minSupport * 2, verticalSpan * 2)) continue;
        // Reject decorative blobs (bow / scallop) sitting on the cup body
        // top. A real cup-strap join is the upper-outer corner of the cup,
        // so the cup BODY fills the rows below it — verticalSpan saturates
        // at localRows. A bow inked into the cup body lasts only a few
        // rows before its ribbon ends, leaving a gap below — verticalSpan
        // small. Require ≥ 40% of the lookahead window to be supported.
        if (verticalSpan < Math.max(3, Math.round((localRows + 1) * 0.4))) continue;

        const edgeBias = side < 0
          ? clamp01((axisPx - cx) / Math.max(1, bboxW * 0.45))
          : clamp01((cx - axisPx) / Math.max(1, bboxW * 0.45));
        const highCupBias = 1 - Math.min(1, (y - y1) / Math.max(1, y2 - y1));
        // Strongly (nonlinearly) prefer the TOPMOST qualifying run so the cup
        // top lands at the strap-cup join, not a denser lower band (e.g. lace
        // scallops or a cup-body seam). A lower band only wins when its support
        // dramatically outweighs the top's. The verticalSpan>=40% gate above
        // still requires real cup body below the pick, so this cannot snap onto
        // a thin strap-ribbon tick above the true cup seam.
        const topPref = 0.5 + 0.5 * highCupBias * highCupBias;
        const score = support * topPref * (0.75 + edgeBias * 0.25);
        if (!best || score > best.score || (Math.abs(score - best.score) < 1e-6 && y < best.y)) {
          best = {
            x: cx,
            // Inner edge of the strap ribbon at the join row — the edge nearer
            // the center front. POM 16 (apex distance) measures inner-edge to
            // inner-edge across the cup/front-strap joining seams, so the left
            // cup uses the run's right edge and the right cup its left edge.
            innerX: side < 0 ? runEnd : startX,
            // Outer edge (nearer the side seam) — POM 14's strap join anchor
            // sits on the OUTER edge of the join (ADR 0017, TD correction).
            outerX: side < 0 ? startX : runEnd,
            y,
            support,
            verticalSpan,
            score,
          };
        }
      }
    }
    if (!best) return null;

    const regionArea = Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1));
    const confidence = clamp01(0.18 + Math.min(0.42, best.support / Math.max(1, regionArea * 0.012))
      + Math.min(0.24, best.verticalSpan / Math.max(1, bboxH * 0.18))
      + Math.min(0.16, best.score / Math.max(1, bboxW)));
    if (confidence < 0.32) return null;
    return {
      point: { x: best.x / w, y: best.y / h },
      innerEdgeX: best.innerX / w,
      outerEdgeX: best.outerX / w,
      confidence,
      support: {
        count: best.support,
        verticalSpan: best.verticalSpan,
        score: Math.round(best.score * 100) / 100,
      },
    };
  }

  function validateCupApexPair(left, right, bounds, w, h) {
    if (!left || !right) return null;
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const lx = left.point.x * w;
    const rx = right.point.x * w;
    const ly = left.point.y * h;
    const ry = right.point.y * h;
    if (rx <= lx + bboxW * 0.12) return null;
    if (Math.abs(ly - ry) > bboxH * 0.22) return null;
    if (left.confidence < 0.32 || right.confidence < 0.32) return null;
    return { left, right };
  }

  // (Removed dead findCupApexFromInk: never referenced — the live pipeline
  // uses findCupStrapJoinFromInk / buildCupModel for apex detection.)

  // Front shoulder-strap start for POM 14. The TD measurement starts at the
  // upper joining seam of the stitched/elastic front strap section (the first
  // clear cross-strap seam above the cup), not at the cup/strap apex and not
  // at the topmost silhouette ink. Search a narrow column around the validated
  // left cup/strap join and choose the highest substantial horizontal run.
  // apexInfo is the cup/strap join the strap rises from — the RIGHT join on a
  // standard two-view sheet (ADR 0016), falling back to the left join when the
  // right one wasn't validated.
  function findFrontStrapStartFromInk(dark, w, h, bounds, apexInfo, chestRow) {
    if (!apexInfo || !apexInfo.point) return null;
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const cx = Math.round(apexInfo.point.x * w);
    const apexY = Math.round(apexInfo.point.y * h);
    const y1 = Math.max(bounds.minY + Math.round(bboxH * 0.025), 1);
    const y2 = Math.min(
      apexY - Math.max(3, Math.round(bboxH * 0.035)),
      chestRow > 0 ? chestRow - 2 : bounds.maxY);
    const halfWindow = Math.max(6, Math.round(bboxW * 0.055));
    const x1 = Math.max(bounds.minX, cx - halfWindow);
    const x2 = Math.min(bounds.maxX, cx + halfWindow);
    const minRun = Math.max(4, Math.round(bboxW * 0.014));
    const maxRun = Math.max(minRun + 2, Math.round(bboxW * 0.11));
    if (y2 <= y1 || x2 <= x1) return null;

    let best = null;
    for (let y = y1; y <= y2; y += 1) {
      const base = y * w;
      let runStart = -1;
      for (let x = x1; x <= x2 + 1; x += 1) {
        const on = x <= x2 && !!dark[base + x];
        if (on && runStart < 0) runStart = x;
        if (on) continue;
        if (runStart < 0) continue;
        const runEnd = x - 1;
        const runWidth = runEnd - runStart + 1;
        const runCenter = (runStart + runEnd) / 2;
        runStart = -1;
        if (runWidth < minRun || runWidth > maxRun) continue;
        if (Math.abs(runCenter - cx) > halfWindow * 0.62) continue;

        // A joining seam is supported by strap ink immediately below it.
        // This rejects an isolated crop/silhouette cap at the top of the view.
        let belowSupport = 0;
        const supportDepth = Math.max(4, Math.round(bboxH * 0.025));
        for (let yy = y + 1; yy <= Math.min(y2, y + supportDepth); yy += 1) {
          const b = yy * w;
          for (let xx = Math.max(x1, Math.round(runCenter - minRun));
            xx <= Math.min(x2, Math.round(runCenter + minRun)); xx += 1) {
            if (dark[b + xx]) belowSupport += 1;
          }
        }
        if (belowSupport < supportDepth * 2) continue;

        // Prefer the LOWEST valid seam — the joining seam at the top of the
        // stitched (zigzag) section sits nearest the cup join; the zigzag ink
        // itself only yields sub-minRun runs so it can't win. Preferring the
        // topmost run (pre-ADR-0016) landed on the strap cap / top of the
        // elastic stripes, which the TD flagged as too high. Width/support
        // break ties between adjacent antialiased rows of the same seam.
        const score = runWidth + Math.min(minRun * 2, belowSupport / Math.max(1, supportDepth));
        if (!best || y > best.y + 2 || (Math.abs(y - best.y) <= 2 && score > best.score)) {
          best = { x: runCenter, y, runWidth, belowSupport, score };
        }
      }
    }
    if (!best) return null;
    const confidence = clamp01(0.28
      + Math.min(0.36, best.runWidth / Math.max(1, minRun * 2) * 0.22)
      + Math.min(0.28, best.belowSupport / Math.max(1, bboxH * 0.08)));
    return {
      point: { x: best.x / w, y: best.y / h },
      confidence,
      support: { runWidth: best.runWidth, belowSupport: best.belowSupport },
    };
  }

  function findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const y1 = bounds.minY;
    const y2 = Math.min(bounds.maxY, chestRow > 0 ? chestRow : bounds.minY + Math.round(bboxH * 0.34));
    if (y2 <= y1 + 3) return null;

    const scanSide = (side) => {
      const x1 = side < 0 ? bounds.minX : axisPx + Math.round(bboxW * 0.08);
      const x2 = side < 0 ? axisPx - Math.round(bboxW * 0.08) : bounds.maxX;
      if (x2 <= x1) return null;
      let count = 0;
      let topY = h, topXSum = 0, topCount = 0;
      let bottomY = -1, bottomXSum = 0, bottomCount = 0;
      for (let y = y1; y <= y2; y += 1) {
        const base = y * w;
        let rowXSum = 0, rowCount = 0;
        for (let x = x1; x <= x2; x += 1) {
          if (!dark[base + x]) continue;
          count += 1;
          rowXSum += x;
          rowCount += 1;
        }
        if (rowCount > 0) {
          if (y < topY) { topY = y; topXSum = rowXSum; topCount = rowCount; }
          if (y > bottomY) { bottomY = y; bottomXSum = rowXSum; bottomCount = rowCount; }
        }
      }
      if (count < Math.max(6, (x2 - x1 + 1) * (y2 - y1 + 1) * 0.0015)) return null;
      return {
        count,
        top: { x: (topXSum / Math.max(1, topCount)) / w, y: topY / h },
        bottom: { x: (bottomXSum / Math.max(1, bottomCount)) / w, y: bottomY / h },
      };
    };

    const left = scanSide(-1);
    const right = scanSide(+1);
    const chosen = right && (!left || right.count >= left.count * 0.85) ? right : left;
    if (!chosen) return null;
    return {
      top: chosen.top,
      bottom: chosen.bottom,
      confidence: clamp01(0.25 + Math.min(0.65, chosen.count / Math.max(1, bboxW * bboxH * 0.03))),
    };
  }

  // Back-view strap-top: walk the left strap zone above the back chest row to
  // find the topmost ink. On a back technical sketch the strap rises from the
  // back-panel top toward the shoulder. Returns null when the strap zone has
  // no ink.
  function findBackStrapTopFromInk(dark, w, h, viewBoxPx, chestRow) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;
    const yEnd = (chestRow > 0 && chestRow > minY)
      ? Math.min(maxY, chestRow)
      : minY + Math.round(bh * 0.45);
    const xLo = minX + Math.round(bw * 0.05);
    const xHi = minX + Math.round(bw * 0.32);
    if (xHi <= xLo) return null;
    let total = 0;
    for (let y = minY; y <= yEnd; y += 1) {
      const base = y * w;
      let rowCount = 0;
      let rowXSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowCount += 1; rowXSum += x; }
      }
      total += rowCount;
      if (rowCount > 0) {
        const cx = rowXSum / rowCount;
        return {
          point: { x: cx / w, y: y / h },
          confidence: clamp01(0.3 + Math.min(0.55, total / Math.max(1, bw * bh * 0.02))),
        };
      }
    }
    return null;
  }

  // Back-view shoulder-strap INNER edges (POM 15, back strap distance).
  // The two straps are near-vertical bands descending from the top of the back
  // view down to the attach (chest) row; the panel body and wing outlines only
  // begin AT/below that row, so scanning the zone [top .. chestRow] isolates the
  // straps from everything else. For each column we count ink over the zone; a
  // column that carries ink through most of the zone height is "strap ink". The
  // LEFT strap's inner edge is the right-most strap column left of the axis; the
  // RIGHT strap's inner edge is the left-most strap column right of the axis.
  // A narrow dead-center guard keeps a center-back construction line from being
  // mistaken for a strap edge. Returns normalized {left,right,confidence} or null.
  function findBackStrapInnerEdges(dark, w, h, viewBoxPx, chestRow, axisPx) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX, minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX, maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 24 || bh < 24) return null;
    const yTop = minY;
    const yBot = (chestRow > minY && chestRow < maxY)
      ? chestRow
      : minY + Math.round(bh * 0.32);
    const zoneH = yBot - yTop;
    if (zoneH < Math.max(8, Math.round(bh * 0.08))) return null;
    const axis = (axisPx > minX && axisPx < maxX)
      ? axisPx
      : Math.round((minX + maxX) / 2);
    // Per-column ink count over the strap zone.
    const counts = new Array(bw).fill(0);
    for (let y = yTop; y <= yBot; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) counts[x - minX] += 1;
      }
    }
    // Strap columns carry near-vertical ink over most of the zone height.
    const colThresh = Math.max(3, Math.round(zoneH * 0.40));
    // Dead-center guard: strap edges never sit on the axis (there is always a
    // neckline gap), so ignore columns within ~2% of bbox width of the axis.
    const guard = Math.max(1, Math.round(bw * 0.02));
    let leftInnerI = -1, rightInnerI = -1;
    for (let i = 0; i < bw; i += 1) {
      if (counts[i] < colThresh) continue;
      const x = minX + i;
      if (x < axis - guard) leftInnerI = i;              // keep last → right-most
      else if (x > axis + guard && rightInnerI < 0) rightInnerI = i; // first → left-most
    }
    if (leftInnerI < 0 || rightInnerI < 0) return null;
    const leftInnerXpx = minX + leftInnerI;
    const rightInnerXpx = minX + rightInnerI;
    if (!(leftInnerXpx < axis && rightInnerXpx > axis)) return null;
    // Require a real neckline gap between the inner edges.
    if (rightInnerXpx - leftInnerXpx < Math.round(bw * 0.05)) return null;
    const yPx = (chestRow > minY && chestRow < maxY) ? chestRow : yBot;
    const edgeInk = (counts[leftInnerI] + counts[rightInnerI]) / (2 * Math.max(1, zoneH));
    const confidence = clamp01(0.40 + 0.35 * Math.min(1, edgeInk));
    return {
      left:  { x: leftInnerXpx / w, y: yPx / h },
      right: { x: rightInnerXpx / w, y: yPx / h },
      confidence,
    };
  }

  // Back-view landmarks. Given the back view's pixel-space bbox, finds:
  //   - the back symmetry axis (vertical line through the center-back seam)
  //   - back-center-top: topmost ink in a thin strip around the axis. On a
  //     U-cutout back this is the bottom of the U; on a closed top this is the
  //     band's top edge.
  //   - back-center-bottom: bottommost ink in the same strip. The band's
  //     bottom edge at center.
  // POM 12 (back center length) is back-center-top → back-center-bottom.
  function findBackCenterLandmarks(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 8 || bboxH < 8) return null;

    let xSum = 0, xWeight = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) { xSum += x; xWeight += 1; }
      }
    }
    if (xWeight === 0) return null;
    const centroidX = xSum / xWeight;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const symmetry = computeSymmetryScore(dark, w, axisPx, minX, maxX, minY, maxY);

    // Strip half-width around the axis. Wide enough to survive a faint U-curve
    // crossing the axis at an angle, narrow enough to skip strap tabs at the
    // top corners.
    const halfStripPx = Math.max(2, Math.round(bboxW * 0.035));
    const xLo = Math.max(minX, axisPx - halfStripPx);
    const xHi = Math.min(maxX, axisPx + halfStripPx);

    let topY = -1;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { topY = y; break; }
      }
    }
    let bottomY = -1;
    for (let y = maxY; y >= minY && bottomY < 0; y -= 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { bottomY = y; break; }
      }
    }
    if (topY < 0 || bottomY < 0) return null;
    const spanPx = bottomY - topY;
    if (spanPx < bboxH * 0.15) return null;

    // Refine X at the top/bottom rows by taking the centroid of ink in the
    // strip on that row. This keeps the point on the actual edge ink instead
    // of pinning to the global symmetry axis when the edge curls slightly.
    const rowCentroid = (y) => {
      const base = y * w;
      let sum = 0, count = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { sum += x; count += 1; }
      }
      return count > 0 ? sum / count : axisPx;
    };
    const topX = rowCentroid(topY);
    const botX = rowCentroid(bottomY);

    return {
      axisX: axisPx / w,
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: bottomY / h },
      symmetry,
      bandHeightFrac: spanPx / Math.max(1, bboxH),
      confidence: clamp01(0.30 + 0.45 * symmetry + Math.min(0.25, spanPx / Math.max(1, bboxH))),
    };
  }

  // Topmost dark pixel in the +/-30% horizontal strip around the axis, BELOW
  // chestRow. This is the high point of the inner-cup construction curves —
  // the audit's anchor for POM 9 (inner cup height) and POM 10 (inner cup
  // width). Returns { point: {x, y}, confidence } in normalized coords.
  function findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 12 || bboxH < 12) return null;
    const stripHalf = Math.max(4, Math.round(bboxW * 0.30));
    const xLo = Math.max(minX, axisPx - stripHalf);
    const xHi = Math.min(maxX, axisPx + stripHalf);
    // Skip the chest-row band itself so we don't pin to the chest line ink.
    const guardBelowChest = Math.max(3, Math.round(bboxH * 0.04));
    const yLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.30)) + guardBelowChest;
    const yHi = (bandRow > 0 ? bandRow : maxY) - Math.max(4, Math.round(bboxH * 0.10));
    if (yHi <= yLo || xHi <= xLo) return null;
    // Find first row in [yLo, yHi] with at least a few ink pixels in strip.
    const minInkPerRow = Math.max(2, Math.round((xHi - xLo + 1) * 0.05));
    let topY = -1, topX = axisPx, topInk = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let inkCount = 0, xSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { inkCount += 1; xSum += x; }
      }
      if (inkCount >= minInkPerRow) {
        topY = y;
        topX = xSum / inkCount;
        topInk = inkCount;
        break;
      }
    }
    if (topY < 0) return null;
    // Confidence scales with how much ink we found on the winning row.
    const confidence = clamp01(0.35 + Math.min(0.45, topInk / Math.max(1, xHi - xLo + 1)));
    return { point: { x: topX / w, y: topY / h }, confidence };
  }

  // POM 10 width from real cup ink. Walks the cup-body band [apexY..seamY]
  // on the picked cup half, finds the widest ink-supported row, and returns
  // its leftmost/rightmost ink columns re-labeled as inner (near CF axis) /
  // outer (near side seam) for that side. Returns null when ink is too
  // sparse or the widest row still doesn't span a real cup extent — the
  // caller then keeps its fixed-inset priors so nothing downstream regresses.
  function findCupWidthFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, targetY, searchWindow) {
    if (!dark || !w || !h) return null;
    if (apexY == null || seamY == null || seamY <= apexY) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const cupHeightPx = (seamY - apexY) * h;
    if (cupHeightPx < 20) return null;
    // Row band to scan. When a searchWindow {loY,hiY} is given, scan that whole
    // caller-supplied band (already clamped to the A6-legal region) and take the
    // widest coherent cup-ink run — used for deep cups whose true widest seam
    // sits below the fixed upper-middle level. When a targetY is given, scan a
    // narrow band around it (the legacy fixed-level probe). Otherwise scan the
    // cup body proper — skipping the strap-junction band right below the apex
    // (top 20%) and the cradle-transition band above the seam (bottom 15%) — and
    // take the widest row overall.
    let yLo, yHi;
    if (searchWindow && Number.isFinite(searchWindow.loY) && Number.isFinite(searchWindow.hiY)
        && searchWindow.hiY > searchWindow.loY) {
      yLo = Math.max(minY + 1, Math.round(clamp01(searchWindow.loY) * h));
      yHi = Math.min(maxY - 1, Math.round(clamp01(searchWindow.hiY) * h));
    } else if (targetY != null) {
      const bandPx = Math.max(3, Math.round(cupHeightPx * 0.06));
      const cy = Math.round(clamp01(targetY) * h);
      yLo = Math.max(minY + 1, cy - bandPx);
      yHi = Math.min(maxY - 1, cy + bandPx);
    } else {
      yLo = Math.max(minY + 1, Math.round(apexY * h + cupHeightPx * 0.20));
      yHi = Math.min(maxY - 1, Math.round(seamY * h - cupHeightPx * 0.15));
    }
    if (yHi <= yLo + 2) return null;
    // Keep the x search clear of both the CF axis and the side seam so we
    // never match seam ink itself.
    const axisGuard = Math.max(2, Math.round(bboxW * 0.02));
    const seamGuard = Math.max(2, Math.round(bboxW * 0.015));
    let xLo, xHi;
    if (side < 0) {
      xLo = Math.max(minX + 1, sideColPx + seamGuard);
      xHi = Math.min(maxX - 1, axisPx - axisGuard);
    } else {
      xLo = Math.max(minX + 1, axisPx + axisGuard);
      xHi = Math.min(maxX - 1, sideColPx - seamGuard);
    }
    if (xHi <= xLo + 4) return null;
    const cupHalfWidthPx = Math.max(1, Math.abs(sideColPx - axisPx));
    // Require the run to span a real cup extent (≥45% of the cup half-width).
    // A narrower run at the targeted upper level is usually a fragment trapped
    // between internal cup seams (not the gore→outer span), so we reject it and
    // let the caller use its straddling axis/side inset prior instead.
    const minCupWidthPx = Math.max(6, Math.round(cupHalfWidthPx * 0.45));
    let bestY = -1, bestLeft = -1, bestRight = -1, bestWidth = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let firstInk = -1, lastInk = -1;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) {
          if (firstInk < 0) firstInk = x;
          lastInk = x;
        }
      }
      if (firstInk < 0) continue;
      const runWidth = lastInk - firstInk + 1;
      if (runWidth < minCupWidthPx) continue;
      if (runWidth > bestWidth) {
        bestWidth = runWidth;
        bestLeft = firstInk;
        bestRight = lastInk;
        bestY = y;
      }
    }
    if (bestY < 0) return null;
    // On the LEFT cup the inner (near-axis) edge is the RIGHTMOST ink pixel
    // and the outer (near-seam) edge is the LEFTMOST. On the RIGHT cup it
    // flips. seed-anchors.js separately assigns inner-cup-left/right by x
    // ordering so canvas geometry stays left→right regardless of cup side.
    const innerPx = side < 0 ? bestRight : bestLeft;
    const outerPx = side < 0 ? bestLeft  : bestRight;
    return {
      centerY: bestY / h,
      innerX: innerPx / w,
      outerX: outerPx / w,
      widthPx: bestWidth,
      widthFrac: bestWidth / cupHalfWidthPx,
    };
  }

  // Cup OUTER silhouette edge at a single row. Scans INWARD from the view's
  // outer (armhole-side) bbox edge toward the CF axis and returns the first
  // coherent ink run — the cup's outer outline at that row. Unlike
  // findCupWidthFromInk this is NOT capped at the detected side-seam column, so
  // it recovers the true cup edge when sideColPx lands inboard of the silhouette
  // (POM 10 must span the FULL cup width — CF gore → outer armhole edge).
  // Returns the pixel x of the outline, or null. side<0 = left cup.
  function findCupOuterSilhouettePx(dark, w, h, bounds, axisPx, rowPx, side) {
    if (!dark || !w || !h) return null;
    const { minX, minY, maxX, maxY } = bounds;
    if (rowPx <= minY || rowPx >= maxY) return null;
    const base = rowPx * w;
    const guard = Math.max(2, Math.round((maxX - minX + 1) * 0.02));
    if (side < 0) {
      const xStop = axisPx - guard;
      for (let x = minX + 1; x < xStop; x += 1) {
        if (dark[base + x] && dark[base + x + 1]) return x; // first 2px run
      }
    } else {
      const xStop = axisPx + guard;
      for (let x = maxX - 1; x > xStop; x -= 1) {
        if (dark[base + x] && dark[base + x - 1]) return x;
      }
    }
    return null;
  }

  // Cup INNER silhouette (seam) at a single row. Scans from just off the CF
  // axis OUTWARD toward the cup center and returns the first coherent ink run —
  // the cup's inner seam where it meets the center gore. On wide-gore styles
  // the gore is faint mesh (below the ink threshold), so the scan skips it and
  // lands on the cup panel's inner edge; on narrow gores it stops near the axis
  // ≈ the gore inset. Bounded by cupCenterPx so it never crosses to the outer
  // half. Returns the pixel x, or null. side<0 = left cup (inner edge is right).
  function findCupInnerSilhouettePx(dark, w, h, bounds, axisPx, cupCenterPx, rowPx, side, startInsetPx) {
    if (!dark || !w || !h) return null;
    const { minX, minY, maxX, maxY } = bounds;
    if (rowPx <= minY || rowPx >= maxY) return null;
    const base = rowPx * w;
    if (side < 0) {
      const xStart = Math.min(maxX - 1, axisPx - startInsetPx);
      const xStop = Math.max(minX + 1, cupCenterPx);   // don't cross cup center
      for (let x = xStart; x > xStop; x -= 1) {
        if (dark[base + x] && dark[base + x - 1]) return x;
      }
    } else {
      const xStart = Math.max(minX + 1, axisPx + startInsetPx);
      const xStop = Math.min(maxX - 1, cupCenterPx);
      for (let x = xStart; x < xStop; x += 1) {
        if (dark[base + x] && dark[base + x + 1]) return x;
      }
    }
    return null;
  }

  // Confirm/refine the cup's OWN underwire bottom from the dark mask. The
  // global cradleY is a single horizontal row for the whole garment; this
  // instead looks for the lowest COHERENT ink arc within the cup's central
  // columns — the underwire dips near cup center (per the POM 9 reference,
  // cup height runs to that lowest wire point). We keep the result close to
  // cradleY (a validation, not a relocation): if a real arc is found near the
  // cradle row under this cup, POM 9's bottom becomes trustworthy (earned
  // confidence) instead of a flat guess. Returns { bottomY, support } or null.
  function findCupBottomFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, cradleY, side) {
    if (!dark || !w || !h) return null;
    if (apexY == null || cradleY == null) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxH = maxY - minY + 1;
    // Central portion of the cup x-band — the wire bottoms near cup center,
    // not out at the side seam nor hard against the CF gore.
    const loX = Math.min(axisPx, sideColPx);
    const hiX = Math.max(axisPx, sideColPx);
    const bandW = hiX - loX;
    if (bandW < 8) return null;
    const cLo = Math.max(minX + 1, Math.round(loX + bandW * 0.20));
    const cHi = Math.min(maxX - 1, Math.round(hiX - bandW * 0.20));
    if (cHi <= cLo + 2) return null;
    // Vertical window: clearly below the apex, down to just past the cradle
    // row (the wire can dip a little below it) but never into the band hem.
    const yTop = Math.round(apexY * h + bboxH * 0.10);
    const yBot = Math.min(maxY - 1, Math.round(clamp01(cradleY + 0.05) * h));
    if (yBot <= yTop + 4) return null;
    let cols = 0, hit = 0;
    const bottoms = [];
    for (let x = cLo; x <= cHi; x += 1) {
      cols += 1;
      let low = -1;
      for (let y = yBot; y >= yTop; y -= 1) {
        if (dark[y * w + x]) {
          // Require a short vertical run so a lone speck doesn't win.
          let run = 0;
          for (let k = 0; k < 4 && (y - k) >= yTop; k += 1) if (dark[(y - k) * w + x]) run += 1;
          if (run >= 2) { low = y; break; }
        }
      }
      if (low >= 0) { bottoms.push({ x, low }); hit += 1; }
    }
    if (hit < Math.max(3, Math.round(cols * 0.30))) return null; // not a coherent arc
    const lows = bottoms.slice();  // (x, low) pairs preserved below
    bottoms.sort((a, b) => a.low - b.low);
    // 80th percentile of per-column lowest points — robust to a few short cols.
    const idx = Math.min(bottoms.length - 1, Math.round(bottoms.length * 0.80));
    const chosenY = bottoms[idx].low;
    // Arc-bottom column: median x of the columns within 2px of the deepest
    // point — the flat center of the wire dip (used by the POM 7 arc tier).
    const deep = lows.filter((b) => b.low >= chosenY - 2).map((b) => b.x).sort((a, b) => a - b);
    const bottomX = deep.length ? deep[Math.floor(deep.length / 2)] / w : null;
    return { bottomY: chosenY / h, bottomX, support: hit / cols };
  }

  // POM 9 / POM 10 share one cup model so they describe the same physical cup.
  // The model selects ONE cup side (left or right) and one view, then derives
  // its top / bottom / inner-edge / outer-edge / center from real structure
  // signals (apex = cup-strap join, cradleCupTop = cup-bottom seam, side seam,
  // CF axis). It never snaps to the topmost dark pixel inside a broad strip.
  //
  // visibility (POMs 9/10 are the cup drawn on the FRONT/outer view; a front_inner
  // cutaway is a bonus, never a precondition — DETECTION_AND_MEASUREMENT_CONTRACT.md):
  //   - 'direct'   : cup read from real structure at both ends — a validated apex
  //                  AND a real cup-bottom (committed seam or traced arc), OR a
  //                  front_inner cutaway view exists
  //   - 'inferred' : endpoints placeable but one is only extrapolated (flat-cradle
  //                  bottom, or no real apex)
  //   - 'hidden'   : neither apex nor cup-bottom reference is reliable
  //
  // When visibility is 'hidden' the model still returns a stub (topPoint / etc
  // may be null) so the seeding layer can skip inner-cup-* anchors and POM 9/10
  // demote to REVIEW_ONLY via the requiredAnchors guard. No ratio fallback.
  function buildCupModel(ctx) {
    const {
      bounds, w, h, dark, axisPx, cradleY,
      apexLeft, apexLeftConf, apexRight, apexRightConf,
      cradleCupTop, cradleCupSide, cradleCupTier, cradleCupConfidence,
      sideLeftX, sideRightX,
      hasFrontInner,
    } = ctx;
    const { minX, maxX } = bounds;
    const bboxW = maxX - minX + 1;

    // -------- 1. Pick cup side from positive structure evidence -------------
    // Only trusted seam tiers may influence the cup side. 'guide'/'arc' tier
    // commits (ADR 0021/0022) are review-grade POM 7 evidence and must leave
    // the cupModel — including its side selection — byte-identical.
    const trustedSeamTier = cradleCupTier === 'strong' || cradleCupTier === 'seam';
    const seamSide = trustedSeamTier ? cradleCupSide : 0;
    let side = 0;
    let sideReason = '';
    const lConf = apexLeftConf || 0;
    const rConf = apexRightConf || 0;
    if (apexLeft && apexRight && Math.abs(lConf - rConf) < 0.08) {
      // Symmetric apex evidence — pick the side whose cup-bottom seam was
      // accepted by the POM 7 detector. Fall back to left when neither side
      // dominates.
      if (seamSide === +1) { side = +1; sideReason = 'symmetric apex pair; cup-bottom seam confirms right cup'; }
      else if (seamSide === -1) { side = -1; sideReason = 'symmetric apex pair; cup-bottom seam confirms left cup'; }
      else { side = -1; sideReason = 'symmetric apex pair without cup-bottom seam evidence; default left cup'; }
    } else if (lConf > 0 || rConf > 0) {
      side = lConf >= rConf ? -1 : +1;
      sideReason = `stronger ${side < 0 ? 'left' : 'right'} apex confidence (${lConf.toFixed(2)} vs ${rConf.toFixed(2)})`;
    } else if (seamSide === -1 || seamSide === +1) {
      side = seamSide;
      sideReason = `no apex; cup side taken from POM 7 cup-bottom seam (side=${side})`;
    } else {
      side = -1;
      sideReason = 'no apex and no cup-bottom seam evidence; default left cup';
    }

    // Cup columns (needed early so the cup-bottom ink trace in step 3 can scan
    // the cup's central band). The cup occupies [sideColPx .. axisPx] for a
    // left cup and [axisPx .. sideColPx] for right; the HEIGHT runs through the
    // vertical median cupCenterX.
    const sideColPx = side < 0
      ? (Number.isFinite(sideLeftX)  ? Math.round(sideLeftX  * w) : minX + Math.round(bboxW * 0.05))
      : (Number.isFinite(sideRightX) ? Math.round(sideRightX * w) : maxX - Math.round(bboxW * 0.05));
    const cupCenterXpx = Math.round((axisPx + sideColPx) / 2);
    const cupCenterX = cupCenterXpx / w;

    // -------- 2. View role and visibility ----------------------------------
    const viewRole = hasFrontInner ? 'front_inner' : 'front_outer';
    const apexPoint = side < 0 ? apexLeft : apexRight;
    const apexConf  = side < 0 ? lConf    : rConf;

    // -------- 3. Y references — apex row (cup top) and seam row (cup bottom)
    // We separate Y from X here: a "cup height" measurement must use a
    // SINGLE column for both endpoints — taking topPoint.x from apex and
    // bottomPoint.x from the POM 7 seam column produces a diagonal line that
    // is NOT what a TD reads as cup height. So we record y-only references
    // and project them onto the cup center column in step 7.
    let apexY = null;
    let topFromApex = false;
    if (apexPoint) {
      apexY = apexPoint.y;
      topFromApex = true;
    }

    let seamY = null;
    let bottomFromSeam = false;
    let bottomFromInk = false;      // cup-bottom confirmed by a traced ink arc
    let bottomInkSupport = 0;
    let seamRawX = null;        // raw seam column (debug only)
    if (cradleCupTop && cradleCupSide === side && trustedSeamTier) {
      // Only strong/pattern-3 seams may relocate the cup bottom. Guide-tier
      // (sparse dashed, ADR 0021) and arc-tier (traced underwire, ADR 0022)
      // commits are weak evidence drawn for TD review — letting them in here
      // is exactly what shifted inner-cup geometry and broke invariant B3 in
      // the reverted 2026-07-09 prototype.
      seamY = cradleCupTop.y;
      seamRawX = cradleCupTop.x;
      bottomFromSeam = true;
    } else if (cradleY != null) {
      // POM 7 didn't commit a column on this side. Before falling back to the
      // flat global cradle row, try to CONFIRM the cup's own underwire bottom
      // as a coherent ink arc under the cup center (rule.md: "POM 7 can help
      // locate the lower cup reference, but only when POM 7 confidence is
      // reliable" — here we earn our own reliability). The trace is kept near
      // the cradle row (±0.05), so this refines/validates rather than relocates
      // the bottom, but converts an unearned guess into a trusted endpoint.
      const inkBottom = (apexY != null)
        ? findCupBottomFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, cradleY, side)
        : null;
      if (inkBottom
          && inkBottom.support >= 0.30
          && inkBottom.bottomY > apexY + 0.08
          && inkBottom.bottomY >= cradleY - 0.05) {
        seamY = clamp01(inkBottom.bottomY);
        bottomFromInk = true;
        bottomInkSupport = inkBottom.support;
      } else {
        seamY = cradleY;
      }
      bottomFromSeam = false;
    }

    // -------- 4. Visibility classification ---------------------------------
    // 'direct' still requires SOMETHING to anchor Y — front_inner alone with
    // no apex AND no cradle reference cannot place real endpoints, so it
    // falls through to 'hidden' rather than build geometry from null y's.
    // A cup is read DIRECTLY when it rests on real drawn structure at both ends —
    // a validated apex (cup top) AND a real cup-bottom (a committed POM 7 seam or a
    // traced underwire arc) — regardless of whether a separate front_inner cutaway
    // view exists. Per the 2026-07-09 TD correction (DETECTION_AND_MEASUREMENT_CONTRACT.md
    // Part 1 "Cup group"), POMs 9/10 are the cup as drawn on the FRONT (outer) view;
    // a front_inner cutaway is a bonus, never a precondition. 'inferred' is the
    // genuinely weaker case: endpoints are placeable but one is only extrapolated —
    // a bare flat-cradle-row bottom, or no real apex. 'hidden' = endpoints unplaceable.
    const bottomReal = bottomFromSeam || bottomFromInk;
    let visibility;
    let visibilityReason;
    if ((topFromApex && bottomReal) || (hasFrontInner && (apexY != null || seamY != null))) {
      visibility = 'direct';
      visibilityReason = hasFrontInner
        ? 'front_inner view detected; inner cup is drawn directly'
        : (bottomFromSeam
          ? 'front cup read directly: apex (cup top) + committed cup-bottom seam'
          : 'front cup read directly: apex (cup top) + traced cup-bottom underwire arc');
    } else if (apexY != null && seamY != null) {
      visibility = 'inferred';
      visibilityReason = topFromApex
        ? 'apex anchors the cup top; cup bottom only inferred from the flat cradle row'
        : 'cup top not on a real apex; endpoints partially inferred';
    } else {
      visibility = 'hidden';
      visibilityReason = hasFrontInner
        ? 'front_inner view present but no apex and no cup-bottom reference — cannot anchor endpoints'
        : 'no apex AND no cup-bottom reference — cup model cannot be located';
    }

    // POM 9/10 silent-demotion diagnostics. Captures every upstream signal we
    // checked so a TD can answer "which input was missing?" without re-running
    // the detector with extra console.logs. Surfaced via detection.debug.cupModel.
    const diagnostics = {
      hasFrontInner: !!hasFrontInner,
      apexLeftPresent: !!apexLeft,
      apexRightPresent: !!apexRight,
      apexLeftConf: Number.isFinite(lConf) ? lConf : 0,
      apexRightConf: Number.isFinite(rConf) ? rConf : 0,
      sidePicked: side,
      apexPointPresent: !!apexPoint,
      apexConfPicked: Number.isFinite(apexConf) ? apexConf : 0,
      cradleCupTopPresent: !!cradleCupTop,
      cradleCupSide,
      cradleCupSideMatches: !!(cradleCupTop && cradleCupSide === side),
      cradleYPresent: cradleY != null,
      cradleCupConfidence: Number.isFinite(cradleCupConfidence) ? cradleCupConfidence : 0,
      apexY,
      seamY,
      topFromApex,
      bottomFromSeam,
      bottomFromInk,
      bottomInkSupport: Number.isFinite(bottomInkSupport) ? bottomInkSupport : 0,
      visibility,
      visibilityReason,
    };
    if (visibility === 'hidden' && typeof console !== 'undefined' && console.warn) {
      console.warn('[Auto Mode] cupModel hidden → POM 9/10 will demote to REVIEW_ONLY', diagnostics);
    }

    // For 'direct' with only one of (apexY, seamY) present, extrapolate the
    // missing endpoint by a typical cup-height fraction of the normalized
    // image height (apexY / seamY are already 0–1 normalized). 0.28 is a
    // reasonable approximation across the demo sketches.
    if (visibility === 'direct') {
      const fallbackCupHeight = 0.28;
      if (apexY == null && seamY != null) apexY = clamp01(seamY - fallbackCupHeight);
      if (seamY == null && apexY != null) seamY = clamp01(apexY + fallbackCupHeight);
    }

    // -------- 5. Reject decorative/texture-only evidence -------------------
    // Per rule.md "Reject lace/flower/texture as primary cup evidence". We
    // don't run a dedicated texture detector here; instead we delegate to the
    // two upstream detectors whose validation already excludes decorative
    // candidates:
    //   - apex: validateCupApexPair rejects strap-join candidates that aren't
    //     symmetric and bounded inside the cup region
    //   - cradleCupTop: the POM 7 column scan rejects short decorative ticks,
    //     side-seam-like vertical runs, and ratio-only candidates
    // So a cupModel sourced from (apex, cradleCupTop) is texture-free by
    // construction. The only remaining failure mode is "neither signal fires";
    // that maps to visibility='hidden' above. texturePenalty stays 0 unless a
    // dedicated detector is added later.
    const texturePenalty = 0;
    const contourConfidence = clamp01(topFromApex ? apexConf : (apexConf * 0.4));
    // Bottom-endpoint provenance & confidence. A committed POM 7 seam is best;
    // a traced underwire arc (bottomFromInk) earns confidence from its column
    // support (0.30..1.0 support -> ~0.5..0.85) instead of the flat 0.25 guess
    // used when only the global cradle row is available.
    const bottomEvidence = bottomFromSeam ? 'seam'
      : (bottomFromInk ? 'ink'
        : (seamY != null ? 'cradleRow' : 'none'));
    const seamConfidence = bottomFromSeam
      ? clamp01(cradleCupConfidence || 0)
      : (bottomFromInk
        ? clamp01(0.35 + 0.5 * bottomInkSupport)
        : (seamY != null ? 0.25 : 0));

    if (visibility === 'hidden') {
      return {
        side, viewRole, visibility,
        topPoint: null, bottomPoint: null,
        innerEdge: null, outerEdgeNearArmhole: null, centerPoint: null,
        contourConfidence, seamConfidence, texturePenalty,
        sideReason, visibilityReason,
        topFromApex: false, bottomFromSeam: false, bottomFromInk: false, bottomEvidence: 'none',
        apexAnchor: null, seamAnchor: null,
        rejectedTextureReason: null,
        diagnostics,
        reason: `cup model hidden: ${visibilityReason}`,
      };
    }

    // -------- 6. Cup geometry — shared columns, coherent endpoints ---------
    // The cup occupies the band [sideColPx .. axisPx] for a left cup (and
    // [axisPx .. sideColPx] for right). The HEIGHT measurement runs through
    // the cup's vertical median (cupCenterX); the WIDTH measurement spans
    // the cup's full horizontal extent (innerEdge → outerEdge) at the cup's
    // vertical mid (centerY). sideColPx / cupCenterX are computed in step 1.

    // POM 10 endpoints — the reference draws cup width at the UPPER-MIDDLE of
    // the cup (from the center gore junction out to the outer cup edge), not at
    // the fullest row. We target that level and snap to the real cup ink there
    // when the dark mask is available, otherwise fall back to fixed insets from
    // the CF axis and side seam at the same level. Ink-based snapping picks the
    // inner (gore-side) and outer (side-seam-side) ink pixels on the picked cup
    // half so the width follows the drawn cup outline instead of a geometric
    // prior.
    //
    // Fallback rationale — see the historical note preserved below.
    //   A previous attempt swapped innerEdge to cradleCupTop.x assuming it
    //   marked the cup-gore boundary. It does not — cradleCupTop sits in the
    //   OUTER cup zone (where the cup-bottom seam rises toward chest near the
    //   side seam), so using it as the inner edge collapsed POM 10 width to
    //   near-zero. The inner edge is therefore always derived from the CF-axis
    //   side (ink edge, else a 3% axis inset), never a side-zone landmark.
    //
    // widthLevelY = apex + 0.42·(seam−apex): the fixed upper-middle level. It is
    // the fallback and also the upper floor of the widest-row search below (kept
    // above 0.40 so it stays within 0.08 of POM 9 mid-y, invariant A6).
    const widthLevelY = clamp01(apexY + 0.42 * (seamY - apexY));
    const pom9Mid = (apexY + seamY) / 2;

    // Deep cups: cup width is measured at the cup's WIDEST horizontal cross-
    // section, which on a deep cup sits BELOW the fixed 0.42 level. Search a
    // body-bounded, A6-clamped window for the widest coherent cup-ink row and
    // place the width line there. The window is ONE-SIDED — its floor is
    // widthLevelY, so it can only move the row DOWN — meaning shallow cups
    // (widest already at/above 0.42) keep today's placement and only cups with a
    // genuinely wider seam lower down descend. Capping hiY at pom9Mid+0.07
    // guarantees invariant A6 (|width_y−pom9Mid| < 0.08) by construction: 0.07 +
    // pixel rounding < 0.075 usability gate < 0.08. bodyHiY keeps the row off the
    // underwire/cradle band. Shallow cups skip the search entirely (byte-
    // identical output → no golden drift).
    const cupSpan = seamY - apexY;
    const DEEP_CUP_FRAC = 0.24;
    const bodyHiY = seamY - 0.15 * cupSpan;
    const widthWindow = {
      loY: widthLevelY,
      hiY: clamp01(Math.min(bodyHiY, pom9Mid + 0.07)),
    };
    // The legacy fixed-level probe is always computed — both as the fallback and
    // as the baseline width the widest-row search must clearly beat.
    const atLevel = findCupWidthFromInk(
      dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, widthLevelY
    );
    let inkWidth = atLevel;
    if (cupSpan >= DEEP_CUP_FRAC && widthWindow.hiY > widthWindow.loY) {
      const windowed = findCupWidthFromInk(
        dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, null, widthWindow
      );
      // Only descend to the lower row when the cup is MEANINGFULLY wider there
      // (a genuine deep bulge) — ≥12% wider than at the fixed level, and at least
      // 3% of cup span lower. This keeps roughly-uniform cups at today's level
      // (no spurious drift) and moves only the deep cups the fixed 0.42 level
      // strands too high.
      if (windowed
          && windowed.widthPx >= (atLevel ? atLevel.widthPx * 1.12 : 0)
          && windowed.centerY > widthLevelY + 0.03 * cupSpan) {
        inkWidth = windowed;
      }
    }
    // Guard against a stray-ink row that would violate invariant A6 (POM 10
    // row must lie within 0.08 of POM 9 mid-y). Also require the found row
    // to sit clearly BELOW the apex — otherwise it's likely strap-junction
    // ink, not a cup body row.
    const inkWidthUsable = !!(inkWidth
      && Math.abs(inkWidth.centerY - pom9Mid) < 0.075
      && inkWidth.centerY > apexY + 0.02);

    // Cup-width vertical reference — the widest ink row when accepted, else the
    // geometric upper-middle level.
    const centerY = inkWidthUsable
      ? clamp01(inkWidth.centerY)
      : widthLevelY;

    // POM 9 endpoints — cup height runs from the APEX (cup-strap join, the true
    // top of the cup) down to the cup-bottom at the cup's vertical median. A TD
    // reads cup height from the apex, so the top anchor sits on the detected
    // apex point rather than being projected onto the cup-center column (which
    // floated above the cup edge, since the cup top dips from the apex toward
    // the gore). The bottom stays on the cup-center column at the cup-bottom
    // seam. The line therefore tilts slightly apex→bottom (rendered as a curve)
    // — that matches the TD's cup-height convention. When no apex fired
    // (topFromApex false) there is no real top landmark, so fall back to the
    // cup-center column for a coherent vertical estimate.
    const topX = (topFromApex && apexPoint) ? apexPoint.x : cupCenterX;
    const topPoint    = { x: clamp01(topX), y: clamp01(apexY) };
    // Bottom sits under the cup BODY, not at the geometric side↔CF midpoint.
    // When the apex is at the outer-top (strap join near the side seam), the
    // plain cup-center leans toward CF and the bottom drifts off the cup; bias
    // it halfway from the apex column toward the cup center so POM 9 runs down
    // the cup body. Falls back to the cup center when no apex fired.
    const bottomXraw = (topFromApex && apexPoint) ? (apexPoint.x + cupCenterX) / 2 : cupCenterX;
    // bottomPoint is created AFTER the width endpoints below, so it can be
    // clamped to sit between them (invariant A5).

    // Inner endpoint = the CENTER-FRONT gore junction (where the two cups meet),
    // per the reference. That is a STRUCTURAL point at the CF, not the cup's ink
    // edge at this level — near the top the cup's inner edge curves inward under
    // the neckline V, which would shorten the width. So anchor the inner
    // endpoint just off the CF axis (a small gore inset, ≥ invariant B3's 0.5%),
    // guaranteeing it sits at the gore and that POM 9's column falls between the
    // two POM 10 endpoints (invariant A5).
    const axisPadPx = Math.max(2, Math.round(bboxW * 0.006));
    // Size the gore inset in IMAGE-width terms (0.8% of w) so the inner
    // endpoint always clears invariant B3 (>0.5% of image width off the CF
    // axis) regardless of how much of the frame the cup bbox fills — a bbox-
    // relative inset can shrink below the B3 floor on wide two-view sketches.
    const goreInsetPx = Math.max(axisPadPx, Math.ceil(w * 0.008));
    const goreInsetXpx = side < 0 ? axisPx - goreInsetPx : axisPx + goreInsetPx;
    // On a WIDE center gore the cups are separated by a broad (often faint mesh)
    // panel; the gore inset then floats the inner endpoint in the gore instead
    // of on the cup. Trace the cup's inner seam at the width row and pull the
    // endpoint OUTWARD onto it. Only ever moves away from the axis (never past
    // the gore inset toward center), so invariant B3 (>0.5% off CF axis) holds.
    const innerSilPx = findCupInnerSilhouettePx(
      dark, w, h, bounds, axisPx, cupCenterXpx, Math.round(centerY * h), side, goreInsetPx);
    let innerEdgeXpx = goreInsetXpx;
    if (innerSilPx != null) {
      innerEdgeXpx = side < 0
        ? Math.min(goreInsetXpx, innerSilPx)   // smaller x = further from axis (left cup)
        : Math.max(goreInsetXpx, innerSilPx);
    }
    const innerEdge = { x: clamp01(innerEdgeXpx / w), y: centerY };
    diagnostics.innerEdgeSilhouettePx = innerSilPx;
    diagnostics.innerEdgeExtendedToSeam = innerSilPx != null && innerEdgeXpx !== goreInsetXpx;
    // Ink support for the inner endpoint. The gore inset is a FABRICATED
    // fallback — legitimate only when the point lies inside the garment. On
    // front-closure styles whose apex fires on the strap top, the width row
    // crosses the OPEN neckline V and the inset point floats in blank
    // background. Consumers (landmark-qa cupModelUsable, seed
    // innerCupFromCupModel) treat innerEdgeSupported === false as "cup model
    // not usable for anchors" so the seed falls down the existing precedence
    // chain (innerCupTopInk → view ratios → delete) instead.
    // "Inside the garment" test: faint fills (lace texture) don't register in
    // the dark mask, so ink-proximity alone can't tell garment interior from
    // the neckline opening. But every garment-interior point has the
    // neckline/top edge line somewhere ABOVE it, while a point in the open
    // neckline V sees nothing but background all the way to the ink-bbox top.
    let innerEdgeSupported = innerSilPx != null;
    if (!innerEdgeSupported && dark) {
      const rowPx = Math.min(h - 1, Math.max(0, Math.round(centerY * h)));
      const cLo = Math.max(minX, innerEdgeXpx - 2);
      const cHi = Math.min(maxX, innerEdgeXpx + 2);
      scan: for (let y = rowPx - 1; y >= Math.max(0, bounds.minY); y -= 1) {
        const rowBase = y * w;
        for (let x = cLo; x <= cHi; x += 1) {
          if (dark[rowBase + x]) { innerEdgeSupported = true; break scan; }
        }
      }
    }
    diagnostics.innerEdgeSupported = innerEdgeSupported;
    if (!innerEdgeSupported && typeof console !== 'undefined' && console.warn) {
      console.warn('[Auto Mode] cupModel inner edge unsupported (width row crosses a void) → cup model not usable for POM 9/10 anchors');
    }

    // Outer endpoint = the cup's OUTER edge near the armhole. Prefer the traced
    // outer ink edge when it is a valid outer boundary (on the side-seam side of
    // the cup center); otherwise a small inset from the detected side-seam
    // column. Invariant B4 keeps it ≥0.3% off the side seam.
    const outerInsetPx = Math.max(2, Math.round(bboxW * 0.02));
    const outerFallbackXpx = side < 0 ? sideColPx + outerInsetPx : sideColPx - outerInsetPx;
    // Size the seam pad in IMAGE-width terms as well (0.4% of w): invariant B4
    // measures the seam gap as a fraction of the full image (>0.3%), and a
    // purely bbox-relative pad bottoms out at 2px on multi-view sketches whose
    // ink bbox is a small fraction of the frame — landing the outer endpoint
    // inside the B4 floor (same failure class as the B3 gore inset above).
    const seamPadPx = Math.max(2, Math.round(bboxW * 0.004), Math.ceil(w * 0.004));
    const outerInkValid = inkWidthUsable
      && (side < 0 ? inkWidth.outerX < cupCenterX : inkWidth.outerX > cupCenterX);
    // POM 10 must span the full cup — CF gore → outer side seam. The traced ink
    // edge may pull the outer endpoint FURTHER OUT toward the seam, but must
    // never narrow the cup inward: sketches with interior panel/princess seams
    // were snapping the ink to an inner seam, ending POM 10 ~30% short of the
    // cup. Reach the detected side seam (outerFallbackXpx) and let ink only
    // extend it outward, floored a hair inside the seam (invariant B4).
    const inkOuterXpx = outerInkValid ? Math.round(inkWidth.outerX * w) : outerFallbackXpx;
    const outerEdgeSeamXpx = side < 0
      ? Math.max(sideColPx + seamPadPx, Math.min(outerFallbackXpx, inkOuterXpx))
      : Math.min(sideColPx - seamPadPx, Math.max(outerFallbackXpx, inkOuterXpx));
    // The side-seam column can land INBOARD of the cup's true outer outline
    // (interior/princess seams, faint side seams). Trace the outer silhouette at
    // the width row and let it extend the endpoint OUTWARD to the real cup edge
    // (floored a hair inside the outline, invariant B4). Never narrows the cup.
    const silhouettePx = findCupOuterSilhouettePx(dark, w, h, bounds, axisPx, Math.round(centerY * h), side);
    let outerEdgeXpx = outerEdgeSeamXpx;
    if (silhouettePx != null) {
      const silPadded = side < 0 ? silhouettePx + seamPadPx : silhouettePx - seamPadPx;
      outerEdgeXpx = side < 0
        ? Math.min(outerEdgeSeamXpx, silPadded)   // smaller x = further outboard
        : Math.max(outerEdgeSeamXpx, silPadded);
    }
    const outerEdgeNearArmhole = { x: clamp01(outerEdgeXpx / w), y: centerY };
    diagnostics.outerEdgeSilhouettePx = silhouettePx;
    diagnostics.outerEdgeExtendedToSilhouette = silhouettePx != null && outerEdgeXpx !== outerEdgeSeamXpx;
    // POM 9 bottom (deferred from above): clamp the apex-biased column to sit
    // between the POM 10 width endpoints so the height line stays on the cup
    // body (invariant A5) — on a degenerate narrow cup the raw column can fall
    // just outside the span.
    const bottomLoX = Math.min(innerEdge.x, outerEdgeNearArmhole.x);
    const bottomHiX = Math.max(innerEdge.x, outerEdgeNearArmhole.x);
    const bottomPoint = { x: clamp01(Math.max(bottomLoX, Math.min(bottomHiX, bottomXraw))), y: clamp01(seamY) };
    diagnostics.innerEdgeSource = 'goreAnchor';
    diagnostics.outerEdgeSource = outerInkValid ? 'ink' : 'sideInset';
    diagnostics.innerEdgeX = innerEdge.x;
    diagnostics.outerEdgeX = outerEdgeNearArmhole.x;
    if (inkWidth) {
      diagnostics.cupWidthInkRow = inkWidth.centerY;
      diagnostics.cupWidthInkFrac = inkWidth.widthFrac;
      diagnostics.cupWidthInkUsable = inkWidthUsable;
    }

    // Cup geometric center (debug only — POM 10 spans inner→outer, NOT
    // center→outer).
    const centerPoint = { x: clamp01(cupCenterX), y: centerY };

    // Raw landmark sources kept for debug/inspection.
    const apexAnchor = apexPoint
      ? { x: apexPoint.x, y: apexPoint.y }
      : null;
    const seamAnchor = (seamRawX != null && seamY != null)
      ? { x: seamRawX, y: seamY }
      : null;

    return {
      side, viewRole, visibility,
      topPoint, bottomPoint, innerEdge, outerEdgeNearArmhole, centerPoint,
      innerEdgeSupported,
      contourConfidence, seamConfidence, texturePenalty,
      sideReason, visibilityReason,
      topFromApex, bottomFromSeam, bottomFromInk, bottomEvidence,
      apexAnchor, seamAnchor,
      rejectedTextureReason: null,
      diagnostics,
      reason: visibility === 'direct'
        ? (hasFrontInner
          ? `direct cup view (front_inner): ${sideReason}`
          : `direct front cup (apex + ${bottomFromSeam ? 'cup-bottom seam' : 'traced underwire arc'}): ${sideReason}`)
        : `inferred cup model from ${topFromApex ? 'apex' : 'no apex'} + ${bottomFromSeam ? 'cup-bottom seam' : (bottomFromInk ? 'traced underwire arc' : 'cradle row reference')}: ${sideReason}`,
    };
  }

  // Underarm notch on one side: starting at the detected side-seam column,
  // scan upward from chestRow looking for the topmost dark pixel within a
  // small lateral window. The result is the side-top anchor for POM 11.
  function findSideTopFromInk(dark, w, h, bounds, sideCol, chestRow, side) {
    if (sideCol == null || sideCol < 0) return null;
    const { minX, minY, maxX } = bounds;
    const bboxW = maxX - minX + 1;
    const lateralHalf = Math.max(3, Math.round(bboxW * 0.025));
    const xLo = Math.max(minX, sideCol - lateralHalf);
    const xHi = Math.min(maxX, sideCol + lateralHalf);
    const yLo = minY;
    const yHi = chestRow > 0 ? chestRow : bounds.maxY;
    if (yHi <= yLo || xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) {
        topY = y; topXSum = rowSum; topCount = rowCount;
        break;
      }
    }
    if (topY < 0) return null;
    const topX = topXSum / topCount;
    const confidence = clamp01(0.4 + Math.min(0.4, (chestRow > 0 ? (chestRow - topY) / Math.max(1, bounds.maxY - bounds.minY) : 0) * 1.5));
    return { point: { x: topX / w, y: topY / h }, confidence, side };
  }

  // From a detected side-top, follow the side-seam OUTLINE downward to the
  // bottom hem. A real side seam slants inward (it is rarely a vertical edge),
  // so we edge-walk the ink nearest the previous column each row — tolerating
  // small gaps where the band line crosses — instead of holding the top column.
  // The lowest tracked point is the side-bottom anchor for POM 11.
  function findSideBottomFromInk(dark, w, h, bounds, topPoint) {
    if (!topPoint) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    let lastX = Math.round(topPoint.x * w);
    const startY = Math.round(topPoint.y * h) + 1;
    if (startY >= maxY || lastX < minX || lastX > maxX) return null;
    const lateralHalf = Math.max(3, Math.round(bboxW * 0.05));
    const maxGap = Math.max(4, Math.round((maxY - minY) * 0.05));
    let bestX = lastX, bestY = -1, gap = 0, rows = 0;
    for (let y = startY; y <= maxY; y += 1) {
      const base = y * w;
      const xLo = Math.max(minX, lastX - lateralHalf);
      const xHi = Math.min(maxX, lastX + lateralHalf);
      let nearestX = -1, nearestDist = Infinity;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) {
          const d = Math.abs(x - lastX);
          if (d < nearestDist) { nearestDist = d; nearestX = x; }
        }
      }
      if (nearestX < 0) { gap += 1; if (gap > maxGap) break; continue; }
      gap = 0; lastX = nearestX; bestX = nearestX; bestY = y; rows += 1;
    }
    if (bestY < 0 || rows < 3) return null;
    const confidence = clamp01(0.35 + Math.min(0.45, rows / Math.max(1, maxY - minY)));
    return { point: { x: bestX / w, y: bestY / h }, confidence };
  }

  // Back-view side seam as CORNER endpoints, not silhouette guesses. The side
  // seam's two ends are junctions: the TOP is where the side meets the armhole
  // (the armpit), the BOTTOM is where the side meets the band. We walk the outer
  // silhouette (leftmost ink per row — the back view's side is on its left),
  // find the armpit as the outermost extremum (a corner that exists at any
  // proportion, no fixed ratio), fit a line to the straight seam between, and
  // place the bottom corner on that line at the detected band row so POM 11 and
  // the band agree at the same point. `bandYpx` is the back band row (full-image
  // px), or <0 to fall back to the hem.
  function findBackSideSeam(dark, w, h, bounds, bandYpx) {
    const { minX, minY, maxX, maxY } = bounds;
    const H = maxY - minY + 1;
    if (H < 24) return null;
    const leftEdge = (y) => { const base = y * w; for (let x = minX; x <= maxX; x += 1) if (dark[base + x]) return x; return -1; };

    const ys = [], xs = [];
    for (let y = minY; y <= maxY; y += 1) { const x = leftEdge(y); if (x >= 0) { ys.push(y); xs.push(x); } }
    if (ys.length < 8) return null;
    const yHem = ys[ys.length - 1];

    // TOP corner = armpit: outermost (leftmost) silhouette point below the strap
    // sliver. A true extremum, so it lands on the armhole∩side junction whatever
    // the style's vertical proportions are.
    const skipTop = minY + Math.round(H * 0.10);
    const armMax = minY + Math.round(H * 0.72);
    let yTop = -1, xTop = Infinity;
    for (let i = 0; i < ys.length; i += 1) {
      if (ys[i] < skipTop || ys[i] > armMax) continue;
      if (xs[i] < xTop) { xTop = xs[i]; yTop = ys[i]; }
    }
    if (yTop < 0) return null;

    // Fit x = m*y + b to the straight seam rows (below the armpit, above the
    // hem). POM 11 is a straight line between its corners, so this denoises the
    // seam and lets the bottom corner sit exactly on it.
    let n = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
    const fitLo = yTop + Math.round(H * 0.06), fitHi = yHem - Math.round(H * 0.05);
    for (let i = 0; i < ys.length; i += 1) {
      const y = ys[i];
      if (y < fitLo || y > fitHi) continue;
      n += 1; sy += y; sx += xs[i]; syy += y * y; sxy += xs[i] * y;
    }
    let m = 0, b = xTop;
    if (n >= 4) { const d = n * syy - sy * sy; if (Math.abs(d) > 1e-6) { m = (n * sxy - sy * sx) / d; b = (sx - m * sy) / n; } }
    const lineX = (y) => m * y + b;

    // BOTTOM corner = side∩band junction, on the SOLID hem line — not a zig-zag
    // elastic line drawn above it. Scanned row by row, a zig-zag has only short
    // horizontal runs (its diagonal strokes crossing each row), while the hem is
    // one long continuous run. So we pick the LOWEST row whose max horizontal run
    // reads as a solid line: that lands the corner on the bottom edge under any
    // decorative stitching. The band/hem fallback covers sketches with no clear
    // solid line.
    const W = maxX - minX + 1;
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const yLo = minY + Math.round(H * 0.45);
    let peakRun = 0;
    for (let y = yLo; y <= maxY; y += 1) if (rowRun[y] > peakRun) peakRun = rowRun[y];
    let yBottom = (bandYpx != null && bandYpx > yTop && bandYpx <= maxY) ? bandYpx : yHem;
    if (peakRun >= W * 0.18) {
      const solidThresh = Math.max(W * 0.18, peakRun * 0.5);
      for (let y = maxY; y >= yLo; y -= 1) { if (rowRun[y] >= solidThresh) { yBottom = y; break; } }
    }
    let xBottom = n >= 4 ? lineX(yBottom) : (leftEdge(yBottom) >= 0 ? leftEdge(yBottom) : xTop);
    xBottom = Math.max(minX, Math.min(maxX, xBottom));

    return { top: { x: xTop / w, y: yTop / h }, bottom: { x: xBottom / w, y: yBottom / h }, confidence: 0.55 };
  }

  // Back-panel edges: contour-following at ~22% from the back-view's left.
  // The audit calls out the existing inView(b, 0.225, 0.439) and especially
  // inView(b, 0.232, 1.005) — the latter clamps off-image. Find real ink
  // top/bottom along that strip instead.
  function findBackPanelEdges(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 16 || bboxH < 16) return null;
    // Find the strongest vertical-ink column in the inner 10–45% zone of the
    // back view. This adapts to panel width instead of assuming a fixed 22.5%.
    // A minimum ink count guards against stray dots winning over real seams.
    const searchLo = minX + Math.round(bboxW * 0.10);
    const searchHi = minX + Math.round(bboxW * 0.45);
    const colCounts = new Uint32Array(w);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = searchLo; x <= searchHi; x += 1) {
        if (dark[base + x]) colCounts[x] += 1;
      }
    }
    let bestCol = -1, bestCount = 0;
    for (let x = searchLo; x <= searchHi; x += 1) {
      if (colCounts[x] > bestCount) { bestCount = colCounts[x]; bestCol = x; }
    }
    // Require meaningful ink density — rejects empty strips and stray dots.
    if (bestCol < 0 || bestCount < Math.max(8, Math.round(bboxH * 0.15))) return null;
    const stripCenter = bestCol;
    const stripHalf = Math.max(3, Math.round(bboxW * 0.04));
    const xLo = Math.max(minX, stripCenter - stripHalf);
    const xHi = Math.min(maxX, stripCenter + stripHalf);
    if (xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { topY = y; topXSum = rowSum; topCount = rowCount; }
    }
    let botY = -1, botXSum = 0, botCount = 0;
    for (let y = maxY; y >= minY && botY < 0; y -= 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { botY = y; botXSum = rowSum; botCount = rowCount; }
    }
    if (topY < 0 || botY < 0 || botY <= topY) return null;
    // Reject if the span is implausibly small (likely a stray dot).
    if ((botY - topY) < bboxH * 0.20) return null;
    const topX = topXSum / topCount;
    const botX = botXSum / botCount;
    const confidence = clamp01(0.30 + Math.min(0.45, (botY - topY) / Math.max(1, bboxH)));
    return {
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: botY / h },
      confidence,
    };
  }

  // Back-panel HEIGHT (POM 13) the way a TD measures it: a vertical drop from the
  // shoulder strap's JOINING point (where the strap meets the panel's top edge)
  // down to the bottom band. This is NOT findBackPanelEdges, which measures an
  // interior seam column's ink extent and lands its top up on the strap/hardware.
  // Key idea: the panel's top edge is the back chest row, and ABOVE that row the
  // only ink in the inner-left column is the shoulder strap — so the strap's x is
  // just the centroid of that ink. The join sits at (strapX, chestRow); the
  // bottom is the band edge straight below it, so the result is a true vertical
  // height that bottoms out on the solid band (see snapBandToSolidEdge).
  function findBackPanelHeight(dark, w, h, bounds, bandYpx, chestRowPx) {
    const { minX, minY, maxX, maxY } = bounds;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;
    if (!(chestRowPx > minY + bh * 0.05 && chestRowPx < maxY)) return null;
    // Inner-left strap zone (the left strap; the right strap sits past 0.42·bw).
    const xLo = minX + Math.round(bw * 0.04);
    const xHi = minX + Math.round(bw * 0.42);
    if (xHi <= xLo) return null;
    let sum = 0, cnt = 0;
    for (let y = minY; y <= chestRowPx; y += 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) if (dark[base + x]) { sum += x; cnt += 1; }
    }
    // Require real strap ink, else let the caller fall back.
    if (cnt < Math.max(8, Math.round(bh * 0.05))) return null;
    const strapX = sum / cnt;
    const yBot = (bandYpx != null && bandYpx > chestRowPx && bandYpx <= maxY) ? bandYpx : maxY;
    const confidence = clamp01(0.35 + Math.min(0.45, cnt / Math.max(1, bw * bh * 0.02)));
    return {
      top:    { x: strapX / w, y: chestRowPx / h },
      bottom: { x: strapX / w, y: yBot / h },
      confidence,
    };
  }

  // When the connected-component grouping returns ONE bbox that spans a wide
  // chunk of the canvas, the most common reason is that two technical-sketch
  // views (front + back) got merged because stray ink (background texture,
  // lace mesh) connects them through the gap. Detect such a "merged" view by
  // looking for a low-density vertical alley in its middle and, if found,
  // split it into [leftSub, rightSub]. Returns [view] unchanged when no
  // confident alley is detected.
  // Compute every back-view landmark from a back view box (pixel-space
  // {minX,minY,maxX,maxY}) against the ink mask. Extracted verbatim from
  // detectLandmarks so the SAME pass can re-run when the TD reassigns the back
  // role in the view-role dialog (redetectBackLandmarks). Returns null-valued
  // fields when backBox is null.
  function detectBackLandmarks(dark, w, h, backBox) {
    if (!backBox) {
      return {
        backInfo: null, backFeatures: null, backPanelInfo: null, backPanelHeightInfo: null,
        backStrapTopInfo: null, backStrapInnerInfo: null, backSideTopInfo: null,
        backSideBottomInfo: null, backSideInfo: null,
      };
    }
    const backInfo = findBackCenterLandmarks(dark, w, h, backBox);
    // Per-view feature pass: the back view's OWN axis, chest/band rows, side
    // seams, and ink endpoints so back anchors snap to ink, not box ratios.
    const backFeatures = detectFeaturesInViewBox(dark, w, h, backBox);
    // Back-panel top/bottom (POM 13) from contour-following near the left edge.
    const backPanelInfo = findBackPanelEdges(dark, w, h, backBox);
    // POM 13 back-panel height: strap-joining point → bottom band (vertical).
    const backPanelHeightInfo = backFeatures
      ? findBackPanelHeight(
          dark, w, h, backBox,
          backFeatures.bandY  != null ? Math.round(backFeatures.bandY  * h) : -1,
          backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1
        )
      : null;
    // Back-view strap-top: topmost ink in the back's left strap zone (POM 14 back).
    const backStrapTopInfo = findBackStrapTopFromInk(
      dark, w, h, backBox,
      backFeatures && backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1
    );
    // Back-view strap INNER edges (POM 15) where each strap meets the back band.
    const backStrapInnerInfo = findBackStrapInnerEdges(
      dark, w, h, backBox,
      backFeatures && backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1,
      backFeatures && backFeatures.axisX  != null ? Math.round(backFeatures.axisX  * w) : -1
    );
    // Back-view side-top (POM 11): topmost ink at the left-edge column.
    const backSideTopInfo = findSideTopFromInk(dark, w, h, backBox, backBox.minX + 1, -1, -1);
    const backSideBottomInfo = backSideTopInfo
      ? findSideBottomFromInk(dark, w, h, backBox, backSideTopInfo.point)
      : null;
    // Preferred POM-11 source: the outer-silhouette seam (top=armpit, bottom=hem).
    const backSideInfo = findBackSideSeam(
      dark, w, h, backBox,
      backFeatures && backFeatures.bandY != null ? Math.round(backFeatures.bandY * h) : -1
    );
    return {
      backInfo, backFeatures, backPanelInfo, backPanelHeightInfo,
      backStrapTopInfo, backStrapInnerInfo, backSideTopInfo, backSideBottomInfo, backSideInfo,
    };
  }

  // Re-run back-view landmark detection against the CURRENT detection.backViewIndex
  // and overwrite the back-* fields, so a TD role correction (back moved to a
  // different panel) re-places the back POMs (11/12/13/15) on the new panel. Uses
  // the retained ink mask (detection.inkMask, dimensions inkMaskW/H). No-op when
  // the mask or a back box is unavailable. Mirrors the field mapping in
  // detectLandmarks' detection assembly.
  function redetectBackLandmarks(detection) {
    if (!detection || !detection.inkMask || !detection.inkMaskW || !detection.inkMaskH) return;
    const views = detection.views || detection.viewBoxes || [];
    const idx = detection.backViewIndex;
    const vb = (Number.isFinite(idx) && idx >= 0) ? views[idx] : null;
    if (!vb || !(vb.width > 0) || !(vb.height > 0)) return;
    const mw = detection.inkMaskW;
    const mh = detection.inkMaskH;
    const backBox = {
      minX: Math.max(0, Math.round(vb.x * mw)),
      minY: Math.max(0, Math.round(vb.y * mh)),
      maxX: Math.min(mw - 1, Math.round((vb.x + vb.width) * mw)),
      maxY: Math.min(mh - 1, Math.round((vb.y + vb.height) * mh)),
      count: 0,
    };
    const bl = detectBackLandmarks(detection.inkMask, mw, mh, backBox);
    detection.back = bl.backInfo;
    detection.backFeatures = bl.backFeatures;
    detection.backPanel = bl.backPanelInfo;
    detection.backPanelHeight = bl.backPanelHeightInfo;
    detection.backStrapInner = bl.backStrapInnerInfo;
    detection.backStrapTop = bl.backStrapTopInfo ? bl.backStrapTopInfo.point : null;
    detection.backSideTop = bl.backSideTopInfo ? bl.backSideTopInfo.point : null;
    detection.backSideBottom = bl.backSideBottomInfo ? bl.backSideBottomInfo.point : null;
    detection.backSide = bl.backSideInfo;
  }

  // Split every view box wide enough to plausibly hold more than one panel at
  // its internal vertical alley, recursing so a board whose panels merged in
  // component-grouping separates into one box per panel. This generalizes the
  // former lone-box-only special case: a box is split-eligible when it spans
  // more than half the canvas (>0.50w). A single garment panel on a multi-panel
  // board is never that wide — there would be no room for the others — so a box
  // over that gate is a merge of >=2 panels (e.g. EvelynBliss's back+inner
  // grouped into one 0.565w box). Correct 2-panel boards keep two sub-half
  // boxes and are untouched, which is why golden is unaffected. The per-box
  // sanity gates inside splitMergedViewByVerticalValley (empty-alley run length
  // + >=20% ink share each side) additionally reject splitting a genuine single
  // view (deep-V neckline, wide back panel).
  function splitWideViewBoxes(boxes, dark, w, h) {
    if (!boxes || boxes.length === 0) return boxes;
    const out = [];
    for (const box of boxes) {
      const parts = splitMergedViewByVerticalValley(dark, w, h, box, 0.50);
      if (parts.length > 1) {
        // Recurse at the SAME 0.50 gate so a box holding 3+ merged panels keeps
        // splitting while any resulting piece still spans more than half the
        // canvas. The gate stays at 0.50 (never lower) because a lone wide
        // single panel — demo1/demo2 group into one >0.50w box that the split
        // separates into front+back — must not have its halves re-split; a
        // lower gate over-splits those legitimate single panels (golden regress).
        out.push(...splitWideViewBoxes(parts, dark, w, h));
      } else {
        out.push(box);
      }
    }
    return out;
  }

  function splitMergedViewByVerticalValley(dark, w, h, view, minWidthRatio = 0.50) {
    const { minX, minY, maxX, maxY } = view;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Require a fairly wide bbox before we even try to split — narrow boxes
    // are almost certainly a single view that just happens to be off-center.
    if (bw < w * minWidthRatio || bh < 16) return [view];

    // Column density restricted to the view's bbox.
    const colDark = new Uint32Array(bw);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) colDark[x - minX] += 1;
      }
    }
    // Walk the center 30..70% range, looking for the LONGEST run of columns
    // whose density is below 8% of the bbox height (i.e. nearly empty).
    const lo = Math.floor(bw * 0.30);
    const hi = Math.floor(bw * 0.70);
    const emptyThreshold = Math.max(1, Math.round(bh * 0.08));
    let bestStart = -1, bestEnd = -1, bestLen = 0;
    let curStart = -1;
    for (let i = lo; i <= hi; i += 1) {
      if (colDark[i] <= emptyThreshold) {
        if (curStart < 0) curStart = i;
        // Track true run length (end - start + 1); the old `end - start`
        // comparison against a -1/-1 sentinel could never record a 1-col run.
        const curLen = i - curStart + 1;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
          bestEnd = i;
        }
      } else {
        curStart = -1;
      }
    }
    const runLen = bestLen;
    // Need a noticeable alley — at least 4% of the bbox width — before splitting.
    if (bestStart < 0 || runLen < Math.max(4, bw * 0.04)) return [view];

    // Use the MIDDLE of the alley as the split point. Recompute each sub-view's
    // ink-bbox by scanning its columns; this snaps the bbox to the actual ink
    // (so the FRONT/BACK overlay doesn't include the gap or stray ink).
    const splitX = minX + Math.round((bestStart + bestEnd) / 2);
    const subBounds = (xStart, xEnd) => {
      let lMinX = w, lMaxX = -1, lMinY = h, lMaxY = -1, lCount = 0;
      for (let y = minY; y <= maxY; y += 1) {
        const base = y * w;
        for (let x = xStart; x <= xEnd; x += 1) {
          if (!dark[base + x]) continue;
          lCount += 1;
          if (x < lMinX) lMinX = x;
          if (x > lMaxX) lMaxX = x;
          if (y < lMinY) lMinY = y;
          if (y > lMaxY) lMaxY = y;
        }
      }
      return lMaxX < 0 ? null : { minX: lMinX, minY: lMinY, maxX: lMaxX, maxY: lMaxY, count: lCount };
    };
    const left = subBounds(minX, splitX - 1);
    const right = subBounds(splitX + 1, maxX);
    if (!left || !right) return [view];
    // Sanity check the split: each side should hold a non-trivial share of
    // the original ink. Otherwise the alley was probably just a real empty
    // space inside a single view (e.g. a deep V neckline).
    const total = Math.max(1, view.count || (left.count + right.count));
    const minShare = 0.20;
    if (left.count / total < minShare || right.count / total < minShare) return [view];
    return [left, right];
  }

  // Decide each detected garment component's semantic role. Visual features
  // get first vote; layout only breaks ties. This keeps two-view styles
  // working while allowing a third inner-cup/front-lining detail view.
  function classifySketchViewRoles(dark, w, h, viewBoxes) {
    const scores = (viewBoxes || []).map((view) => scoreViewLayout(view, w, dark, h));
    const roles = new Array(scores.length).fill('unknown');
    if (!viewBoxes || !viewBoxes.length) {
      return {
        roles,
        frontOuterIndex: -1,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }
    if (viewBoxes.length === 1) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.55;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: false,
      };
    }

    const largest = viewBoxes.reduce((m, v) => Math.max(m, v.count || 0), 0);
    const minQualifyingCount = Math.max(1, largest * 0.05);
    const eligible = viewBoxes
      .map((view, index) => ({ view, index, score: scores[index] }))
      .filter((item) => (item.view.count || 0) >= minQualifyingCount);
    if (!eligible.length) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.35;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }

    const assignBest = (role, metric, exclude) => {
      let best = null;
      for (const item of eligible) {
        if (exclude && exclude.has(item.index)) continue;
        if (!best || item.score[metric] > best.score[metric]) best = item;
      }
      if (!best) return -1;
      roles[best.index] = role;
      return best.index;
    };

    const used = new Set();
    let backIndex = -1;
    let frontInnerIndex = -1;
    let frontOuterIndex = -1;

    if (eligible.length >= 3) {
      // Panel order on a technical board is a fixed TD convention, left to
      // right: front_outer, back, front_inner. Position is a far more reliable
      // signal than the visual scores — a symmetric racerback back and a
      // molded-cup inner cutaway score too alike to tell apart — so assign the
      // three roles by centroidX order. Take the three highest-ink eligible
      // views first so a stray 4th blob can't shift the mapping; any extra
      // panel stays 'unknown' and trips reviewRequired below.
      const trio = eligible
        .slice()
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0))
        .slice(0, 3)
        .sort((a, b) => a.score.centroidX - b.score.centroidX);
      frontOuterIndex = trio[0].index; roles[frontOuterIndex] = 'front_outer';
      backIndex       = trio[1].index; roles[backIndex] = 'back';
      frontInnerIndex = trio[2].index; roles[frontInnerIndex] = 'front_inner';
      used.add(frontOuterIndex); used.add(backIndex); used.add(frontInnerIndex);
      // Position is authoritative for the 3-view layout, so assign a confident
      // role score — the review dialog is NOT forced on a clean 3-panel board
      // (the TD can still nudge anchors if a board ever breaks the convention).
      for (const idx of [frontOuterIndex, backIndex, frontInnerIndex]) {
        if (scores[idx]) scores[idx].roleConfidence = 0.75;
      }
    } else {
      // Two panels (the common front + back board): back by best backScore, the
      // remaining view is front_outer. Unchanged from the long-standing path.
      backIndex = assignBest('back', 'backScore', used);
      if (backIndex >= 0) used.add(backIndex);

      frontOuterIndex = assignBest('front_outer', 'frontOuterScore', used);
      if (frontOuterIndex < 0) {
        const fallback = eligible
          .filter(item => !used.has(item.index))
          .sort((a, b) => a.score.centroidX - b.score.centroidX)[0] || eligible[0];
        frontOuterIndex = fallback.index;
        roles[frontOuterIndex] = 'front_outer';
      }
    }

    const roleConfidence = (index, metric) => {
      if (index < 0 || !scores[index]) return 0;
      const values = eligible
        .filter(item => item.index !== index)
        .map(item => item.score[metric])
        .sort((a, b) => b - a);
      const runnerUp = values.length ? values[0] : 0;
      return clamp01(0.45 + (scores[index][metric] - runnerUp) * 0.55);
    };
    // The ≤2-panel path derives confidence from the visual score margin. The
    // 3-view path already set a fixed positional confidence above (position is
    // authoritative there), so it is not recomputed from scores here.
    if (eligible.length < 3) {
      if (frontOuterIndex >= 0) scores[frontOuterIndex].roleConfidence = roleConfidence(frontOuterIndex, 'frontOuterScore');
      if (backIndex >= 0) scores[backIndex].roleConfidence = roleConfidence(backIndex, 'backScore');
    }

    const reviewRequired =
      eligible.length > 3 ||
      eligible.some(item => roles[item.index] === 'unknown') ||
      eligible.some(item => {
        const role = roles[item.index];
        if (role === 'front_outer') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'front_inner') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'back') return (scores[item.index].roleConfidence || 0) < 0.52;
        return true;
      });

    return { roles, frontOuterIndex, backIndex, frontInnerIndex, scores, reviewRequired };
  }

  function scoreViewLayout(view, w, dark, h) {
    const bw = (view.maxX - view.minX + 1);
    const bh = (view.maxY - view.minY + 1);
    const cx = (view.minX + view.maxX) / 2;
    const ink = view.count || 1;
    let edgeInk = 0;
    let centerVerticalInk = 0;
    if (dark && w && h && bw > 0 && bh > 0) {
      const insetX = Math.max(2, Math.round(bw * 0.16));
      const insetY = Math.max(2, Math.round(bh * 0.12));
      const centerLo = Math.round(view.minX + bw * 0.42);
      const centerHi = Math.round(view.minX + bw * 0.58);
      for (let y = view.minY; y <= view.maxY; y += 1) {
        const base = y * w;
        for (let x = view.minX; x <= view.maxX; x += 1) {
          if (!dark[base + x]) continue;
          const inInner = x >= view.minX + insetX && x <= view.maxX - insetX
            && y >= view.minY + insetY && y <= view.maxY - insetY;
          if (!inInner) edgeInk += 1;
          if (x >= centerLo && x <= centerHi) centerVerticalInk += 1;
        }
      }
    }
    const widthRatio = w > 0 ? bw / w : 0;
    const aspect = bh / Math.max(1, bw);
    const edgeRatio = edgeInk / ink;
    const centerVerticalRatio = centerVerticalInk / ink;
    const leftness = 1 - clamp01(cx / Math.max(1, w));
    const rightness = clamp01(cx / Math.max(1, w));
    const symmetry = computeSymmetryScore(
      dark,
      w,
      Math.round(cx),
      view.minX,
      view.maxX,
      view.minY,
      view.maxY
    );
    const frontOuterScore =
      symmetry * 0.34 +
      widthRatio * 0.22 +
      edgeRatio * 0.16 +
      leftness * 0.14 +
      (1 - clamp01(Math.abs(aspect - 1.05))) * 0.14;
    const backScore =
      rightness * 0.30 +
      centerVerticalRatio * 0.24 +
      edgeRatio * 0.20 +
      clamp01(aspect / 1.45) * 0.16 +
      (1 - symmetry) * 0.10;
    return {
      centroidX: w > 0 ? cx / w : 0,
      widthRatio,
      count: view.count || 0,
      edgeRatio,
      centerVerticalRatio,
      symmetry,
      frontOuterScore,
      backScore,
      roleConfidence: 0,
    };
  }

  // Otsu's method — picks the threshold that maximizes between-class variance.
  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let bestT = 128;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const diff = mB - mF;
      const v = wB * wF * diff * diff;
      if (v > maxVar) { maxVar = v; bestT = t; }
    }
    if (maxVar < 0) {
      // Degenerate histogram (e.g. a single-valued / blank image): no
      // between-class split exists, so the loop never updated bestT. Return
      // the mean intensity — the single populated bin for a one-value image —
      // instead of a misleading hard-coded 128.
      return total > 0 ? Math.round(sum / total) : 128;
    }
    return bestT;
  }

  // 1-2-1 smoothing kernel — cheap, removes single-row/single-column jitter
  // without flattening real peaks.
  function smooth1D(arr) {
    const n = arr.length;
    const out = new Float32Array(n);
    if (n === 0) return out;
    for (let i = 0; i < n; i += 1) {
      const a = i > 0 ? arr[i - 1] : arr[i];
      const b = arr[i];
      const c = i < n - 1 ? arr[i + 1] : arr[i];
      out[i] = (a + 2 * b + c) / 4;
    }
    return out;
  }

  // Search centroid ± 5% bboxWidth (2px steps) and pick the candidate whose
  // mirror-fold around the binary dark map gives the best symmetry score.
  function refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroid) {
    const searchHalf = Math.max(3, Math.round((maxX - minX) * 0.05));
    const center = Math.round(centroid);
    let bestX = center;
    let bestScore = -1;
    for (let dx = -searchHalf; dx <= searchHalf; dx += 2) {
      const candidate = center + dx;
      if (candidate <= minX + 2 || candidate >= maxX - 2) continue;
      const score = computeSymmetryScore(dark, w, candidate, minX, maxX, minY, maxY);
      if (score > bestScore) { bestScore = score; bestX = candidate; }
    }
    return bestX;
  }

  // Symmetry score: of all dark pixels in scan range, share that have a dark
  // partner mirrored across `axisX`. Subsamples by 2 for speed.
  function computeSymmetryScore(dark, w, axisX, minX, maxX, minY, maxY) {
    const half = Math.min(axisX - minX, maxX - axisX);
    if (half < 4) return 0;
    let matches = 0;
    let total = 0;
    const step = 2;
    for (let y = minY; y <= maxY; y += step) {
      const rowBase = y * w;
      for (let d = 1; d <= half; d += step) {
        const li = rowBase + (axisX - d);
        const ri = rowBase + (axisX + d);
        const ld = dark[li];
        const rd = dark[ri];
        if (ld) { total += 1; if (rd) matches += 1; }
        if (rd) { total += 1; if (ld) matches += 1; }
      }
    }
    return total > 0 ? matches / total : 0;
  }

  function approxMedianNonZero(arr, lo, hi) {
    const vals = [];
    for (let i = lo; i <= hi; i += 1) {
      if (arr[i] > 0) vals.push(arr[i]);
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }
