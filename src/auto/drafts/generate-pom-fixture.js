// Auto Mode POM fixture generator: turn the current anchor positions
// into 16 fixture rows that buildDraftAnnotation can convert into drafts.
// Source part for app.js. Run `npm run build` after editing.
//
// The fixture is the contract between the anchor model and the draft
// annotation builder. effectivePomViewRole picks the view box each POM
// renders in, so a 3-view sketch can place front-outer-only POMs in the
// outer column without disturbing the back view.

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
    // US-037: neckline (171 center-front → 172 right strap) + armhole endpoints.
    const necklineCenter = at('171');
    const necklineStrap  = at('172');
    // Armhole endpoints. TD 2026-07-18: 181 = underarm (bottom of the arm
    // opening), 182 = strap junction (top). The curve connects them either
    // way; start on 181 to match the CLA contract test.
    const armholeBot = at('181'); // underarm (bottom)
    const armholeTop = at('182'); // strap junction (top)
    // matchContourForCurve fits controls that PASS THROUGH the arc's 1/3 and
    // 2/3 samples. For a long, strongly-curved arc (e.g. the armhole wrapping
    // strap→underarm) that solve can throw a control far outside [0,1]; when we
    // then clamp it the curve distorts into a wiggle. Only accept traced
    // controls that land in a sane band around the view; otherwise fall back to
    // a clean geometric bow (below).
    const traceControlSane = (p) => p
      && p.x >= -0.1 && p.x <= 1.1 && p.y >= -0.1 && p.y <= 1.1;
    const traceIsUsable = (t) => t && t.score >= 0.55
      && traceControlSane(t.c1) && traceControlSane(t.c2);
    // Reject a traced curve whose belly DIPS past the lower endpoint into the
    // body (larger y). For the neckline/armhole EDGE the curve must stay on the
    // opening side (above/outward); a downward dip means the fit locked onto an
    // inner cup / cradle / princess seam instead of the edge (TD 2026-07-18,
    // demo5: 172/182 at the join → the arc between them found a dipping seam and
    // POM 17/18 drew a V into the cup). Sample the (clamped) cubic in y.
    const traceShapeOk = (t, A, B) => {
      if (!t) return false;
      const c1y = clamp01(t.c1.y), c2y = clamp01(t.c2.y);
      const lowerY = Math.max(A.y, B.y);
      // Tolerance is SPAN-RELATIVE (with a small floor): a fixed absolute
      // tolerance reads as tight on short arcs and loose on long ones, so a long
      // armhole could dip a visible fraction of its own span yet still pass
      // (demo1). Allow the belly to sit at most 7% of the endpoint span below
      // the lower endpoint.
      const tol = Math.max(0.015, Math.abs(A.y - B.y) * 0.07);
      let maxY = -Infinity;
      for (let u = 0.15; u <= 0.86; u += 0.1) {
        const m = 1 - u;
        const y = m * m * m * A.y + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u * u * u * B.y;
        if (y > maxY) maxY = y;
      }
      return maxY <= lowerY + tol;
    };
    // POM 17 "Neckline length" curve. TD 2026-07-18: it must run ALONG the
    // actual neckline edge — and neckline shapes differ (V / scoop / plunge),
    // so a fixed geometric bow can't match them. Primary path: TRACE the
    // detected neckline contour between 171 and 172 (matchContourForCurve fits
    // a cubic through the real edge arc, endpoints staying on the anchors).
    //
    // The endpoints are the measurement points and stay EXACTLY on 171/172 —
    // no parallel offset. An earlier build shifted the whole curve "up into
    // the opening" to avoid covering the seam, but the neckline sits at the
    // TOP of the front_outer view crop, so shifting up pushed the curve past
    // the crop's top edge (it read as a bulge shooting up to the strap). A
    // curve that traces the edge already reads as measuring the edge.
    const neck17start = { x: clamp01(necklineCenter.x), y: clamp01(necklineCenter.y) };
    const neck17end = { x: clamp01(necklineStrap.x), y: clamp01(necklineStrap.y) };
    const neck17c1 = lerp(necklineCenter, necklineStrap, 0.35);
    const neck17c2 = lerp(necklineCenter, necklineStrap, 0.65);
    {
      const detN = state.autoMode && state.autoMode.detection;
      const paths = detN && detN.contours && detN.contours.paths;
      const traced = (typeof matchContourForCurve === 'function' && paths && paths.length)
        ? matchContourForCurve(paths, neck17start, neck17end, { preferThin: true })
        : null;
      // POM 17 keeps the plain range behaviour (short neckline arc, tame
      // controls, TD-confirmed) but gains the SHAPE guard: reject a trace that
      // dips into the cup (demo5) so it doesn't draw a V. Clean monotonic
      // necklines (demo8) still trace.
      if (traced && traced.score >= 0.55 && traceShapeOk(traced, neck17start, neck17end)) {
        // Controls may fall slightly outside [0,1]; clamp defensively. The
        // neckline is interior so this rarely bites.
        neck17c1.x = clamp01(traced.c1.x); neck17c1.y = clamp01(traced.c1.y);
        neck17c2.x = clamp01(traced.c2.x); neck17c2.y = clamp01(traced.c2.y);
      } else {
        // Fallback (no clean contour): a GENTLE bow toward the neckline
        // opening (upward perpendicular). Necklines run center-front → strap
        // roughly along a near-straight arm, so the bow stays small; the real
        // shape comes from the trace above when it is available.
        const ndx = neck17end.x - neck17start.x;
        const ndy = neck17end.y - neck17start.y;
        const nlen = Math.max(0.0001, Math.hypot(ndx, ndy));
        let px = -ndy / nlen, py = ndx / nlen;
        if (py > 0) { px = -px; py = -py; } // upward → into the neckline opening
        const neckBow = 0.02;
        neck17c1.x = clamp01(neck17c1.x + px * neckBow); neck17c1.y = clamp01(neck17c1.y + py * neckBow);
        neck17c2.x = clamp01(neck17c2.x + px * neckBow); neck17c2.y = clamp01(neck17c2.y + py * neckBow);
      }
    }
    // POM 18 "Armhole curve length": like POM 17, TRACE the real arm-opening
    // edge between 181 (underarm) and 182 (strap junction) when a clean contour
    // exists; otherwise bow the curve OUTWARD toward the arm edge (+x on the
    // right side). Endpoints stay on the anchors; lineLength reports the
    // sampled arc length.
    const arm18start = { x: clamp01(armholeBot.x), y: clamp01(armholeBot.y) }; // 181 underarm
    const arm18end   = { x: clamp01(armholeTop.x), y: clamp01(armholeTop.y) }; // 182 strap
    const arm18c1 = lerp(arm18start, arm18end, 0.35);
    const arm18c2 = lerp(arm18start, arm18end, 0.65);
    {
      const detA = state.autoMode && state.autoMode.detection;
      const pathsA = detA && detA.contours && detA.contours.paths;
      const tracedA = (typeof matchContourForCurve === 'function' && pathsA && pathsA.length)
        ? matchContourForCurve(pathsA, arm18start, arm18end, { preferThin: true })
        : null;
      if (traceIsUsable(tracedA) && traceShapeOk(tracedA, arm18start, arm18end)) {
        arm18c1.x = clamp01(tracedA.c1.x); arm18c1.y = clamp01(tracedA.c1.y);
        arm18c2.x = clamp01(tracedA.c2.x); arm18c2.y = clamp01(tracedA.c2.y);
      } else {
        // Fallback: bow OUTWARD toward the arm edge (+x on the right side).
        const armholeBow = 0.055;
        arm18c1.x = clamp01(arm18c1.x + armholeBow);
        arm18c2.x = clamp01(arm18c2.x + armholeBow);
      }
    }
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

    // POM 2 / 4 extensions beyond their parent endpoint.
    // Spec: POM 2 length = 1/5 of POM 1 length; POM 4 length = 1/5 of POM 3
    // length. Both rendered as dashed extensions off the right endpoint of
    // their parent POM. The previous front-view-edge clamp shrank the
    // extension to near-zero when band/chest-right sat at the detected
    // front-view boundary (common on auto-detected sketches), so we drop
    // the clamp and only keep the image-bounds [0,1] guard.
    const det = state.autoMode && state.autoMode.detection;
    const pom1Length = bandR.x - bandL.x;
    const pom3Length = chestR.x - chestL.x;
    const ext2End = { x: clamp01(bandR.x  + pom1Length / 5), y: bandR.y };
    const ext4End = { x: clamp01(chestR.x + pom3Length / 5), y: chestR.y };

    // Inner-cup curve control points (Bezier). POM 9 is a vertical-ish curve
    // through the cup body that bows toward the cup's OUTER side (armhole
    // edge). The bow direction depends on which cup the cupModel picked —
    // left cup bows LEFT, right cup bows RIGHT. Fall back to LEFT when no
    // cupModel is available.
    const cupModelForCurves = det && det.cupModel;
    const cupSide = cupModelForCurves && cupModelForCurves.visibility !== 'hidden'
      ? (cupModelForCurves.side < 0 ? -1 : +1)
      : -1;
    const ic9bow = 0.017 * cupSide;
    const ic9c1 = lerp(icTop, icBot, 0.38);
    const ic9c2 = lerp(icTop, icBot, 0.68);
    ic9c1.x = clamp01(ic9c1.x + ic9bow);
    ic9c2.x = clamp01(ic9c2.x + ic9bow);
    // POM 10 is a horizontal curve at the cup mid-row that dips slightly
    // DOWN — the bust arc sags between inner and outer cup edges.
    const ic10c1 = lerp(icL, icR, 0.34);
    const ic10c2 = lerp(icL, icR, 0.63);
    ic10c1.y = clamp01(ic10c1.y + 0.052);
    ic10c2.y = clamp01(ic10c2.y + 0.039);

    // POM 8 — cup height at center front.
    //
    // Per rule.md, POM 8 measures from the upper-cup seam at CF down to the
    // cradle/cup-bottom seam at CF. Both endpoints come from detected anchors
    // (cf-top and cradle-cf-top); no ratio fallback. The drafter row below
    // forces shared x = cf-top.x so the line is strictly vertical even if the
    // TD nudges one anchor sideways after detection. When cradle-cf-top is
    // missing, the requiredAnchors guard in POM_TEMPLATE['8'] demotes the row
    // to REVIEW_ONLY automatically.
    const cradleCfAnchorForPom8 = a['cradle-cf-top'] || null;
    const cupHeightTop = cradleCfAnchorForPom8
      ? { x: clamp01(cfTop.x), y: clamp01(cfTop.y) }
      : null;
    const cupHeightBottom = cradleCfAnchorForPom8
      ? { x: clamp01(cfTop.x), y: clamp01(cradleCfAnchorForPom8.y) }
      : null;

    // POM 6 — cradle height at CF.
    // Requires the cradle-cf-top anchor (only seeded when the detector found
    // actual ink support for a cradle seam at the CF axis — no ratio fallback).
    // The line is drawn vertical: start.x === end.x. The x is nudged slightly
    // OFF the CF axis so POM 6 reads as a distinct measurement next to POM 5
    // rather than overlapping it.
    const cradleCfAnchor = a['cradle-cf-top'] || null;
    const cradleCfX = cradleCfAnchor
      ? clamp01(cradleCfAnchor.x + halfBand * 0.045)
      : null;
    const cradleCfTopPt = cradleCfAnchor && cradleCfX != null
      ? { x: cradleCfX, y: cradleCfAnchor.y }
      : null;
    const cradleCfBottomPt = cradleCfAnchor && cradleCfX != null
      ? { x: cradleCfX, y: cfBot.y }
      : null;

    // POM 7 — cradle height at bottom cup (vertical on cup side).
    // Requires detected cradle-cup-top + cradle-cup-bottom anchors. The
    // detector only seeds them when (a) there's ink support at the cradle row
    // away from the CF axis and (b) ink support at the band row directly
    // below. The endpoints are forced to share an x so the line is strictly
    // vertical, even if the user nudges one anchor sideways post-detect — the
    // x is taken from the TOP anchor (the bottom-cup seam point).
    const cradleCupTopAnchor = a['cradle-cup-top'] || null;
    const cradleCupBottomAnchor = a['cradle-cup-bottom'] || null;
    const cradleCupHaveAnchors = !!(cradleCupTopAnchor && cradleCupBottomAnchor);
    const cradleCupTop = cradleCupHaveAnchors
      ? { x: clamp01(cradleCupTopAnchor.x), y: clamp01(cradleCupTopAnchor.y) }
      : null;
    const cradleCupBottom = cradleCupHaveAnchors
      ? { x: clamp01(cradleCupTopAnchor.x), y: clamp01(cradleCupBottomAnchor.y) }
      : null;

    // Inner-cup curves — POM 9 (vertical) and POM 10 (horizontal). The
    // hand-tuned lerp formula above is reliable across typical bra sketches;
    // matchContourForCurve was occasionally locking onto unrelated thin
    // contours (e.g. lace petals) and producing wildly-wrong controls. Keep
    // the formula and skip contour matching here.
    const ic9controls = { c1: ic9c1, c2: ic9c2 };
    const ic10controls = { c1: ic10c1, c2: ic10c2 };

    // POM 14 is strap LENGTH: front strap upper joining seam → back strap end.
    // This necessarily crosses the front/back sketch gap on a flat tech-pack
    // page, so draw it as a curve that travels over the shoulder instead of a
    // straight line inside the back view.
    const strapLengthStart = strapTop;
    const strapLengthEnd = strapBot;
    const strapLengthDX = Math.abs(strapLengthEnd.x - strapLengthStart.x);
    const strapLengthDY = Math.abs(strapLengthEnd.y - strapLengthStart.y);
    const strapLengthApexY = Math.min(strapLengthStart.y, strapLengthEnd.y);
    const strapLengthArc = Math.max(strapLengthDX * 0.32, strapLengthDY * 0.65 + 0.08);
    // NOTE: lerp() in this file is a POINT lerp — passing scalars returns
    // {x: NaN, y: NaN}, which clamp01 silently coerced to 0 and pinned both
    // curve handles to the left image edge. Interpolate the x scalars inline.
    const lerpNum = (a, b, t) => a + (b - a) * t;
    const strap14c1 = {
      x: clamp01(lerpNum(strapLengthStart.x, strapLengthEnd.x, 0.35)),
      y: strapLengthApexY - strapLengthArc,
    };
    const strap14c2 = {
      x: clamp01(lerpNum(strapLengthStart.x, strapLengthEnd.x, 0.72)),
      y: strapLengthApexY - strapLengthArc * 0.72,
    };

    const pom15Row = hasBackStrap
      ? { fixtureId: 'gen-15', pom: '15', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('15'),
        // Strap distance is a horizontal span — force end.y to start.y so the
        // line stays level even if the two anchors sit at different heights.
        start: backStrapL, end: { x: backStrapR.x, y: backStrapL.y },
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
        // 1/2 bottom band is a horizontal span — force end.y to start.y.
        start: bandL, end: { x: bandR.x, y: bandL.y },
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
        // 1/2 chest is a horizontal span — force end.y to start.y.
        start: chestL, end: { x: chestR.x, y: chestL.y },
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

      // POM 6 — cradle height at CF (vertical, cradle-cf-top → cf-bottom).
      // Start is the detected cradle-at-CF anchor (seeded only with real ink
      // support for a cradle seam at the CF axis); end is cf-bottom, with x
      // forced to match start so the line is strictly vertical. No ratio
      // fallback — without the anchor this row demotes to REVIEW_ONLY via the
      // missing-anchor guard below.
      cradleCfAnchor
        ? { fixtureId: 'gen-6', pom: '6', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('6'),
            start: cradleCfTopPt,
            end: cradleCfBottomPt,
            drawability: 'DRAWABLE', confidence: 'medium',
            proposedStartLandmark: 'cradle-at-CF',
            proposedEndLandmark: 'cf-bottom',
            reason: 'Cradle height at center front — top from detected cradle seam, bottom at CF.' }
        : { fixtureId: 'gen-6', pom: '6', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('6'),
            drawability: 'REVIEW_ONLY', confidence: 'low',
            proposedStartLandmark: 'cradle-at-CF',
            proposedEndLandmark: 'cf-bottom',
            uncertainty: 'No reliable cradle-height-at-center-front seam was detected.',
            reason: 'No reliable cradle-height-at-center-front seam was detected.' },

      // POM 7 — cradle height at the bottom of the cup (vertical on cup side).
      // Start/end come from the detected cradle-cup anchors; the line is
      // strictly vertical (end.x === start.x). Without both anchors the row
      // demotes to REVIEW_ONLY with an explicit reason — no horizontal-ratio
      // fallback.
      cradleCupHaveAnchors
        ? { fixtureId: 'gen-7', pom: '7', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('7'),
            start: cradleCupTop,
            end: cradleCupBottom,
            drawability: 'DRAWABLE', confidence: 'medium',
            proposedStartLandmark: 'cradle-cup-top',
            proposedEndLandmark: 'cradle-cup-bottom',
            reason: 'Cradle height at cup bottom — top from detected cup-bottom seam, bottom on band baseline.' }
        : { fixtureId: 'gen-7', pom: '7', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('7'),
            drawability: 'REVIEW_ONLY', confidence: 'low',
            proposedStartLandmark: 'cradle-cup-top',
            proposedEndLandmark: 'cradle-cup-bottom',
            uncertainty: 'No reliable cradle-height-at-bottom-cup seam was detected.',
            reason: 'No reliable cradle-height-at-bottom-cup seam was detected.' },

      // POM 8 — cup height at CF (vertical from cf-top → cradle-cf-top).
      // Per rule.md the endpoints are real seam anchors: the upper-cup seam at
      // CF (cf-top, "where the cradle meets the chest line") and the cradle /
      // cup-bottom seam at CF (cradle-cf-top, POM 6's top). End.x is forced to
      // start.x so the line stays strictly vertical even if the TD drags one
      // anchor sideways after seeding. Without cradle-cf-top the row demotes
      // to REVIEW_ONLY — no ratio fallback to chest+band proportions.
      cradleCfAnchorForPom8
        ? { fixtureId: 'gen-8', pom: '8', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('8'),
            start: cupHeightTop,
            end: cupHeightBottom,
            drawability: 'DRAWABLE', confidence: 'medium',
            proposedStartLandmark: 'cf-top',
            proposedEndLandmark: 'cradle-at-CF',
            reason: 'Cup height at CF — top from cf-top, bottom from detected cradle seam at CF.' }
        : { fixtureId: 'gen-8', pom: '8', type: 'straight', style: 'solid', arrowType: 'double',
            viewRole: effectivePomViewRole('8'),
            drawability: 'REVIEW_ONLY', confidence: 'low',
            proposedStartLandmark: 'cf-top',
            proposedEndLandmark: 'cradle-at-CF',
            uncertainty: 'No reliable cradle-height-at-center-front seam was detected, so cup height at CF cannot be placed.',
            reason: 'No reliable cradle-height-at-center-front seam was detected.' },

      // POM 9 — inner cup vertical (curved).
      // POM 9 / POM 10 share one cupModel built during detection. The
      // cupModel selects ONE cup side, ONE view, and derives top / bottom /
      // inner-edge / outer-edge from real structure (apex + cup-bottom seam).
      // drawability / confidence track cupModel.visibility:
      //   - direct (front_inner view drawn separately): DRAWABLE / medium-high
      //   - inferred (front_outer; apex + seam coherent): APPROXIMATE / medium
      //   - hidden: would already demote to REVIEW_ONLY via requiredAnchors
      //     because seedAnchorsFromDetection skips inner-cup-* in that case.
      // sharedAnchorFamily ties POM 9 and POM 10 to the same cup so the
      // validator can flag any future divergence.
      ((function buildPom9() {
        const cm = det && det.cupModel;
        // Default to REVIEW_ONLY: a null or 'hidden' cupModel means we never
        // saw the cup, so it must NOT ship as a confident drawn curve (P3).
        // Only a 'direct' or 'inferred' cup promotes it below. (The
        // requiredAnchors guard usually catches hidden cups by absent anchors;
        // this is the belt-and-suspenders for when anchors survive anyway.)
        let drawability = 'REVIEW_ONLY';
        let confidence = 'low';
        let reason = 'Cup height — no usable cup model (hidden or absent); place manually.';
        if (cm) {
          if (cm.visibility === 'direct') {
            drawability = 'DRAWABLE';
            confidence = 'medium';
            reason = `Cup height — direct cup view (cup side ${cm.side < 0 ? 'left' : 'right'}, ${cm.viewRole}). ${cm.reason || ''}`.trim();
          } else if (cm.visibility === 'inferred') {
            drawability = 'APPROXIMATE';
            // POM 9 height needs a trustworthy BOTH ends: a real cup top (apex)
            // and a real cup bottom. The bottom counts as real when POM 7
            // committed a seam (bottomFromSeam) OR when a coherent underwire arc
            // was traced from the ink (bottomFromInk). A bare flat-cradle-row
            // guess (neither flag) stays 'low'.
            const bottomOk = cm.bottomFromSeam || cm.bottomFromInk;
            confidence = (cm.topFromApex && bottomOk) ? 'medium' : 'low';
            reason = `Cup height — inferred (cup side ${cm.side < 0 ? 'left' : 'right'}). ${cm.reason || ''}`.trim();
          }
        }
        return {
          fixtureId: 'gen-9', pom: '9', type: 'curved', style: 'solid', arrowType: 'double',
          viewRole: effectivePomViewRole('9'),
          start: icTop, end: icBot, control1: ic9controls.c1, control2: ic9controls.c2,
          drawability, confidence,
          sharedAnchorFamily: 'inner-cup',
          proposedStartLandmark: 'inner-cup top',
          proposedEndLandmark: 'inner-cup bottom',
          reason,
        };
      })()),

      // POM 10 — inner cup horizontal (curved). See POM 9 above; the two POMs
      // share the same cupModel (sharedAnchorFamily = 'inner-cup').
      ((function buildPom10() {
        const cm = det && det.cupModel;
        // Default REVIEW_ONLY for a null/'hidden' cupModel — see POM 9 (P3).
        let drawability = 'REVIEW_ONLY';
        let confidence = 'low';
        let reason = 'Cup width — no usable cup model (hidden or absent); place manually.';
        if (cm) {
          if (cm.visibility === 'direct') {
            drawability = 'DRAWABLE';
            confidence = 'medium';
            reason = `Cup width — direct cup view (cup side ${cm.side < 0 ? 'left' : 'right'}, ${cm.viewRole}). ${cm.reason || ''}`.trim();
          } else if (cm.visibility === 'inferred') {
            drawability = 'APPROXIMATE';
            // Cup WIDTH rests on the horizontal extent of the traced cup
            // contour (inner-cup-left → inner-cup-right), anchored to the
            // validated apex. It does NOT depend on the cup-BOTTOM seam —
            // that gates POM 9 height's END only. Gate width on contour
            // quality (contourConfidence tracks the apex confidence), so a
            // well-traced cup is not penalized for a missing bottom seam.
            confidence = ((cm.contourConfidence || 0) >= 0.6) ? 'medium' : 'low';
            reason = `Cup width — inferred (cup side ${cm.side < 0 ? 'left' : 'right'}). ${cm.reason || ''}`.trim();
          }
        }
        return {
          fixtureId: 'gen-10', pom: '10', type: 'curved', style: 'solid', arrowType: 'double',
          viewRole: effectivePomViewRole('10'),
          start: icL, end: icR, control1: ic10controls.c1, control2: ic10controls.c2,
          drawability, confidence,
          sharedAnchorFamily: 'inner-cup',
          proposedStartLandmark: 'inner-cup left',
          proposedEndLandmark: 'inner-cup right',
          reason,
        };
      })()),

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

      // POM 14 — shoulder strap length:
      // front strap upper joining seam → end of the shoulder strap at the back.
      // The only contractually-low POM (always verify by hand); front-only
      // sketches have no back strap end, so the missing-anchor guard below
      // demotes it to REVIEW_ONLY.
      { fixtureId: 'gen-14', pom: '14', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('14'),
        start: strapLengthStart, end: strapLengthEnd, control1: strap14c1, control2: strap14c2,
        drawability: 'DRAWABLE', confidence: 'low',
        proposedStartLandmark: 'front strap upper join', proposedEndLandmark: 'back strap end',
        reason: 'Shoulder strap length from the front strap upper joining seam to the back strap end.' },

      // POM 15 — back strap distance
      pom15Row,

      // POM 16 — front apex distance
      { fixtureId: 'gen-16', pom: '16', type: 'straight', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('16'),
        // Apex distance is a horizontal span — force end.y to start.y.
        start: apexL, end: { x: apexR.x, y: apexL.y },
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: 'apex-left', proposedEndLandmark: 'apex-right',
        reason: 'Front apex-to-apex distance.' },

      // POM 17 — neckline length: curve tracing the neckline edge from the
      // center front (171) up to the right strap junction (172).
      { fixtureId: 'gen-17', pom: '17', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('17'),
        start: neck17start, end: neck17end, control1: neck17c1, control2: neck17c2,
        drawability: 'DRAWABLE', confidence: 'medium',
        proposedStartLandmark: '171', proposedEndLandmark: '172',
        reason: 'Neckline length from center front to the strap (drawn just inside the neckline).' },

      // POM 18 — armhole curve length: traced arc from the strap junction to
      // the underarm, bowed outward toward the arm edge. Curve, not straight;
      // lineLength samples the bezier for the true arc length. Bowed guess
      // (no direct edge trace yet) → APPROXIMATE + low confidence, always
      // reviewRequired via the 'low' anchor tiers.
      { fixtureId: 'gen-18', pom: '18', type: 'curved', style: 'solid', arrowType: 'double',
        viewRole: effectivePomViewRole('18'),
        start: arm18start, end: arm18end, control1: arm18c1, control2: arm18c2,
        drawability: 'APPROXIMATE', confidence: 'low',
        proposedStartLandmark: '181', proposedEndLandmark: '182',
        reason: 'Armhole curve length from the underarm to the strap junction.' },
    ];

    // Review-note plumbing (Engineering Workflow Phase 7, item 4). When a POM
    // cannot be drawn, the row must say WHICH anchors are missing and WHY, in
    // TD language. The "why" comes from the Phase 6 landmark QA layer
    // (detection.landmarkQa) — e.g. "missing seam: bottom-cup cradle seam not
    // found". Display names come from the anchor schema. Both fields are
    // additive: drawability / confidence / geometry decisions are unchanged.
    const qaByKind = (det && det.landmarkQa && det.landmarkQa.byKind) || null;
    const anchorNameByKind = Object.create(null);
    for (const schema of ANCHOR_SCHEMA) anchorNameByKind[schema.kind] = schema.name || schema.kind;
    // QA notes for the given kinds (only kinds that are missing or flagged for
    // review contribute — a healthy anchor has nothing to explain), deduped.
    const reviewNotesForKinds = (kinds) => {
      if (!qaByKind) return [];
      const notes = [];
      for (const kind of kinds) {
        const q = qaByKind[kind];
        if (!q || (q.present && !q.reviewRequired)) continue;
        for (const note of (q.notes || [])) {
          if (notes.indexOf(note) < 0) notes.push(note);
        }
      }
      return notes;
    };

    // Missing-anchor guard: any row whose POM declares a required anchor that
    // wasn't seeded must NOT ship as a confident drawn line — route it to
    // REVIEW_ONLY so the TD places it deliberately instead of having to spot
    // and delete a bogus centered line (e.g. back POMs on a front-only sketch).
    //
    // The per-POM requiredAnchors list is data, declared in
    // auto_mode_rules/pom-template.json → POM_TEMPLATE[pom].requiredAnchors.
    // Adding or renaming an anchor only requires editing the rules file; this
    // code picks it up automatically.
    for (const row of rows) {
      const tpl = POM_TEMPLATE[String(row.pom)];
      const required = (tpl && Array.isArray(tpl.requiredAnchors)) ? tpl.requiredAnchors : [];
      const missing = required.filter(kind => !a[kind]);
      if (!missing.length) continue;
      row.drawability = 'REVIEW_ONLY';
      row.confidence = 'low';
      row.start = null; row.end = null;
      row.control1 = null; row.control2 = null;
      // Phase 7: name the missing anchors explicitly so the TD (and the
      // contract suite) can audit the demotion without re-running detection.
      row.missingAnchors = missing.slice();
      const missingNames = missing
        .map(kind => anchorNameByKind[kind] || kind)
        .join(', ');
      row.uncertainty = (row.uncertainty ? row.uncertainty + ' ' : '')
        + 'A required anchor was not detected, so this line cannot be auto-placed.'
        + ' Missing: ' + missingNames + '.';
    }

    // P5: a straight row whose endpoints coincide (zero measurable length)
    // can't satisfy its forced horizontal/vertical shape check and would make
    // validateAutoFixture return 'fail', aborting ALL 16 POMs and discarding
    // the 15 good ones. Demote just that degenerate row to REVIEW_ONLY so the
    // rest still ship; the null-geometry pass below then clears its coords.
    for (const row of rows) {
      if (row.drawability === 'REVIEW_ONLY' || row.type === 'curved') continue;
      if (!row.start || !row.end) continue;
      const ddx = Math.abs(row.end.x - row.start.x);
      const ddy = Math.abs(row.end.y - row.start.y);
      if (ddx < 1e-6 && ddy < 1e-6) {
        row.drawability = 'REVIEW_ONLY';
        row.confidence = 'low';
        row.uncertainty = (row.uncertainty ? row.uncertainty + ' ' : '')
          + 'Endpoints coincided (no measurable length), so this line cannot be auto-placed.';
      }
    }

    // P6: a "measure straight" POM forces one axis (horizontal 1/3/15/16,
    // vertical 6/7/8), discarding the off-axis offset between its two source
    // anchors. Usually those anchors already share the axis coordinate so
    // nothing is lost — but when they genuinely don't (a tilted band, offset
    // apexes, a leaning CF seam), the drawn line no longer terminates on the
    // real anchor and the length collapses to the on-axis projection. Flag such
    // a row low-confidence so the TD verifies it, using the SAME 0.25 off/on
    // ratio as validate-fixture's shape check. Keep this anchor mapping in sync
    // with the forced-axis builders above.
    const forcedAxis = [
      { pom: '1', a: 'band-left', b: 'band-right', dir: 'h' },
      { pom: '3', a: 'chest-left', b: 'chest-right', dir: 'h' },
      { pom: '15', a: 'back-strap-left', b: 'back-strap-right', dir: 'h' },
      { pom: '16', a: 'apex-left', b: 'apex-right', dir: 'h' },
      { pom: '6', a: 'cradle-cf-top', b: 'cf-bottom', dir: 'v' },
      { pom: '7', a: 'cradle-cup-top', b: 'cradle-cup-bottom', dir: 'v' },
      { pom: '8', a: 'cf-top', b: 'cradle-cf-top', dir: 'v' },
    ];
    const rowByPom = new Map(rows.map(r => [String(r.pom), r]));
    for (const f of forcedAxis) {
      const row = rowByPom.get(f.pom);
      if (!row || row.drawability === 'REVIEW_ONLY') continue;
      const pa = a[f.a], pb = a[f.b];
      if (!pa || !pb) continue;
      const onAxis = f.dir === 'h' ? Math.abs(pb.x - pa.x) : Math.abs(pb.y - pa.y);
      const offAxis = f.dir === 'h' ? Math.abs(pb.y - pa.y) : Math.abs(pb.x - pa.x);
      if (onAxis > 1e-6 && offAxis > onAxis * 0.25) {
        row.confidence = 'low';
        row.uncertainty = (row.uncertainty ? row.uncertainty + ' ' : '')
          + 'The two endpoints are noticeably ' + (f.dir === 'h' ? 'un-level' : 'out of plumb')
          + ' — drawn as a straight measurement, so verify it reflects the intended span.';
      }
    }

    // Enforce the REVIEW_ONLY ⇒ null-geometry invariant for ANY row that ended
    // up REVIEW_ONLY, not just the requiredAnchors demotions above (e.g. a POM
    // 9/10 whose cupModel was hidden/absent — P3). validate-fixture requires
    // REVIEW_ONLY rows to carry null geometry, and a stale line must never be
    // drawn for a row the TD has to place by hand.
    //
    // Phase 7, item 4: every REVIEW_ONLY row also gets reviewNotes — the
    // landmark QA explanations for its missing anchors (guard demotions) or,
    // for other demotion paths (hidden cup, degenerate geometry), for any of
    // its required anchors that the QA layer flagged. Empty stays absent: an
    // uncertainty line with no QA evidence behind it is still valid.
    for (const row of rows) {
      if (row.drawability !== 'REVIEW_ONLY') continue;
      row.start = null; row.end = null;
      row.control1 = null; row.control2 = null;
      if (!row.uncertainty) {
        row.uncertainty = 'No reliable evidence to auto-place this line; the TD should place it.';
      }
      if (!row.reviewNotes) {
        const tpl = POM_TEMPLATE[String(row.pom)];
        const required = (tpl && Array.isArray(tpl.requiredAnchors)) ? tpl.requiredAnchors : [];
        const kinds = (row.missingAnchors && row.missingAnchors.length)
          ? row.missingAnchors
          : required;
        const notes = reviewNotesForKinds(kinds);
        if (notes.length) row.reviewNotes = notes;
      }
    }

    return {
      name: 'auto-generated-from-anchors',
      templateVersion: AUTO_TEMPLATE_VERSION,
      ruleVersion: AUTO_RULE_VERSION,
      annotations: rows,
    };
  }

  // Keep Auto Mode POM 1/2/3/4 drafts geometrically tied to the band/chest
  // anchors while the TD is dragging. POM 1 follows band-{left,right}; POM 3
  // follows chest-{left,right}; POMs 2 and 4 are dashed extensions that
  // always read as 1/5 the length of their parent. Called from the
  // drag-anchor mouse-move loop; runs only if drafts exist for the
  // affected POMs.
  function syncBandChestDraftsFromAnchors(movedAnchorKind) {
    if (state.appMode !== 'auto') return;
    const drafts = state.autoMode && state.autoMode.draftAnnotations;
    if (!Array.isArray(drafts) || !drafts.length) return;
    const relevant = movedAnchorKind === 'band-left'
      || movedAnchorKind === 'band-right'
      || movedAnchorKind === 'chest-left'
      || movedAnchorKind === 'chest-right';
    if (!relevant) return;

    const anchors = state.autoMode.anchors || [];
    const byKind = Object.create(null);
    for (const a of anchors) byKind[a.kind] = a;
    const bandL = byKind['band-left'];
    const bandR = byKind['band-right'];
    const chestL = byKind['chest-left'];
    const chestR = byKind['chest-right'];

    const det = state.autoMode && state.autoMode.detection;
    const sourceImage = det
      ? (getImageById(det.sourceImageId) || pickAutoSourceImage())
      : pickAutoSourceImage();
    if (!sourceImage || !sourceImage.width) return;

    const toWorld = (p) => worldFromNormalized(p, sourceImage);
    const findDraft = (pom) => drafts.find(d => String(d.seq) === String(pom));

    const updateLine = (draft, startNorm, endNorm) => {
      if (!draft || isReviewOnlyDraft(draft)) return;
      const newStart = toWorld(startNorm);
      const newEnd = toWorld(endNorm);
      if (newStart) draft.start = newStart;
      if (newEnd) draft.end = newEnd;
    };

    if (bandL && bandR) {
      updateLine(findDraft('1'), bandL, bandR);
      const pom1Length = bandR.x - bandL.x;
      const ext2End = { x: clamp01(bandR.x + pom1Length / 5), y: bandR.y };
      updateLine(findDraft('2'), bandR, ext2End);
    }
    if (chestL && chestR) {
      updateLine(findDraft('3'), chestL, chestR);
      const pom3Length = chestR.x - chestL.x;
      const ext4End = { x: clamp01(chestR.x + pom3Length / 5), y: chestR.y };
      updateLine(findDraft('4'), chestR, ext4End);
    }
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
