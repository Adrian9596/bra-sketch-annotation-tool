// Auto Mode draft generation, TD approval actions, apply/discard/reset behavior, debug hooks.
// Source part for app.js. Run `npm run build` after editing.

  // -------- Rule-based POM generator (Phase 3 of the offline engine) --------
  //
  // Reads the current anchor positions and emits 16 fixture-shaped rows that
  // are then funneled through the existing validateAutoFixture +
  // buildDraftAnnotation pipeline.
  function generatePOMDraftsFromAnchors(options = {}) {
    if (state.appMode !== 'auto') {
      showToast('Switch to Auto Mode first.');
      return;
    }
    const sourceImage = pickAutoSourceImage();
    if (!sourceImage) {
      showToast('Add or select an image first, then generate POM drafts.', 3600);
      return;
    }
    if (!state.autoMode.anchors.length) {
      showToast('Place anchors first — run Detect Sketch.');
      return;
    }
    // Replacing drafts is a destructive action if the TD already approved
    // some rows; confirm so they don't lose work.
    const approvedCount = state.autoMode.draftAnnotations
      .filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    if (state.autoMode.draftAnnotations.length > 0) {
      const msg = approvedCount > 0
        ? `Generate will replace ${state.autoMode.draftAnnotations.length} existing draft(s), including ${approvedCount} approved one(s). Continue?`
        : `Generate will replace ${state.autoMode.draftAnnotations.length} existing draft(s). Continue?`;
      if (!window.confirm(msg)) return;
    }

    const fixture = buildPOMFixtureFromAnchors(state.autoMode.anchors);
    const runId = makeRunId();
    const validation = validateAutoFixture(fixture);
    if (validation.status === 'fail') {
      state.autoMode.validation = validation;
      state.autoMode.status = 'error';
      state.autoMode.lastError = 'Generated drafts failed validation. The board was not changed. See panel for details.';
      console.warn('[Auto Mode] Generated fixture failed validation:', validation.errors);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }

    const drafts = fixture.annotations.map(row => buildDraftAnnotation(row, sourceImage, fixture, runId));
    nudgeAutoLabelsToAvoidCollisions(drafts);

    state.autoMode.draftAnnotations = drafts;
    state.autoMode.validation = validation;
    state.autoMode.runId = runId;
    state.autoMode.status = 'reviewing';
    state.autoMode.lastError = null;
    state.selection = { kind: null, id: null };

    pushHistoryIfChanged();
    updateUI();
    requestRender();

    if (options.skipManualHandoff) {
      showToast('Generated ' + drafts.length + ' POM draft(s). Review and approve each row.');
      return;
    }
    autoApplyDraftsAndHandoffToManual(drafts.length);
  }

  // Streamlined Auto Mode handoff: after Detect Sketch → Generate POM Drafts,
  // auto-approve every drawable draft, commit them as real annotations, drop
  // any review-only rows, and switch to Manual Mode so the TD can adjust the
  // lines with the standard editing tools. If apply fails (e.g. validation
  // collision) we stay in Auto Mode so the TD can resolve the issue.
  function autoApplyDraftsAndHandoffToManual(generatedCount) {
    const drawable = state.autoMode.draftAnnotations.filter(d => !isReviewOnlyDraft(d));
    if (drawable.length === 0) {
      showToast('Generated ' + generatedCount + ' draft(s), but none were drawable. Review and resolve in Auto Mode.', 4200);
      return;
    }
    for (const draft of drawable) draft.tdApproved = true;
    const applied = applyApprovedDraftsAtomically();
    if (!applied) {
      for (const draft of drawable) draft.tdApproved = false;
      updateUI();
      return;
    }
    const reviewOnlyLeft = state.autoMode.draftAnnotations.length;
    if (reviewOnlyLeft > 0) discardAutoDrafts(true);
    setAppMode('manual');
    let msg = 'Applied ' + drawable.length + ' POM line' + (drawable.length === 1 ? '' : 's') + ' — switched to Manual Mode for review.';
    if (reviewOnlyLeft > 0) {
      msg += ' (' + reviewOnlyLeft + ' review-only row' + (reviewOnlyLeft === 1 ? '' : 's') + ' dropped.)';
    }
    showToast(msg, 4200);
  }

  function buildPOMFixtureFromAnchors(anchorList) {
    const a = Object.create(null);
    for (const anchor of anchorList) a[anchor.kind] = anchor;
    // Defensive fallback so generator never throws on a missing kind: any
    // anchor that wasn't seeded becomes the center of the image so the
    // validator can flag it as out-of-range rather than crashing.
    const fallback = { x: 0.5, y: 0.5 };
    const at = (kind) => a[kind] || fallback;

    // Convenience helpers — anchors carry normalized [0,1] coords already.
    const pt = (p, dx, dy) => ({
      x: clamp01(p.x + (dx || 0)),
      y: clamp01(p.y + (dy || 0)),
    });
    const lerp = (p1, p2, t) => ({
      x: p1.x + (p2.x - p1.x) * t,
      y: p1.y + (p2.y - p1.y) * t,
    });

    const cfTop      = at('cf-top');
    const cfBot      = at('cf-bottom');
    const bandL      = at('band-left');
    const bandR      = at('band-right');
    const chestL     = at('chest-left');
    const chestR     = at('chest-right');
    const icTop      = at('inner-cup-top');
    const icBot      = at('inner-cup-bottom');
    const icL        = at('inner-cup-left');
    const icR        = at('inner-cup-right');
    const sideTop    = at('side-top');
    const sideBot    = at('side-bottom');
    const apexL      = at('apex-left');
    const apexR      = at('apex-right');
    const strapTop   = at('strap-top');
    const strapBot   = at('strap-bottom');
    const backTop    = at('back-top');
    const backBot    = at('back-bottom');
    const hasBackPanel = !!(a['back-panel-top'] && a['back-panel-bottom']);
    const backPanelTop = hasBackPanel ? a['back-panel-top'] : pt(backTop, 0.04, 0);
    const backPanelBot = hasBackPanel ? a['back-panel-bottom'] : pt(backBot, 0.04, 0);
    const hasBackStrap = !!(a['back-strap-left'] && a['back-strap-right']);
    const backStrapL = hasBackStrap ? a['back-strap-left'] : null;
    const backStrapR = hasBackStrap ? a['back-strap-right'] : null;

    const halfBand = (bandR.x - bandL.x) / 2;
    const bandY = (bandL.y + bandR.y) / 2;
    const chestY = (chestL.y + chestR.y) / 2;

    // POM 2 / 4 extensions beyond their parent endpoint, clamped.
    // Cap at the front view's right edge (with a small inset) when a
    // front view is identified — otherwise the dashed extensions overshoot
    // into the back view on combined-image layouts.
    const det = state.autoMode && state.autoMode.detection;
    const frontView = det
      ? findDetectedViewForRole(det, 'front_outer')
      : null;
    const frontRightLimit = frontView
      ? Math.max(bandR.x + 0.01, (frontView.x + frontView.width) - 0.01)
      : 1;
    const extX = (anchorX, delta) => clamp01(Math.min(anchorX + delta, frontRightLimit));
    const ext2End = { x: extX(bandR.x,  halfBand * 0.64),                   y: bandR.y };
    const ext4End = { x: extX(chestR.x, (chestR.x - chestL.x) * 0.25),      y: chestR.y };

    // Inner-cup curve control points (Bezier). Use a gentle S along the
    // axis between top and bottom of the inner-cup.
    const ic9c1 = lerp(icTop, icBot, 0.38);
    const ic9c2 = lerp(icTop, icBot, 0.68);
    ic9c1.x = clamp01(ic9c1.x - 0.017);
    ic9c2.x = clamp01(ic9c2.x - 0.017);
    const ic10c1 = lerp(icL, icR, 0.34);
    const ic10c2 = lerp(icL, icR, 0.63);
    ic10c1.y = clamp01(ic10c1.y + 0.052);
    ic10c2.y = clamp01(ic10c2.y + 0.039);

    const cradleCfX = clamp01(cfBot.x + halfBand * 0.045);
    // POMs 6/7/8 must follow the editable anchor layer. Earlier code used
    // detection.cradleY directly, so dragging the cradle / inner-cup-bottom
    // anchor did not move these generated lines.
    const detCradleY = (det && Number.isFinite(det.cradleY)) ? det.cradleY : null;
    const anchorCradleY = a['inner-cup-bottom'] && Number.isFinite(icBot.y) ? icBot.y : detCradleY;
    const cradleTopY = anchorCradleY != null ? clamp01(anchorCradleY) : clamp01(chestY + (bandY - chestY) * 0.62);
    // POM 8 cup height: top should sit on the cup-seam crossing the CF axis,
    // which sketches typically draw partway between chest and cradle. Use
    // the cradle line as anchor when known; otherwise the old 0.18 ratio.
    const cupSeamY = anchorCradleY != null
      ? clamp01(chestY + (anchorCradleY - chestY) * 0.38)
      : clamp01(chestY + (bandY - chestY) * 0.18);
    const cupHeightTop = { x: cfBot.x, y: cupSeamY };
    const cupHeightBottom = { x: cfBot.x,
      y: anchorCradleY != null ? clamp01(anchorCradleY) : clamp01(chestY + (bandY - chestY) * 0.56) };
    const cradleCfTop = { x: cradleCfX, y: cradleTopY };
    const cradleCfBottom = { x: cradleCfX, y: cfBot.y };
    const cradleCupX = clamp01(lerp(cfBot, bandR, 0.54).x);
    const cradleCupTop = { x: cradleCupX, y: cradleTopY };
    const cradleCupBottom = { x: cradleCupX, y: clamp01(bandY + (bandY - chestY) * 0.019) };

    // Shoulder strap curve from strap-top down to strap-bottom (POM 14).
    // The strap arcs UP and over the shoulder; for a flat technical sketch
    // with front and back side-by-side, the apex of the curve naturally
    // sits ABOVE the canvas (negative y) which is fine — Bezier endpoints
    // stay where they are, and the visible portion reads as the strap
    // gently arcing toward the shoulder line. Scale by |dx| (horizontal
    // span between the strap-attach points) so single-view layouts get a
    // small arc and two-view layouts get a tall one.
    const strapDX = Math.abs(strapTop.x - strapBot.x);
    const strapDY = Math.abs(strapTop.y - strapBot.y);
    const strapApexY = Math.min(strapTop.y, strapBot.y);
    const strapArcHeight = Math.max(strapDX * 1.30, strapDY * 0.6 + 0.05);
    let strap14c1 = {
      x: clamp01(strapTop.x + (strapTop.x - strapBot.x) * 0.014),
      y: strapApexY - strapArcHeight,           // intentionally unclamped — arc apex sits above the canvas
    };
    let strap14c2 = {
      x: clamp01(strapBot.x + (strapBot.x - strapTop.x) * 0.010),
      y: strapApexY - strapArcHeight * 0.74,    // intentionally unclamped
    };

    // If Potrace produced contours, prefer the actual traced bezier for the
    // strap curve over the geometric estimate above. matchContourForCurve
    // looks for a thin contour whose bbox spans both endpoints.
    const contours = state.autoMode && state.autoMode.detection
      ? state.autoMode.detection.contours : null;
    const tracedStrap = contours
      ? matchContourForCurve(contours.paths, strapTop, strapBot, { preferThin: true })
      : null;
    if (tracedStrap) {
      strap14c1 = tracedStrap.c1;
      strap14c2 = tracedStrap.c2;
    }

    // Inner-cup curves — POM 9 (vertical) and POM 10 (horizontal). The
    // hand-tuned lerp formula above is reliable across typical bra sketches;
    // matchContourForCurve was occasionally locking onto unrelated thin
    // contours (e.g. lace petals) and producing wildly-wrong controls. Keep
    // the formula and skip contour matching here.
    const ic9controls = { c1: ic9c1, c2: ic9c2 };
    const ic10controls = { c1: ic10c1, c2: ic10c2 };

    const pom15Row = hasBackStrap
      ? { fixtureId: 'gen-15', pom: '15', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('15'),
        start: backStrapL, end: backStrapR,
        drawability: 'APPROXIMATE', confidence: 'medium',
        proposedStartLandmark: 'back-strap-left',
        proposedEndLandmark: 'back-strap-right',
        reason: 'Back strap distance from the detected back view.' }
      : { fixtureId: 'gen-15', pom: '15', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('15'),
        drawability: 'REVIEW_ONLY', confidence: 'low',
        uncertainty: 'Back strap distance requires a side / back view, which offline detection cannot localise.',
        reason: 'Back strap distance — review only until a side view is available.' };

    const rows = [
      // POM 1 — bottom band (relax)
      { fixtureId: 'gen-1', pom: '1', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('1'),
        start: bandL, end: bandR,
        drawability: 'DRAWABLE', confidence: 'high',
        proposedStartLandmark: 'band-left', proposedEndLandmark: 'band-right',
        reason: 'Bottom band — between band anchors.' },

      // POM 2 — bottom band extension (dashed) off band-right
      { fixtureId: 'gen-2', pom: '2', type: 'straight', style: 'dashed', arrowType: 'single',
        viewRole: effectivePomViewRole('2'),
        start: bandR, end: ext2End,
        drawability: 'APPROXIMATE', confidence: 'medium',
        proposedStartLandmark: 'band-right', proposedEndLandmark: 'band-right extension',
        reason: 'Bottom-band extension derived from the fitted front view.' },

      // POM 3 — chest line
      { fixtureId: 'gen-3', pom: '3', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('3'),
        start: chestL, end: chestR,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'chest-left', proposedEndLandmark: 'chest-right',
        reason: 'Chest line — between chest anchors.' },

      // POM 4 — chest extension
      { fixtureId: 'gen-4', pom: '4', type: 'straight', style: 'dashed', arrowType: 'single',
        viewRole: effectivePomViewRole('4'),
        start: chestR, end: ext4End,
        drawability: 'APPROXIMATE', confidence: 'medium',
        proposedStartLandmark: 'chest-right', proposedEndLandmark: 'chest-right + 25% extension',
        reason: 'Chest-line extension.' },

      // POM 5 — center front height (vertical, cf-top → cf-bottom)
      { fixtureId: 'gen-5', pom: '5', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('5'),
        start: cfTop, end: cfBot,
        drawability: 'DRAWABLE', confidence: cfTop === fallback || cfBot === fallback ? 'low' : 'high',
        proposedStartLandmark: 'cf-top', proposedEndLandmark: 'cf-bottom',
        reason: 'Center-front height between CF anchors.' },

      // POM 6 — cradle height at CF: half-way down between chest line and band, along the CF axis
      { fixtureId: 'gen-6', pom: '6', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('6'),
        start: cradleCfTop,
        end: cradleCfBottom,
        drawability: 'APPROXIMATE', confidence: 'medium',
        proposedStartLandmark: 'cradle at CF',
        proposedEndLandmark: 'cf-bottom',
        reason: 'Cradle CF height derived from the fitted front view.' },

      // POM 7 — cradle height at the bottom of the cup (vertical on cup side)
      { fixtureId: 'gen-7', pom: '7', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('7'),
        start: cradleCupTop,
        end: cradleCupBottom,
        drawability: 'APPROXIMATE', confidence: 'medium',
        proposedStartLandmark: 'bottom-of-cup mid axis',
        proposedEndLandmark: 'band line',
        reason: 'Cradle height at cup bottom from the fitted front view.' },

      // POM 8 — cup height at CF (vertical from chest line to cf-bottom along CF axis)
      { fixtureId: 'gen-8', pom: '8', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('8'),
        start: cupHeightTop,
        end: cupHeightBottom,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'cup-height top at CF',
        proposedEndLandmark: 'cup-height bottom at CF',
        reason: 'Cup height at CF from the fitted front view.' },

      // POM 9 — inner cup vertical (curved)
      { fixtureId: 'gen-9', pom: '9', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('9'),
        start: icTop, end: icBot, control1: ic9controls.c1, control2: ic9controls.c2,
        drawability: 'DRAWABLE', confidence: 'medium',
        sharedAnchorFamily: 'inner-cup',
        proposedStartLandmark: 'inner-cup top',
        proposedEndLandmark: 'inner-cup bottom',
        reason: 'Inner cup height curve.' },

      // POM 10 — inner cup horizontal (curved)
      { fixtureId: 'gen-10', pom: '10', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('10'),
        start: icL, end: icR, control1: ic10controls.c1, control2: ic10controls.c2,
        drawability: 'DRAWABLE', confidence: 'medium',
        sharedAnchorFamily: 'inner-cup',
        proposedStartLandmark: 'inner-cup left',
        proposedEndLandmark: 'inner-cup right',
        reason: 'Inner cup width curve.' },

      // POM 11 — side seam
      { fixtureId: 'gen-11', pom: '11', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('11'),
        start: sideTop, end: sideBot,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'side-top', proposedEndLandmark: 'side-bottom',
        reason: 'Side seam length.' },

      // POM 12 — back center length (back-top → back-bottom)
      { fixtureId: 'gen-12', pom: '12', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('12'),
        start: backTop, end: backBot,
        drawability: 'APPROXIMATE', confidence: 'low',
        proposedStartLandmark: 'back-top', proposedEndLandmark: 'back-bottom',
        reason: 'Back center length.' },

      // POM 13 — back panel height (parallel to POM 12, slightly outboard)
      { fixtureId: 'gen-13', pom: '13', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('13'),
        start: backPanelTop, end: backPanelBot,
        drawability: 'APPROXIMATE', confidence: hasBackPanel ? 'medium' : 'low',
        proposedStartLandmark: 'back panel top',
        proposedEndLandmark: 'back panel bottom',
        reason: hasBackPanel ? 'Back panel height from the detected back view.' : 'Back panel height (offset from back center).' },

      // POM 14 — shoulder strap (curved)
      { fixtureId: 'gen-14', pom: '14', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('14'),
        start: strapTop, end: strapBot, control1: strap14c1, control2: strap14c2,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'strap-top', proposedEndLandmark: 'strap-bottom',
        reason: 'Shoulder strap curve.' },

      // POM 15 — back strap distance
      pom15Row,

      // POM 16 — front apex distance
      { fixtureId: 'gen-16', pom: '16', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('16'),
        start: apexL, end: apexR,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'apex-left', proposedEndLandmark: 'apex-right',
        reason: 'Front apex-to-apex distance.' },
    ];

    return {
      name: 'auto-generated-from-anchors',
      templateVersion: AUTO_TEMPLATE_VERSION,
      ruleVersion: AUTO_RULE_VERSION,
      annotations: rows,
    };
  }

  function findDetectedViewForRole(detection, role) {
    const views = Array.isArray(detection && detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection && detection.viewBoxes) ? detection.viewBoxes : []);
    return views.find(v => v && (v.viewRole === role || v.role === role || (role === 'front_outer' && v.role === 'front'))) || null;
  }

  function hasDetectedViewRole(role) {
    const det = state.autoMode && state.autoMode.detection;
    return !!findDetectedViewForRole(det, role);
  }

  function defaultPomViewRole(pom) {
    const entry = POM_TEMPLATE[String(pom)];
    return entry && entry.viewRole ? entry.viewRole : 'front_outer';
  }

  function effectivePomViewRole(pom) {
    const role = defaultPomViewRole(pom);
    if (role === 'front_inner' && !hasDetectedViewRole('front_inner')) return 'front_outer';
    return role;
  }

  if (typeof window !== 'undefined') {
    window.__braAutoModeDebug = {
      getDetection: () => clone(state.autoMode.detection),
      getAnchors: () => clone(state.autoMode.anchors),
      getDrafts: () => clone(state.autoMode.draftAnnotations),
      getImages: () => state.images.map(image => ({
        id: image.id,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
      getAnnotations: () => clone(state.annotations),
      runAutoOnDataUrl: async (dataURL) => {
        setAppMode('auto');
        await addImagesFromDataURLs([dataURL]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceImage = state.images[state.images.length - 1] || null;
        if (!sourceImage) throw new Error('No image was added.');
        state.selection = { kind: 'image', id: sourceImage.id };
        await runOfflineDetection();
        generatePOMDraftsFromAnchors({ skipManualHandoff: true });
        return {
          state: window.__braAutoModeDebug.getState(),
          images: window.__braAutoModeDebug.getImages(),
          detection: window.__braAutoModeDebug.getDetection(),
          anchors: window.__braAutoModeDebug.getAnchors(),
          drafts: window.__braAutoModeDebug.getDrafts(),
        };
      },
      approveDrawableDrafts: () => {
        const targets = state.autoMode.draftAnnotations
          .filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
        for (const draft of targets) approveDraftAnnotation(draft);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return targets.length;
      },
      applyApprovedDrafts: () => applyApprovedDraftsAtomically({ suppressPrompt: true }),
      exportProject: () => clone(buildProjectSnapshot()),
      loadProject: async (project) => {
        await loadProject(project);
        return window.__braAutoModeDebug.getState();
      },
      getState: () => ({
        appMode: state.appMode,
        autoStatus: state.autoMode.status,
        lastError: state.autoMode.lastError,
        validation: clone(state.autoMode.validation),
        imageCount: state.images.length,
        draftCount: state.autoMode.draftAnnotations.length,
        anchorCount: state.autoMode.anchors.length,
      }),
      // Learning-mode test surface. Lets scripts/learning-tests.mjs
      // drive recordAnchorResidual / getAnchorBias / the on-off toggle
      // without touching the DOM or window.confirm. Not used by the
      // app itself — purely a CDP hook for the test runner.
      learning: {
        isEnabled: () => isLearningEnabled(),
        setEnabled: (on) => { setLearningEnabled(!!on); },
        recordResidual: (kind, dx, dy) => recordAnchorResidual(kind, dx, dy),
        getBias: (kind) => clone(getAnchorBias(kind)),
        getSampleCount: () => getLearningSampleCount(),
        getBuckets: () => clone(learningStore.buckets),
        clearBuckets: () => {
          learningStore = { buckets: {} };
          saveLearningStore();
          clearManualLearnCache();
        },
        applyBiasTo: (anchors) => clone(applyLearningBiasToAnchors(clone(anchors))),
        evaluateSample: (ann) => {
          const result = evaluateManualPomSample(ann);
          // Surface the status + hash so a follow-up call can confirm
          // the same hash is now considered a duplicate.
          return {
            status: result.status,
            pom: result.pom || null,
            hash: result.hash || null,
            annHash: ann.learnSampleHash || null,
          };
        },
      },
      // Meaning-aware learning test surface. scripts/meaning-tests.mjs
      // drives the (style, POM) catalog and the confirmation flow without
      // touching the DOM. Keeping it here so the meaning helpers stay
      // private to auto-drafts.js but a runner can still poke at them.
      meaning: {
        getStore: () => clone(meaningStore),
        clearAll: () => { clearMeaningStore('all'); },
        clearCurrent: () => { clearMeaningStore('current'); },
        setStyleId: (id) => { state.styleId = (id == null ? '' : String(id)); },
        getStyleId: () => state.styleId || '',
        currentStyleBucketId: () => currentStyleId(),
        resolve: (pom) => {
          const m = resolvePomMeaning(String(pom));
          return m ? clone(m) : null;
        },
        confirm: (pom, meaningId) => { confirmPomMeaning(String(pom), meaningId); },
        forget: (pom, styleId) => forgetPomMeaning(String(pom), styleId),
        listForStyle: (styleId) => clone(listConfirmedMeanings(styleId || currentStyleId())),
        knownStyles: () => listKnownStyleIds(),
        catalog: () => clone(getAllCatalogMeanings()),
        addCustom: (label, startAnchor, endAnchor) => {
          const entry = addCustomMeaning(label, startAnchor, endAnchor);
          return entry ? clone(entry) : null;
        },
        usagePriority: (meaningId) => meaningUsagePriority(meaningId),
        suggest: (ann, limit) => {
          const image = pickImageForAnnotation(ann);
          if (!image) return [];
          return clone(rankCatalogForLine(image, ann, limit || 3));
        },
        // Run the full evaluate → commit cycle from a script. Returns the
        // eval result + the final ann.learnSampleHash so callers can
        // check whether the sample was actually recorded.
        commitChoice: (ann, meaningId) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoice(evalResult, meaningId);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            meaningId,
          };
        },
        commitCustom: (ann, label) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoiceCustom(evalResult, label);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            label,
          };
        },
        // Force-set a usage record so recency tests can synthesize an
        // "I confirmed this 100 days ago" history without waiting.
        seedUsage: (meaningId, count, lastUsedAt) => {
          if (!meaningId) return false;
          meaningStore.usage[meaningId] = {
            count: Number(count) || 0,
            lastUsedAt: Number(lastUsedAt) || 0,
          };
          saveMeaningStore();
          return true;
        },
        // Popover + canvas inspection — these reach into manual-tools.js
        // through the shared IIFE scope (the bundle wraps every source
        // part in the same closure). Keeping them here keeps the test
        // surface in one namespace.
        isPopoverOpen: () => pendingMeaningEval != null,
        openPopoverForAnn: (ann) => {
          const result = evaluateManualPomSample(ann);
          if (result.status === 'needsConfirmation') openPomMeaningPopover(result);
          return { status: result.status, pom: result.pom || null };
        },
        cancelPopover: () => { closePomMeaningPopover(); },
        getCanvasTool: () => state.tool,
        setAppMode: (mode) => { setAppMode(mode === 'auto' ? 'auto' : 'manual'); },
      },
    };
  }

  function getSelectedDraft() {
    return state.selection.kind === 'draft'
      ? state.autoMode.draftAnnotations.find(a => a.id === state.selection.id) || null
      : null;
  }

  function resetAutoModeDrafts() {
    state.autoMode.draftAnnotations = [];
    state.autoMode.validation = null;
    if (state.selection.kind === 'draft') {
      state.selection = { kind: null, id: null };
    }
  }

  function makeRunId() {
    return 'auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function buildDraftAnnotation(row, sourceImage, fixture, runId) {
    const reviewOnly = row.drawability === 'REVIEW_ONLY';
    const start = reviewOnly ? null : worldFromNormalized(row.start, sourceImage);
    const end = reviewOnly ? null : worldFromNormalized(row.end, sourceImage);
    const control1 = reviewOnly || row.type !== 'curved' ? null
      : worldFromNormalized(row.control1, sourceImage);
    const control2 = reviewOnly || row.type !== 'curved' ? null
      : worldFromNormalized(row.control2, sourceImage);
    // Honour an explicit label position from the fixture (manual placement);
    // otherwise compute a sensible default.
    const labelFromFixture = !reviewOnly && row.label
      ? worldFromNormalized(row.label, sourceImage) : null;
    const labelPos = reviewOnly ? null : (labelFromFixture || computeDefaultLabelPosition({
      type: row.type || 'straight',
      start, end, control1, control2,
    }));
    const baseAnn = {
      id: createUniqueAnnotationId(),
      fixtureId: row.fixtureId,
      seq: parseInt(row.pom, 10) || 0,
      type: reviewOnly ? 'straight' : (row.type || 'straight'),
      style: reviewOnly ? 'solid' : (row.style || 'solid'),
      color: 'red',
      arrowType: reviewOnly ? 'double' : (row.arrowType || 'double'),
      lineWidth: DEFAULT_LINE_WIDTH,
      start,
      end,
      control1,
      control2,
      label: labelPos,
      labelManual: !!row.labelManual,
      // Generated drafts leave `text` blank so the spec panel falls back to
      // `seq` for the callout number — this matches the reference file where
      // text=null and seq drives the POM number.
      text: null,
      desc: row.desc || null,
      value: null,
      // Auto Mode metadata
      auto: true,
      sourceMode: 'auto-mode',
      sourceImageId: sourceImage.id,
      autoRunId: runId,
      templateVersion: fixture.templateVersion || AUTO_TEMPLATE_VERSION,
      ruleVersion: fixture.ruleVersion || AUTO_RULE_VERSION,
      drawability: row.drawability,
      confidence: row.confidence || 'medium',
      tdEdited: false,
      tdApproved: false,
      tdApprovalRequired: true,
      endpointApproximate: row.drawability === 'APPROXIMATE',
      proposedStartLandmark: row.proposedStartLandmark || null,
      proposedEndLandmark: row.proposedEndLandmark || null,
      reason: row.reason || null,
      uncertainty: row.uncertainty || null,
      sharedAnchorFamily: row.sharedAnchorFamily || null,
      viewRole: row.viewRole || effectivePomViewRole(row.pom),
      approvedAt: null,
    };
    return baseAnn;
  }

  function worldFromNormalized(p, image) {
    if (!p) return null;
    return {
      x: image.x + (Number(p.x) || 0) * image.width,
      y: image.y + (Number(p.y) || 0) * image.height,
    };
  }

  // Returns { status: 'pass'|'warning'|'fail', errors:[], warnings:[] }
  function validateAutoFixture(fixture) {
    const errors = [];
    const warnings = [];
    const pomTemplate = POM_TEMPLATE;

    if (!fixture || !Array.isArray(fixture.annotations)) {
      errors.push('Fixture has no annotations array.');
      return { status: 'fail', errors, warnings };
    }

    const seenPoms = new Map();
    for (const row of fixture.annotations) {
      const pomKey = String(row.pom);
      if (!pomTemplate[pomKey]) {
        errors.push(`Row references POM ${pomKey} which is not in POM_TEMPLATE 1–16.`);
        continue;
      }
      const list = seenPoms.get(pomKey) || [];
      list.push(row);
      seenPoms.set(pomKey, list);
    }

    // Exactly one row per POM 1–16
    for (let n = 1; n <= 16; n += 1) {
      const key = String(n);
      const rows = seenPoms.get(key) || [];
      if (rows.length === 0) errors.push(`Missing POM ${key}.`);
      else if (rows.length > 1) errors.push(`Duplicate POM ${key} (${rows.length} rows).`);
    }

    // Unique fixture IDs
    const idSet = new Set();
    for (const row of fixture.annotations) {
      if (row.fixtureId && idSet.has(row.fixtureId)) {
        errors.push(`Duplicate fixtureId "${row.fixtureId}".`);
      }
      if (row.fixtureId) idSet.add(row.fixtureId);
    }

    // Per-row checks
    for (const row of fixture.annotations) {
      const tag = `POM ${row.pom}`;
      if (!row.drawability || !['DRAWABLE', 'APPROXIMATE', 'REVIEW_ONLY'].includes(row.drawability)) {
        errors.push(`${tag}: invalid drawability "${row.drawability}".`);
        continue;
      }
      if (!['front_outer', 'back', 'front_inner', 'unknown'].includes(row.viewRole || 'unknown')) {
        errors.push(`${tag}: invalid viewRole "${row.viewRole}".`);
        continue;
      }
      const requiredRole = defaultPomViewRole(row.pom);
      if (requiredRole === 'front_inner' && hasDetectedViewRole('front_inner')) {
        if (row.viewRole !== 'front_inner') warnings.push(`${tag}: should use front_inner when that view exists.`);
      } else if (requiredRole !== 'front_inner' && row.viewRole !== requiredRole) {
        warnings.push(`${tag}: expected viewRole ${requiredRole}, got ${row.viewRole}.`);
      }
      if (row.drawability === 'REVIEW_ONLY') {
        // No stale geometry allowed
        if (row.start || row.end || row.control1 || row.control2) {
          errors.push(`${tag}: REVIEW_ONLY row must have null geometry.`);
        }
        if (row.confidence !== 'low') {
          warnings.push(`${tag}: REVIEW_ONLY rows should have low confidence.`);
        }
        if (!row.uncertainty) {
          warnings.push(`${tag}: REVIEW_ONLY rows should explain why a line cannot be drawn.`);
        }
        continue;
      }

      // Endpoints must sit on (or just off) the canvas; control points are
      // mathematical handles and can legitimately live well outside it. POM
      // 14's strap arc deliberately places its apex above the canvas so the
      // curve reads as arcing over the shoulder — see the "intentionally
      // unclamped" comments in the POM 14 builder. Use a wider tolerance for
      // control points so that legitimate off-canvas handles don't get
      // mistaken for numeric errors.
      const coordsOk =
        isFiniteNormalized(row.start) &&
        isFiniteNormalized(row.end) &&
        (row.type !== 'curved' || (isFiniteHandle(row.control1) && isFiniteHandle(row.control2)));
      if (!coordsOk) {
        errors.push(`${tag}: non-finite or out-of-range coordinates.`);
        continue;
      }
    }

    // POM-specific geometry checks
    const get = (k) => (seenPoms.get(String(k)) || [])[0];
    const pom1 = get(1), pom2 = get(2), pom3 = get(3), pom4 = get(4);
    const pom8 = get(8), pom9 = get(9), pom10 = get(10), pom14 = get(14), pom16 = get(16);

    if (pom1 && !isHorizontal(pom1)) errors.push('POM 1 must be horizontal.');
    if (pom3 && !isHorizontal(pom3)) errors.push('POM 3 must be horizontal.');
    if (pom8 && !isVertical(pom8)) errors.push('POM 8 must be vertical.');

    if (pom2 && pom2.style !== 'dashed') errors.push('POM 2 must be dashed (paired with POM 1).');
    if (pom4 && pom4.style !== 'dashed') errors.push('POM 4 must be dashed (paired with POM 3).');

    if (pom9 && pom10 && pom9.sharedAnchorFamily && pom10.sharedAnchorFamily) {
      // Only warn when both POMs explicitly declare an anchor family AND the
      // families disagree. A missing field on either side is treated as
      // "not declared", not a violation.
      if (pom9.sharedAnchorFamily !== pom10.sharedAnchorFamily) {
        warnings.push('POM 9 and POM 10 anchor families disagree (' +
          pom9.sharedAnchorFamily + ' vs ' + pom10.sharedAnchorFamily + ').');
      }
    }

    if (pom14 && pom14.type !== 'curved') errors.push('POM 14 must be a curved line.');

    if (pom16 && pom16.drawability !== 'REVIEW_ONLY') {
      if (!isFiniteNormalized(pom16.start) || !isFiniteNormalized(pom16.end)) {
        errors.push('POM 16 must have valid point-to-point geometry.');
      }
    }

    if (errors.length) return { status: 'fail', errors, warnings };
    if (warnings.length) return { status: 'warning', errors, warnings };
    return { status: 'pass', errors, warnings };
  }

  function isFiniteNormalized(p) {
    if (!p) return false;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    // tolerate a slight overshoot since the line may extend just beyond the image
    if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return false;
    return true;
  }

  // Curve handles can sit well outside the canvas (POM 14's strap arc apex
  // is intentionally above y = 0) — only reject non-finite values or coords
  // so absurd they can only come from a numerical error in the generator.
  function isFiniteHandle(p) {
    if (!p) return false;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < -5 || x > 5 || y < -5 || y > 5) return false;
    return true;
  }

  function isHorizontal(row) {
    if (!row.start || !row.end) return false;
    const dx = Math.abs(row.end.x - row.start.x);
    const dy = Math.abs(row.end.y - row.start.y);
    return dx > 0 && dy <= dx * 0.25;
  }

  function isVertical(row) {
    if (!row.start || !row.end) return false;
    const dx = Math.abs(row.end.x - row.start.x);
    const dy = Math.abs(row.end.y - row.start.y);
    return dy > 0 && dx <= dy * 0.25;
  }

  // -------- TD review actions on drafts --------

  function markDraftTouchedByTD(ann) {
    if (!isAutoDraft(ann)) return;
    ann.tdEdited = true;
    ann.tdApprovalRequired = true;
    ann.endpointApproximate = true;
    ann.tdApproved = false;
    ann.approvedAt = null;
  }

  function approveDraftAnnotation(ann) {
    if (!isAutoDraft(ann)) return;
    if (isReviewOnlyDraft(ann)) {
      showToast('REVIEW_ONLY rows cannot be approved.');
      return;
    }
    if (!ann.start || !ann.end) {
      showToast('This draft has no valid geometry.');
      return;
    }
    ann.tdApproved = true;
    ann.tdApprovalRequired = false;
    ann.endpointApproximate = false;
    ann.approvedAt = new Date().toISOString();
  }

  function markDraftReviewOnly(ann) {
    if (!isAutoDraft(ann)) return;
    ann.drawability = 'REVIEW_ONLY';
    ann.start = null;
    ann.end = null;
    ann.control1 = null;
    ann.control2 = null;
    ann.label = null;
    ann.confidence = 'low';
    ann.tdEdited = true;
    ann.tdApproved = false;
    ann.tdApprovalRequired = true;
    ann.endpointApproximate = false;
    ann.approvedAt = null;
    if (!ann.uncertainty) ann.uncertainty = 'Marked REVIEW_ONLY by TD.';
  }

  // -------- Apply / Discard --------

  function applyApprovedDraftsAtomically(options = {}) {
    if (state.appMode !== 'auto') return false;
    const drafts = state.autoMode.draftAnnotations;
    const approved = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d));
    if (approved.length === 0) {
      showToast('No approved drafts to apply.');
      return false;
    }

    state.autoMode.status = 'applying';
    updateUI();

    // Atomic validation: every approved draft must still be drawable and
    // must not collide with an already-applied POM on the same source.
    // Key on `seq` first (drafts intentionally leave `text` null and rely on
    // the sequence number for the POM label) so multiple null-text drafts
    // never look like the same POM during apply.
    const geometryErrors = [];
    const duplicates = []; // { pomLabel, sourceImageId }
    const pomKeyOf = (ann) => {
      const seq = ann.seq != null ? String(ann.seq) : null;
      const text = ann.text != null && String(ann.text).trim() !== '' ? String(ann.text) : null;
      const label = seq || text || '?';
      return `${ann.sourceImageId || ''}|${label}`;
    };
    const existingAutoApplied = state.annotations.filter(a => isAutoDraft(a));
    const usedPomKeys = new Set(existingAutoApplied.map(pomKeyOf));

    for (const draft of approved) {
      const pomLabel = getLabelText(draft);
      if (!draft.start || !draft.end) {
        geometryErrors.push(`POM ${pomLabel}: missing geometry.`);
        continue;
      }
      if (!isFinitePoint(draft.start) || !isFinitePoint(draft.end)) {
        geometryErrors.push(`POM ${pomLabel}: non-finite coordinates.`);
        continue;
      }
      if (draft.type === 'curved' && (!isFinitePoint(draft.control1) || !isFinitePoint(draft.control2))) {
        geometryErrors.push(`POM ${pomLabel}: curve controls are invalid.`);
        continue;
      }
      const key = pomKeyOf(draft);
      if (usedPomKeys.has(key)) {
        duplicates.push({ pomLabel, sourceImageId: draft.sourceImageId || '' });
        continue;
      }
      usedPomKeys.add(key);
    }

    // Duplicate-only conflict path: collapse the 16 repeated messages into a
    // single line, and offer to clear the existing auto-applied rows so the
    // user can recover instead of hitting Discard Drafts and starting over.
    if (duplicates.length && !geometryErrors.length) {
      const collidingImageIds = new Set(duplicates.map(d => d.sourceImageId));
      const collidingExisting = existingAutoApplied.filter(a =>
        collidingImageIds.has(a.sourceImageId || ''));
      const summary = `Apply blocked — ${duplicates.length} POM${duplicates.length === 1 ? '' : 's'} already exist on this image.`;
      state.autoMode.status = 'error';
      state.autoMode.lastError = `${summary} Clear existing Auto-applied lines first, or use Discard Drafts.`;

      const canRecover = !options.suppressPrompt && collidingExisting.length > 0;
      const wantsClear = canRecover && window.confirm(
        `${summary}\n\nReplace the ${collidingExisting.length} existing Auto-applied line${collidingExisting.length === 1 ? '' : 's'} on this image with the new drafts?`
      );
      if (wantsClear) {
        const removeIds = new Set(collidingExisting.map(a => a.id));
        state.annotations = state.annotations.filter(a => !removeIds.has(a.id));
        if (state.selection.kind === 'annotation' && removeIds.has(state.selection.id)) {
          state.selection = { kind: null, id: null };
        }
        state.autoMode.lastError = null;
        // Re-run with suppressPrompt so we never recurse if something is left.
        return applyApprovedDraftsAtomically({ suppressPrompt: true });
      }

      showToast('Apply blocked — existing Auto-applied rows on this image.', 4200);
      console.warn('[Auto Mode] Apply blocked by ' + duplicates.length + ' duplicate(s).');
      updateUI();
      return false;
    }

    const errors = geometryErrors.concat(
      duplicates.map(d => `POM ${d.pomLabel}: another Auto-applied row already exists for this image.`)
    );
    if (errors.length) {
      state.autoMode.status = 'error';
      state.autoMode.lastError = errors.join('\n');
      showToast('Apply aborted — nothing changed. See status.', 4200);
      console.warn('[Auto Mode] Apply failed:\n' + errors.join('\n'));
      updateUI();
      return false;
    }

    // Atomic commit. Build the applied set first, then mutate state once.
    const applied = approved.map((draft) => buildAppliedAnnotation(draft));

    // Commit.
    for (const ann of applied) {
      state.annotations.push(ann);
    }
    // Remove the applied drafts from the draft layer (matched by id).
    const appliedDraftIds = new Set(approved.map(d => d.id));
    state.autoMode.draftAnnotations = drafts.filter(d => !appliedDraftIds.has(d.id));

    // Adjust selection if it pointed at one of the applied drafts.
    if (state.selection.kind === 'draft' && appliedDraftIds.has(state.selection.id)) {
      state.selection = { kind: null, id: null };
    }

    state.nextSequence = Math.max(
      state.nextSequence,
      state.annotations.reduce((m, a) => Math.max(m, (a.seq || 0) + 1), state.nextSequence),
    );

    state.autoMode.status = state.autoMode.draftAnnotations.length > 0 ? 'reviewing' : 'ready';
    state.autoMode.lastError = null;

    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(`Applied ${applied.length} approved line${applied.length === 1 ? '' : 's'}.`);
    return true;
  }

  function buildAppliedAnnotation(draft) {
    return {
      id: createUniqueAnnotationId(),
      seq: draft.seq,
      type: draft.type,
      style: draft.style,
      color: draft.color,
      arrowType: draft.arrowType,
      lineWidth: normalizeLineWidth(draft.lineWidth),
      start: clonePoint(draft.start),
      end: clonePoint(draft.end),
      control1: draft.control1 ? clonePoint(draft.control1) : null,
      control2: draft.control2 ? clonePoint(draft.control2) : null,
      label: clonePoint(draft.label || computeDefaultLabelPosition(draft)),
      labelManual: !!draft.labelManual,
      text: draft.text,
      desc: draft.desc,
      value: draft.value,
      // Preserved Auto Mode metadata for save/reopen.
      auto: true,
      sourceMode: 'auto-mode',
      sourceImageId: draft.sourceImageId,
      autoRunId: draft.autoRunId,
      templateVersion: draft.templateVersion,
      ruleVersion: draft.ruleVersion,
      drawability: draft.drawability,
      confidence: draft.confidence,
      tdEdited: !!draft.tdEdited,
      tdApproved: true,
      tdApprovalRequired: false,
      endpointApproximate: false,
      approvedAt: draft.approvedAt || new Date().toISOString(),
      proposedStartLandmark: draft.proposedStartLandmark || null,
      proposedEndLandmark: draft.proposedEndLandmark || null,
      reason: draft.reason || null,
      uncertainty: draft.uncertainty || null,
      sharedAnchorFamily: draft.sharedAnchorFamily || null,
      viewRole: draft.viewRole || effectivePomViewRole(draft.seq),
      originDraftId: draft.id,
    };
  }

  function isFinitePoint(p) {
    return !!(p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  function discardAutoDrafts(silent) {
    if (state.autoMode.draftAnnotations.length === 0) return;
    if (!silent && !window.confirm('Discard all current Auto Mode drafts? Project annotations are not affected.')) return;
    state.autoMode.draftAnnotations = [];
    state.autoMode.validation = null;
    if (state.selection.kind === 'draft') {
      state.selection = { kind: null, id: null };
    }
    ensureAutoModeStatus();
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    if (!silent) showToast('Drafts discarded. Project unchanged.');
  }

  function isWorkingBoardEmpty() {
    return state.images.length === 0
      && state.annotations.length === 0
      && state.eraseStrokes.length === 0
      && state.autoMode.draftAnnotations.length === 0
      && !state.autoMode.detection;
  }

  // Wipe the working board so the TD can start a new bra sketch from scratch.
  // Images, lines, erase strokes, and any Auto Mode drafts/detection/anchors
  // all go away in one history step (so a single Undo brings them back).
  // imageDataById is intentionally NOT cleared — restoreSnapshot() reads
  // image pixels from there when Undo replays the prior snapshot.
  function resetWorkingBoard() {
    if (isWorkingBoardEmpty()) {
      showToast('Working board is already empty.');
      return;
    }
    if (!window.confirm('Reset the working board? This deletes all photos and lines so you can start a new bra sketch. Undo will bring them back.')) return;

    state.annotations = [];
    state.images = [];
    state.eraseStrokes = [];
    state.nextSequence = 1;
    state.selection = { kind: null, id: null };
    state.drawSession = null;
    state.eraseSession = null;
    state.interaction = null;
    state.editingLabelId = null;
    state.calibration = { unitsPerPx: null, unit: 'cm' };
    state.autoMode = makeInitialAutoModeState();
    el.labelEditor.style.display = 'none';

    // Images going away invalidates every cached shadow detection.
    clearManualLearnCache();

    ensureAutoModeStatus();
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Working board reset. Ready for a new sketch.');
  }

  // =============================================================
  // Phase 1: Manual-to-Auto Learning Loop
  //
  // Records (detected → corrected) anchor residuals after every commit
  // and applies the running median as a calibration bias on top of the
  // geometric rules in auto_mode_rules.js. The rules file is unchanged.
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
  // Anything smaller than ~1px on a 1024-wide image is UI jitter, not a
  // real correction. Keeps fat-finger drags and accidental clicks out
  // of the bucket.
  const LEARNING_MIN_DELTA = 0.001;

  function loadLearningStore() {
    try {
      const raw = localStorage.getItem(LEARNING_KEY);
      if (!raw) return { buckets: {} };
      const parsed = JSON.parse(raw);
      return (parsed && parsed.buckets) ? parsed : { buckets: {} };
    } catch (_) {
      return { buckets: {} };
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

  function getAnchorBias(anchorKind) {
    const bucket = learningStore.buckets[learningBucketKey(anchorKind)];
    if (!bucket || bucket.length < LEARNING_MIN_SAMPLES) {
      return { dx: 0, dy: 0, n: bucket ? bucket.length : 0 };
    }
    const dx = medianOf(bucket.map(r => r.dx));
    const dy = medianOf(bucket.map(r => r.dy));
    return {
      dx: Math.max(-LEARNING_CLAMP, Math.min(LEARNING_CLAMP, dx)),
      dy: Math.max(-LEARNING_CLAMP, Math.min(LEARNING_CLAMP, dy)),
      n: bucket.length,
    };
  }

  function recordAnchorResidual(anchorKind, dxNorm, dyNorm) {
    if (!isLearningEnabled()) return false;
    if (!Number.isFinite(dxNorm) || !Number.isFinite(dyNorm)) return false;
    if (Math.abs(dxNorm) < LEARNING_MIN_DELTA && Math.abs(dyNorm) < LEARNING_MIN_DELTA) return false;
    const key = learningBucketKey(anchorKind);
    const bucket = learningStore.buckets[key] || (learningStore.buckets[key] = []);
    bucket.push({ dx: dxNorm, dy: dyNorm, ts: Date.now() });
    // Drop the oldest entries first — recent TDs are more representative
    // of the current sketch style than ones from months ago.
    if (bucket.length > LEARNING_MAX_PER_BUCKET) {
      bucket.splice(0, bucket.length - LEARNING_MAX_PER_BUCKET);
    }
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
    learningStore = { buckets: {} };
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
      const bias = getAnchorBias(anchor.kind);
      if (!bias.dx && !bias.dy) continue;
      anchor.x = clamp01(anchor.x + bias.dx);
      anchor.y = clamp01(anchor.y + bias.dy);
      // Tag so future UI can show "this anchor was nudged by learning"
      // without recomputing the bias. Harmless if unused.
      anchor.calibrated = true;
    }
    return anchors;
  }

  // =============================================================
  // Phase 2 + Phase 3: Manual Mode silently teaches Auto Mode.
  //
  // Trigger: TD labels a manual line with a recognised POM number 1–16.
  // The tool runs a shadow detection on that image (cached per-image),
  // resolves the POM number to a *measurement meaning* (fixed for POMs
  // 1, 3, 5; confirmed once by the TD for POMs 6+), then records the
  // residual between the manual endpoints and the raw anchors of that
  // meaning. Phase 1 store, Auto Mode behavior, Manual Mode UI, and
  // auto_mode_rules.js all stay untouched.
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

  // Pull "1" out of labels like "1", "POM 1", "1A", "Underbust (1)".
  // Conservative: only accept if the number is in the 1–16 POM range.
  function parsePomNumberFromLabel(text) {
    if (!text) return null;
    const m = /(?:^|[^\d])(\d{1,2})(?:$|[^\d])/.exec(' ' + String(text) + ' ');
    if (!m) return null;
    const n = Number(m[1]);
    return (n >= 1 && n <= 16) ? String(n) : null;
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
    try { detection = detectSketchFromImage(image); }
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

  // ---- Phase 3: meaning catalog + confirmation store -----------------

  const MEANINGS_KEY = 'bra.pomMeanings.v1';

  // Built-in catalog. Each measurement maps a {start, end} anchor pair
  // to a human label. Seeded from the original POM_ENDPOINT_ANCHORS map
  // — these are the only meanings present on first launch. POMs 1/3/5
  // pin to entries here; POMs 6+ pick at confirmation time.
  const BUILTIN_MEANINGS = [
    { id: 'band-width',        label: 'Band width',          start: 'band-left',       end: 'band-right' },
    { id: 'chest-width',       label: 'Chest width',         start: 'chest-left',      end: 'chest-right' },
    { id: 'cf-height',         label: 'Center-front height', start: 'cf-top',          end: 'cf-bottom' },
    { id: 'cup-height',        label: 'Cup height',          start: 'inner-cup-top',   end: 'inner-cup-bottom' },
    { id: 'cup-width',         label: 'Cup width',           start: 'inner-cup-left',  end: 'inner-cup-right' },
    { id: 'side-height',       label: 'Side height',         start: 'side-top',        end: 'side-bottom' },
    { id: 'back-height',       label: 'Back height',         start: 'back-top',        end: 'back-bottom' },
    { id: 'back-panel-height', label: 'Back panel height',   start: 'back-panel-top',  end: 'back-panel-bottom' },
    { id: 'strap-length',      label: 'Strap length',        start: 'strap-top',       end: 'strap-bottom' },
    { id: 'back-strap-width',  label: 'Back strap width',    start: 'back-strap-left', end: 'back-strap-right' },
    { id: 'apex-width',        label: 'Apex width',          start: 'apex-left',       end: 'apex-right' },
  ];

  // POMs whose meaning never varies across styles. POM 2 and 4 are
  // omitted on purpose: their end points are derived (extension lines),
  // not anchors. evaluateManualPomSample() short-circuits both.
  const POM_FIXED_MEANINGS = {
    '1': 'band-width',
    '3': 'chest-width',
    '5': 'cf-height',
  };

  // localStorage shape (style-scoped, Phase 3.5):
  //   styles: {
  //     [styleId]:      { pomMeanings: { [pomNumber]: meaningId } },
  //     '__default__':  { pomMeanings: {...} }   // empty styleId falls here
  //   }
  //   customMeanings:   { [id]: { id, label, start, end } }   // shared
  //   usage:            { [meaningId]: { count, lastUsedAt } } // shared
  //
  // POM 9 = cup-height in Style A and POM 9 = side-height in Style B
  // never collide — each lives in its own style bucket.
  const DEFAULT_STYLE_ID = '__default__';

  let meaningStore = { styles: {}, customMeanings: {}, usage: {} };
  (function loadMeaningStore() {
    try {
      const raw = localStorage.getItem(MEANINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const styles = (parsed.styles && typeof parsed.styles === 'object') ? parsed.styles : {};
      // Migrate Phase 3.0 flat shape — { pomMeanings: {...} } at top
      // level — into the '__default__' style bucket so existing
      // confirmations on this machine survive the upgrade.
      if (parsed.pomMeanings && typeof parsed.pomMeanings === 'object' && !styles[DEFAULT_STYLE_ID]) {
        styles[DEFAULT_STYLE_ID] = { pomMeanings: parsed.pomMeanings };
      }
      meaningStore = {
        styles,
        customMeanings: parsed.customMeanings || {},
        usage:          parsed.usage          || {},
      };
    } catch (_) {}
  })();

  function saveMeaningStore() {
    try { localStorage.setItem(MEANINGS_KEY, JSON.stringify(meaningStore)); }
    catch (_) {}
  }

  function currentStyleId() {
    const id = (state && state.styleId && String(state.styleId).trim()) || '';
    return id || DEFAULT_STYLE_ID;
  }

  function getStyleBucket(styleId, createIfMissing) {
    let bucket = meaningStore.styles[styleId];
    if (!bucket && createIfMissing) {
      bucket = { pomMeanings: {} };
      meaningStore.styles[styleId] = bucket;
    }
    return bucket || null;
  }

  function getCatalogEntry(meaningId) {
    if (!meaningId) return null;
    const builtin = BUILTIN_MEANINGS.find(m => m.id === meaningId);
    return builtin || meaningStore.customMeanings[meaningId] || null;
  }

  function getAllCatalogMeanings() {
    const out = [];
    const seen = new Set();
    for (const m of BUILTIN_MEANINGS) { seen.add(m.id); out.push(m); }
    for (const id in meaningStore.customMeanings) {
      if (!seen.has(id)) out.push(meaningStore.customMeanings[id]);
    }
    return out;
  }

  function resolvePomMeaning(pom) {
    if (POM_FIXED_MEANINGS[pom]) return getCatalogEntry(POM_FIXED_MEANINGS[pom]);
    const bucket = getStyleBucket(currentStyleId(), false);
    const id = bucket ? bucket.pomMeanings[pom] : null;
    return id ? getCatalogEntry(id) : null;
  }

  function confirmPomMeaning(pom, meaningId) {
    const bucket = getStyleBucket(currentStyleId(), true);
    bucket.pomMeanings[pom] = meaningId;
    saveMeaningStore();
  }

  // Drop a single (style, pom) binding. Next POM N commit in that
  // style will re-open the meaning popover. Returns true if a binding
  // was actually removed.
  function forgetPomMeaning(pom, styleId) {
    const bucket = getStyleBucket(styleId || currentStyleId(), false);
    if (!bucket || !bucket.pomMeanings[pom]) return false;
    delete bucket.pomMeanings[pom];
    saveMeaningStore();
    return true;
  }

  // Sorted snapshot of confirmed bindings for one style. Used by the
  // Manage Meanings UI to list and edit prior confirmations.
  function listConfirmedMeanings(styleId) {
    const bucket = getStyleBucket(styleId || currentStyleId(), false);
    if (!bucket) return [];
    const rows = [];
    for (const pom of Object.keys(bucket.pomMeanings)) {
      const meaning = getCatalogEntry(bucket.pomMeanings[pom]);
      if (meaning) rows.push({ pom, meaning });
    }
    rows.sort((a, b) => Number(a.pom) - Number(b.pom));
    return rows;
  }

  function listKnownStyleIds() {
    return Object.keys(meaningStore.styles);
  }

  function addCustomMeaning(label, startAnchor, endAnchor) {
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) return null;
    const slug = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meaning';
    const id = 'custom-' + slug + '-' + Date.now().toString(36);
    const entry = { id, label: cleanLabel, start: startAnchor, end: endAnchor };
    meaningStore.customMeanings[id] = entry;
    saveMeaningStore();
    return entry;
  }

  // Clear meanings only. Accepts 'current' (current style only) or
  // 'all' (every style + every custom meaning + usage stats).
  function clearMeaningStore(scope) {
    if (scope === 'all') {
      meaningStore = { styles: {}, customMeanings: {}, usage: {} };
    } else {
      const styleId = currentStyleId();
      if (meaningStore.styles[styleId]) {
        meaningStore.styles[styleId] = { pomMeanings: {} };
      }
    }
    saveMeaningStore();
  }

  // Recency-decayed usage weight. A meaning confirmed yesterday should
  // outrank one that was confirmed 200 times two years ago but never
  // since — TDs change templates, and stale usage stats mislead the
  // top-3. Half-life of ~21d (exp(-21/30) ≈ 0.5) decays old confirmations
  // smoothly without ever zeroing them out completely.
  function meaningUsagePriority(meaningId) {
    const u = meaningStore.usage[meaningId];
    if (!u || !u.count) return 0;
    const ageMs = Math.max(0, Date.now() - (u.lastUsedAt || 0));
    const ageDays = ageMs / 86400000;
    return u.count * Math.exp(-ageDays / 30);
  }

  // Rank catalog entries by anchor-pair distance to the manual line.
  // Stroke direction is arbitrary, so we compare both orderings. Distance
  // dominates so the geometry of the current sketch always wins; ties
  // break on a recency-weighted usage score so a meaning the TD just
  // confirmed on the last two sketches floats above a stale heavyweight.
  function rankCatalogForLine(image, ann, limit) {
    if (!image || !ann || !ann.start || !ann.end) return [];
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return [];
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const scored = [];
    for (const m of getAllCatalogMeanings()) {
      const a = rawAnchors.find(r => r.kind === m.start);
      const b = rawAnchors.find(r => r.kind === m.end);
      if (!a || !b) continue;
      const direct  = (ms.x - a.x) ** 2 + (ms.y - a.y) ** 2 + (me.x - b.x) ** 2 + (me.y - b.y) ** 2;
      const swapped = (ms.x - b.x) ** 2 + (ms.y - b.y) ** 2 + (me.x - a.x) ** 2 + (me.y - a.y) ** 2;
      scored.push({ meaning: m, d: Math.min(direct, swapped), priority: meaningUsagePriority(m.id) });
    }
    scored.sort((x, y) => x.d - y.d || y.priority - x.priority);
    return scored.slice(0, limit || 3).map(s => s.meaning);
  }

  // Picks the nearest raw anchor to each manual endpoint independently.
  // Used when the TD names a brand-new measurement so we can register
  // its anchor pair without asking them to pick anchors.
  function detectAnchorPairForLine(image, ann) {
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors || rawAnchors.length < 2) return null;
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const d2 = (p, a) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    let bestStart = null, bestStartD = Infinity;
    let bestEnd   = null, bestEndD   = Infinity;
    for (const a of rawAnchors) {
      const ds = d2(ms, a);
      if (ds < bestStartD) { bestStartD = ds; bestStart = a; }
      const de = d2(me, a);
      if (de < bestEndD)   { bestEndD   = de; bestEnd   = a; }
    }
    if (!bestStart || !bestEnd || bestStart.kind === bestEnd.kind) return null;
    return { start: bestStart.kind, end: bestEnd.kind };
  }

  // Endpoint coord hash for de-dup. Re-commit with no movement → same
  // hash → skip. Move an endpoint → new hash → new sample.
  function makeLearnSampleHash(pom, ann) {
    return pom + '|'
      + ann.start.x.toFixed(2) + ',' + ann.start.y.toFixed(2) + '|'
      + ann.end.x.toFixed(2)   + ',' + ann.end.y.toFixed(2);
  }

  // Returns one of:
  //   { status: 'recorded',          pom }
  //   { status: 'skipped' }                              — no learning happens
  //   { status: 'needsConfirmation', pom, ann, image, hash, suggestions }
  //     — caller should open the meaning picker. After the TD picks,
  //       call commitMeaningChoice() / commitMeaningChoiceCustom() with
  //       the original eval result.
  function evaluateManualPomSample(ann) {
    if (!ann || !ann.start || !ann.end) return { status: 'skipped' };
    if (!isLearningEnabled())            return { status: 'skipped' };
    if (ann.auto === true)               return { status: 'skipped' };

    const pom = parsePomNumberFromLabel(ann.text);
    if (!pom) return { status: 'skipped' };

    // POMs 2 and 4: derived endpoints (extension lines). Skip silently.
    const pomNum = Number(pom);
    if (pomNum === 2 || pomNum === 4) return { status: 'skipped' };

    const image = pickImageForAnnotation(ann);
    if (!image) return { status: 'skipped' };

    const hash = makeLearnSampleHash(pom, ann);
    if (ann.learnSampleHash === hash) return { status: 'skipped' };

    const meaning = resolvePomMeaning(pom);
    if (meaning) {
      const ok = applyMeaningSample(ann, image, pom, meaning, hash);
      return { status: ok ? 'recorded' : 'skipped', pom };
    }

    // POM 6+ with no confirmed meaning — surface to the UI.
    const suggestions = rankCatalogForLine(image, ann, 3);
    return { status: 'needsConfirmation', pom, ann, image, hash, suggestions };
  }

  // Records the residual for a (line, meaning) pair through the Phase 1
  // store. Returns true if the sample was actually committed.
  function applyMeaningSample(ann, image, pom, meaning, hash) {
    if (!meaning) return false;
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return false;
    const startAnchor = rawAnchors.find(a => a.kind === meaning.start);
    const endAnchor   = rawAnchors.find(a => a.kind === meaning.end);
    if (!startAnchor || !endAnchor) return false;

    const manualStart = worldToAnchorSpace(image, ann.start);
    const manualEnd   = worldToAnchorSpace(image, ann.end);

    // Stroke orientation is arbitrary — pair endpoints by min total distance.
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    const direct  = d2(manualStart, startAnchor) + d2(manualEnd, endAnchor);
    const swapped = d2(manualStart, endAnchor)   + d2(manualEnd, startAnchor);
    const pairs = direct <= swapped
      ? [[startAnchor, manualStart], [endAnchor, manualEnd]]
      : [[startAnchor, manualEnd],   [endAnchor, manualStart]];

    // Label-collision guardrail: a manual line more than half the image
    // away from the predicted anchor is almost certainly mislabeled.
    const maxResidual = 0.50;
    for (const [anchor, manual] of pairs) {
      if (Math.abs(manual.x - anchor.x) > maxResidual) return false;
      if (Math.abs(manual.y - anchor.y) > maxResidual) return false;
    }

    for (const [anchor, manual] of pairs) {
      recordAnchorResidual(anchor.kind, manual.x - anchor.x, manual.y - anchor.y);
    }

    ann.learnSampleHash = hash;
    ann.learnSamplePom  = pom;
    ann.learnMeaningId  = meaning.id;

    if (meaning.id) {
      const u = meaningStore.usage[meaning.id] || { count: 0, lastUsedAt: 0 };
      u.count += 1;
      u.lastUsedAt = Date.now();
      meaningStore.usage[meaning.id] = u;
      saveMeaningStore();
    }
    return true;
  }

  // TD picked an existing catalog entry from the popover.
  function commitMeaningChoice(evalResult, meaningId) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const meaning = getCatalogEntry(meaningId);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaningId);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
  }

  // TD typed a brand-new measurement name. We auto-detect the anchor
  // pair from the manual line itself, register it as a custom meaning,
  // pin POM N to it, then record the sample.
  function commitMeaningChoiceCustom(evalResult, label) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const pair = detectAnchorPairForLine(evalResult.image, evalResult.ann);
    if (!pair) return false;
    const meaning = addCustomMeaning(label, pair.start, pair.end);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaning.id);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
  }

  // Backward-compat thin wrapper. Debug / smoke paths that just want
  // "did it record?" keep working. Skips POM 6+ confirmation UI —
  // returns false in that case (no toast, no sample).
  function recordManualPomResidual(ann) {
    const result = evaluateManualPomSample(ann);
    return result.status === 'recorded';
  }
