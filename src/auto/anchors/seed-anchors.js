// Seed anchors from a detection result: walk the ANCHOR_SCHEMA and
// place each anchor in its normalized [0, 1] position on the source
// image. Source part for app.js. Run `npm run build` after editing.
//
// Anchors live between detection and POM generation: Detect Sketch seeds
// them, the TD drags any wrong ones, the POM generator reads them. The
// schema-driven layout means a new anchor name does not require new
// seeding code, only a row in auto_mode_rules/anchor-schema.json.
//
// seedAnchorsFromDetection is the orchestrator: it composes the per-concern
// seeding stages — seed-view-resolution.js (views + fallback landmark rows +
// the baseline seed set), seed-cradle-cf.js (POM 6/8 CF cradle geometry),
// seed-cup-width.js (POM 9/10 cup geometry, used by the front branch),
// seed-front-view.js and seed-back-view.js — and then runs the cup-anchor QA
// gate, the anchor-record assembly, and the learning-bias hook that live here.

  // -------- Anchor layer (Phase 2 of the offline engine) --------
  //
  // Anchors live between detection and POM generation. Detect Sketch seeds
  // them with rough positions; the TD drags any wrong ones; the POM
  // generator then reads anchor positions to lay down 18 draft lines.
  // Anchors x/y are normalized [0, 1] in the source image's pixel space, so
  // they travel with the image (pan / zoom / resize / save).

  function seedAnchorsFromDetection(detection, sourceImage, options) {
    if (!detection || !detection.bbox || !sourceImage) return [];

    const seedCtx = resolveSeedViewContext(detection);
    const roleByKind = seedCtx.roleByKind;

    const cradleCfSeed = resolveCradleCfSeed(detection, seedCtx);

    // Landmark QA layer (Engineering Workflow Phase 6): the per-landmark
    // verdicts — source class, confidence tier, reviewRequired, QA notes —
    // that this seed layer consumes below instead of recomputing its own
    // tables. Computed HERE (not reused from detection time) because the
    // detection object can be mutated between seedings (e.g. the front_inner
    // branch backfills detection.innerCupTop), and it must run BEFORE that
    // mutation so its evidence reads match this seeding pass — and AFTER the
    // crest-tier decision above, which it classifies via
    // detection.cradleCfCrestSeedY. Re-attached so debug consumers always see
    // the verdicts the current anchors came from.
    const landmarkQa = buildLandmarkQaFromDetection(detection);
    if (landmarkQa) detection.landmarkQa = landmarkQa;
    const qaByKind = (landmarkQa && landmarkQa.byKind) || {};

    let seeds = buildBaselineAnchorSeeds(detection, seedCtx, cradleCfSeed);

    seeds = seedFrontViewAnchors(detection, seeds, seedCtx);
    seeds = seedFrontInnerViewAnchors(detection, seeds, seedCtx);

    // Demote POM 9 / POM 10 to REVIEW_ONLY when no coherent cup model could
    // be built. The requiredAnchors guard in auto-drafts.js promotes a row to
    // REVIEW_ONLY when ANY required anchor is missing from the seed list, so
    // we remove the inner-cup-* seeds entirely in the "hidden + no fallback"
    // case (per rule.md "If REVIEW_ONLY, do not fabricate start/end from
    // fixed ratios"). When the front_inner view fires the seeds above are
    // direct evidence (not ratio fabrication) and we keep them. When the
    // legacy innerCupTopInk fires we keep them too — that's a heuristic but
    // it carries some structure information, and the existing flow has shown
    // it usable on a number of sketches.
    // Anchor-gate diagnostic — which source path POM 9/10 ended up using.
    // Computed by the landmark QA layer (single source of truth for the gate
    // predicate); surfaced via detection.debug.cupAnchorGate so debug
    // consumers (rule.md 'why was this row demoted?' question) can see the
    // gate decision without re-running detection.
    const cupAnchorGate = landmarkQa ? landmarkQa.cupGate : null;
    const anchorGateWillDelete = !!(cupAnchorGate && cupAnchorGate.willDelete);
    if (detection && detection.debug && typeof detection.debug === 'object') {
      detection.debug.cupAnchorGate = cupAnchorGate;
    }
    if (anchorGateWillDelete) {
      delete seeds['inner-cup-top'];
      delete seeds['inner-cup-bottom'];
      delete seeds['inner-cup-left'];
      delete seeds['inner-cup-right'];
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Auto Mode] inner-cup-* anchors deleted → POM 9/10 demoted', cupAnchorGate);
      }
    }

    seeds = seedBackViewAnchors(detection, seeds, seedCtx);

    // Anchor confidence, provenance, and reviewRequired come from the landmark
    // QA layer (Engineering Workflow Phase 6 — see buildLandmarkQaFromDetection
    // in src/auto/detect/landmark-qa.js, where the tier / provenance / review
    // predicates live with their full rationale). The seed layer places
    // coordinates; the QA layer says how much to trust each landmark and why.
    // The verdicts are the exact tables that used to live here, so anchors,
    // drafts, and golden output are unchanged.
    const cupId = (detection.cupModel && detection.cupModel.id) || null;

    const list = [];
    for (const schema of ANCHOR_SCHEMA) {
      const seed = seeds[schema.kind];
      if (!seed) continue;
      const qaEntry = qaByKind[schema.kind] || null;
      const source = qaEntry && qaEntry.source ? qaEntry.source : 'unknown';
      const confTier = qaEntry ? qaEntry.confidence : 'medium';
      // reviewRequired is the QA layer's weak-landmark verdict: ratio-only or
      // projected seeds, 'low' tiers, genuinely-inferred weak cup anchors, and
      // non-'high' anchors on a weak geometry frame. The drafter still
      // respects requiredAnchors for hard-gating; this flag lets the spec
      // panel (and contract tests) mark a drawn line as needing a second look
      // without forcing REVIEW_ONLY.
      const reviewRequired = qaEntry ? !!qaEntry.reviewRequired : false;
      const record = {
        id: createUniqueAnnotationId(),
        kind: schema.kind,
        name: schema.name,
        group: schema.group,
        x: seed.x,
        y: seed.y,
        sourceImageId: sourceImage.id,
        viewRole: roleByKind[schema.kind] || defaultViewRoleForAnchorKind(schema.kind),
        confidence: confTier,
        autoFilled: true,
        source,
        reviewRequired,
      };
      // Phase 6 provenance carried onto the anchor record: the landmark
      // source class (detected / derived / projected — 'learned' is applied
      // below when the learning loop moves the seed) and the QA notes that
      // explain any weakness in TD language.
      if (qaEntry) {
        record.landmarkSourceClass = qaEntry.sourceClass;
        if (Array.isArray(qaEntry.notes) && qaEntry.notes.length) {
          record.qaNotes = qaEntry.notes.slice();
        }
      }
      // Attach the shared cupModel id to inner-cup-* anchors so contract
      // tests can prove POM 9 and POM 10 read from the SAME cup model.
      if (cupId && schema.kind.indexOf('inner-cup-') === 0) {
        record.cupModelId = cupId;
      }
      list.push(record);
    }
    // Learning-loop hook: when enabled, nudge each seeded anchor by the
    // median (detected → corrected) residual recorded from past TD drags.
    // No-op when learning is off or a bucket has fewer than the minimum
    // samples. The geometric rules above are not changed.
    //
    // Phase 2 shadow runs pass { skipLearning: true } so the residual is
    // computed against the unbiased prediction, never against an already-
    // biased one (which would compound the error and make the median drift).
    if (options && options.skipLearning) return captureDerivedOffsets(list);
    const biased = applyLearningBiasToAnchors(list);
    // Phase 6: an anchor the learning loop actually moved is 'learned' — the
    // seed position is no longer purely the detector's landmark. The fine
    // `source` provenance is untouched (it still says which detector path
    // produced the seed); only the source CLASS is re-tagged.
    for (const anchor of biased) {
      if (anchor && anchor.calibrated && anchor.landmarkSourceClass) {
        anchor.landmarkSourceClass = 'learned';
        anchor.qaNotes = (anchor.qaNotes || []).concat(
          'learned: seed nudged by the median residual of past TD corrections.'
        );
      }
    }
    // Record the hem gap each drop_to_line dependent was seeded with, while the
    // anchors still hold exactly what detection placed. deriveAnchors replays it
    // so a band nudge moves cf-bottom / cradle-cup-bottom WITH the band instead
    // of flattening them onto its chord and discarding US-061's hem following.
    return captureDerivedOffsets(biased);
  }

  function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

  function findDetectionViewByRole(detection, role) {
    const views = Array.isArray(detection && detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection && detection.viewBoxes) ? detection.viewBoxes : []);
    return views.find(v => v && (v.viewRole === role || v.role === role)) || null;
  }

  function defaultViewRoleForAnchorKind(kind) {
    if (/^back-|^back$/.test(kind)) return 'back';
    if (kind === 'side-top' || kind === 'side-bottom') return 'back';
    if (kind === 'strap-bottom') return 'back';
    if (kind === 'strap-top') return 'front_outer';
    if (kind.indexOf('inner-cup-') === 0) return 'front_outer';
    return 'front_outer';
  }
