// Auto Mode "Generate Drafts" action: the UI-action orchestration around the
// fixture engine — mode/image/anchor guards, the destructive-replace confirm,
// the front-outer / front-inner two-pass build (US-049), learning-evidence
// hooks, telemetry, and the history/UI/render side effects.
// Source part for app.js. Run `npm run build` after editing.
//
// The geometry itself lives in pom-fixture-builder.js
// (buildPOMFixtureFromAnchors); the fixture is validated by
// validate-fixture.js and turned into draft records by
// build-draft-annotation.js. autoApplyGeneratedDrafts hands off to
// approveDraftAnnotation (draft-actions.js) and applyApprovedDraftsAtomically
// (apply-drafts.js).

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
    if (state.autoMode.draftAnnotations.length > 0 && !options.suppressReplacePrompt) {
      const msg = approvedCount > 0
        ? `Generate will replace ${state.autoMode.draftAnnotations.length} existing draft(s), including ${approvedCount} approved one(s). Continue?`
        : `Generate will replace ${state.autoMode.draftAnnotations.length} existing draft(s). Continue?`;
      if (!window.confirm(msg)) return;
    }

    // US-049: the front-outer pass measures against the ONE detection source
    // image. Anchors relocated to the front-inner view (POM 9/10/17/18) carry
    // that photo's id, so exclude them here — those POMs are (re)generated in
    // the inner pass below. With no inner view every anchor is on the source
    // image, so this filter is a no-op and behaviour is unchanged.
    const frontAnchors = state.autoMode.anchors.filter(an => an.sourceImageId === sourceImage.id);
    const fixture = buildPOMFixtureFromAnchors(frontAnchors);
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
    if (typeof applyStyleAbsenceEvidenceToDrafts === 'function') {
      applyStyleAbsenceEvidenceToDrafts(drafts);
    }
    // Soft-pull endpoints toward the median of recent TD-confirmed lines
    // for this style. Runs after the absence pass so REVIEW_ONLY drafts
    // stay wiped, and before label collision avoidance so labels follow
    // the nudged endpoints.
    if (typeof applyStyleConfirmedEvidenceToDrafts === 'function') {
      applyStyleConfirmedEvidenceToDrafts(drafts, sourceImage);
    }

    // US-049: second pass — measure POM 9/10/17/18 on the front-inner view when
    // one is present. The inner photo carries its OWN detection + anchor set
    // (seeded in buildAuxViews); build a fixture against it — temporarily
    // swapping the active detection so cupModel/landmark reads come from the
    // inner photo — and REPLACE the front-outer placeholders for those POMs
    // (which came out REVIEW_ONLY once their anchors moved off the source
    // image). POM 8 and every other POM keep their front-outer geometry.
    let finalDrafts = drafts;
    const innerView = (state.autoMode.detection && Array.isArray(state.autoMode.detection.auxViews))
      ? state.autoMode.detection.auxViews.find(v => v && v.viewRole === 'front_inner' && v.detection && Array.isArray(v.anchors) && v.anchors.length)
      : null;
    if (innerView) {
      const innerImage = getImageById(innerView.sourceImageId);
      if (innerImage && innerImage.width) {
        const MOVED_POMS = ['9', '10', '17', '18'];
        const savedDet = state.autoMode.detection;
        let innerFixture = null;
        try {
          state.autoMode.detection = innerView.detection;
          innerFixture = buildPOMFixtureFromAnchors(innerView.anchors);
        } finally {
          state.autoMode.detection = savedDet;
        }
        const innerValidation = innerFixture ? validateAutoFixture(innerFixture) : { status: 'fail' };
        if (innerFixture && innerValidation.status !== 'fail') {
          const innerDrafts = innerFixture.annotations
            .filter(row => MOVED_POMS.indexOf(String(row.pom)) >= 0)
            .map(row => buildDraftAnnotation(row, innerImage, innerFixture, runId));
          finalDrafts = drafts.filter(d => MOVED_POMS.indexOf(String(d.seq)) < 0).concat(innerDrafts);
        }
      }
    }

    nudgeAutoLabelsToAvoidCollisions(finalDrafts);

    state.autoMode.draftAnnotations = finalDrafts;
    state.autoMode.validation = validation;
    state.autoMode.runId = runId;
    state.autoMode.status = 'reviewing';
    state.autoMode.lastError = null;
    state.selection = { kind: null, id: null };
    recordAutoTelemetryEvent('drafts_generated', {
      sourceImageId: sourceImage.id,
      run_id: runId,
      draft_count: finalDrafts.length,
    });

    pushHistoryIfChanged();
    updateUI();
    requestRender();

    // Test/debug hook: keep the drafts on the board for row-by-row review
    // instead of committing them (used by the smoke and pipeline runners).
    if (options.keepDraftsForReview) {
      showToast('Generated ' + drafts.length + ' POM draft(s). Review and approve each row.');
      return;
    }
    autoApplyGeneratedDrafts(drafts.length);
  }

  // Streamlined flow: after Generate Drafts, auto-approve every drawable
  // draft and commit it as a real annotation immediately — the TD is not
  // asked to approve rows one by one. Review-only rows have no drawable
  // line, so they are dropped with a note in the toast. If apply fails
  // (e.g. duplicate POM rows on the same image) the drafts stay on the
  // board so the TD can resolve the issue with the review controls.
  function autoApplyGeneratedDrafts(generatedCount) {
    const drawable = state.autoMode.draftAnnotations.filter(d => !isReviewOnlyDraft(d));
    if (drawable.length === 0) {
      showToast('Generated ' + generatedCount + ' draft(s), but none were drawable. Review and resolve them.', 4200);
      return;
    }
    for (const draft of drawable) approveDraftAnnotation(draft);
    const applied = applyApprovedDraftsAtomically();
    if (!applied) {
      for (const draft of drawable) draft.tdApproved = false;
      updateUI();
      return;
    }
    const reviewOnlyLeft = state.autoMode.draftAnnotations.length;
    if (reviewOnlyLeft > 0) discardAutoDrafts(true);
    let msg = 'Applied ' + drawable.length + ' POM line' + (drawable.length === 1 ? '' : 's') + '.';
    if (reviewOnlyLeft > 0) {
      msg += ' (' + reviewOnlyLeft + ' review-only row' + (reviewOnlyLeft === 1 ? '' : 's') + ' dropped — no reliable line could be placed.)';
    }
    showToast(msg, 4200);
  }
