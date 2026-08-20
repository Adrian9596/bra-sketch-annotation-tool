// Auto Mode's "Detect Sketch" edge: the DOM / state glue wrapped around the
// pure detection pipeline. Runs the detector from the toolbar (toasts,
// state.autoMode.* writes, telemetry, history), seeds and relocates anchors,
// recognizes extra board photos as auxiliary views (US-039 / US-049), runs the
// deferred Potrace trace, lets the TD confirm ambiguous view roles, and reads
// the ?cvDebug=1 / ?freeCv=1 URL flags and picks the OpenCV adapter.
//
// Categorically different from the pure stages under src/auto/detect/, which
// take no state and touch no DOM beyond canvas pixel reads. buildAuxViews and
// maybePromptForViewRoles deliberately mutate an already-finished detection
// object in place — they are post-pipeline edge operations (ADR 0035 / US-045 /
// US-049), not stages, and must stay that way.
//
// Registered AFTER src/auto/anchors/seed-anchors.js because runOfflineDetection
// -> seedAndRelocateAnchors calls seedAnchorsFromDetection. That call previously
// survived only on function-declaration hoisting inside the shared IIFE, which
// the project's own ordering rule (CLAUDE.md: "a part must appear after anything
// it references") does not actually guarantee.
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
