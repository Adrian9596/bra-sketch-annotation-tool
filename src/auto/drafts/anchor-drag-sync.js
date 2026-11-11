// Auto Mode draft re-sync: keep the POM drafts on the board in step with the
// anchors they were derived from.
// Source part for app.js. Run `npm run build` after editing.
//
// Called from moveAnchorBy (src/auto/anchors/anchor-interaction.js) — the one
// mutation path for every anchor move: drag, keyboard nudge, snap-to-ink — and
// from resetAnchorsToDetection (draft-actions.js), which re-seeds every anchor
// at once.
//
// US-085 shipped a hand-written partial: it re-derived POM 1/2/3/4/16 inline
// and left the other 13 stale, with its own copy of the POM 16 slant limit and
// its own (wrong) idea of POM 1/3's geometry — it wrote the raw band/chest
// anchor into the line instead of the forced-level end the fixture builder
// produces, so the same anchors drew a different line depending on whether the
// TD had just dragged or just pressed Generate. Measured on demo1: dragging
// band-right left POM 7 396% long, POM 6 33%, POM 5 11%, and POM 1 slanted by
// 0.074 — all of it applied to the board with no warning.
//
// So this file no longer re-derives anything. It calls the SAME
// buildPOMFixtureFromAnchors the Generate action calls and copies the result
// onto the existing draft records. One geometry source, so a line can no longer
// disagree with itself; a full rebuild measures 0.05-0.08 ms on the demo
// fixtures, which is nothing per mousemove.
//
// Two things it deliberately does NOT overwrite:
//   - a draft the TD has hand-edited (tdEdited) — their correction outranks a
//     re-derivation, and clobbering it would be a worse bug than the stale line
//     this fixes;
//   - a draft's identity and provenance (id, fixtureId, seq, sourceImageId,
//     autoRunId, template/rule version).
// An approval IS dropped when the geometry under it actually moves: the TD
// approved a line that no longer exists.

  // Rebuild the fixture rows for one image's anchor set, keyed by POM.
  //
  // buildPOMFixtureFromAnchors reads state.autoMode.detection for contours,
  // cupModel and landmark QA, so the inner-view pass has to swap the active
  // detection exactly as generatePOMDraftsFromAnchors does — otherwise the
  // front-outer contours would shape the inner photo's neckline and armhole.
  function draftFixtureRowsByPom(anchorList, detectionForBuild) {
    if (!Array.isArray(anchorList) || !anchorList.length) return null;
    const saved = state.autoMode.detection;
    let fixture = null;
    try {
      if (detectionForBuild) state.autoMode.detection = detectionForBuild;
      fixture = buildPOMFixtureFromAnchors(anchorList);
    } finally {
      state.autoMode.detection = saved;
    }
    if (!fixture || !Array.isArray(fixture.annotations)) return null;
    const byPom = new Map();
    for (const row of fixture.annotations) byPom.set(String(row.pom), row);
    return byPom;
  }

  // Geometry fingerprint used to decide whether a draft really moved. Taken
  // before the rebuild and again after it, so a draft rewritten with the same
  // fixture geometry it already held does not count as moved.
  function draftGeometryKey(draft) {
    const p = (q) => q ? q.x.toFixed(6) + ',' + q.y.toFixed(6) : '-';
    return [draft.drawability, p(draft.start), p(draft.end),
      p(draft.control1), p(draft.control2)].join('|');
  }

  // Copy one rebuilt fixture row onto an existing draft. Mirrors the field
  // derivation in buildDraftAnnotation (build-draft-annotation.js) — a field
  // added there and not here would silently stop tracking its anchors.
  //
  // Writes unconditionally, even when the rebuilt geometry is identical, which
  // keeps the re-sync idempotent. "Did it actually move" is answered later, by
  // comparing geometry keys across the entire pass.
  function applyFixtureRowToDraft(draft, row, image) {
    if (!draft || !row || !image || !image.width) return false;
    const reviewOnly = row.drawability === 'REVIEW_ONLY';
    const curved = !reviewOnly && row.type === 'curved';
    const next = {
      start: reviewOnly ? null : worldFromNormalized(row.start, image),
      end: reviewOnly ? null : worldFromNormalized(row.end, image),
      control1: curved ? worldFromNormalized(row.control1, image) : null,
      control2: curved ? worldFromNormalized(row.control2, image) : null,
    };
    draft.start = next.start;
    draft.end = next.end;
    draft.control1 = next.control1;
    draft.control2 = next.control2;
    draft.type = reviewOnly ? 'straight' : (row.type || 'straight');
    draft.style = reviewOnly ? 'solid' : (row.style || 'solid');
    draft.arrowType = reviewOnly ? 'double' : (row.arrowType || 'double');
    draft.drawability = row.drawability;
    draft.confidence = row.confidence || 'medium';
    draft.desc = row.desc || null;
    draft.reason = row.reason || null;
    draft.uncertainty = row.uncertainty || null;
    draft.viewRole = row.viewRole || effectivePomViewRole(row.pom);
    draft.sharedAnchorFamily = row.sharedAnchorFamily || null;
    draft.proposedStartLandmark = row.proposedStartLandmark || null;
    draft.proposedEndLandmark = row.proposedEndLandmark || null;
    draft.missingAnchors = Array.isArray(row.missingAnchors) && row.missingAnchors.length
      ? row.missingAnchors.slice() : null;
    draft.reviewNotes = Array.isArray(row.reviewNotes) && row.reviewNotes.length
      ? row.reviewNotes.slice() : null;
    // A REVIEW_ONLY row has no line to caption. Otherwise re-derive the callout
    // position unless the TD placed it by hand; the collision pass below then
    // spreads the whole set, exactly as it does after Generate.
    if (reviewOnly) {
      draft.label = null;
    } else if (!draft.labelManual) {
      draft.label = computeDefaultLabelPosition(draft);
    }
    // Approval is NOT decided here — see the end of resyncDraftsFromAnchors,
    // which compares geometry keys once every draft has been rebuilt.
    return true;
  }

  // Re-derive every draft on the board from the current anchor positions.
  //
  // No-op when there are no drafts, which is the ordinary flow: Detect seeds
  // anchors without drafting, and Generate applies immediately and hands off to
  // Manual Mode. Drafts and anchors only coexist in the review / recovery state
  // (a failed apply, or REVIEW_ONLY rows left after returning from Manual) —
  // which is exactly where the stale lines used to ship.
  //
  // Returns the number of drafts whose geometry or tier changed.
  function resyncDraftsFromAnchors() {
    if (state.appMode !== 'auto') return 0;
    const drafts = state.autoMode && state.autoMode.draftAnnotations;
    if (!Array.isArray(drafts) || !drafts.length) return 0;
    const anchors = (state.autoMode && state.autoMode.anchors) || [];
    if (!anchors.length) return 0;

    const det = state.autoMode.detection;
    const sourceImage = det
      ? (getImageById(det.sourceImageId) || pickAutoSourceImage())
      : pickAutoSourceImage();
    if (!sourceImage || !sourceImage.width) return 0;

    // One rebuilt row set per image a draft can live on. The front-outer pass
    // sees only the anchors on the detection source image, the same filter
    // generatePOMDraftsFromAnchors applies (US-049) — without it, anchors
    // relocated onto a separate front-inner photo would drag the front-view
    // POMs with them.
    const rowsByImageId = new Map();
    const frontRows = draftFixtureRowsByPom(
      anchors.filter(an => an.sourceImageId === sourceImage.id), null);
    if (frontRows) rowsByImageId.set(String(sourceImage.id), frontRows);

    // US-049 inner-view pass: POM 9/10/17/18 measure on their own photo, so
    // they are rebuilt against THAT photo's detection and anchor set.
    const innerView = (det && Array.isArray(det.auxViews))
      ? det.auxViews.find(v => v && v.viewRole === 'front_inner'
        && v.detection && Array.isArray(v.anchors) && v.anchors.length)
      : null;
    if (innerView) {
      const innerImage = getImageById(innerView.sourceImageId);
      if (innerImage && innerImage.width) {
        // History replaces the working anchors, so never rely on identity
        // shared with the auxiliary detection's original seeds.
        const innerRows = draftFixtureRowsByPom(
          anchors.filter(an => an.sourceImageId === innerImage.id), innerView.detection);
        if (innerRows) rowsByImageId.set(String(innerImage.id), innerRows);
      }
    }
    if (!rowsByImageId.size) return 0;

    const touched = [];
    const geometryBefore = new Map();
    for (const draft of drafts) {
      if (!draft || !isAutoDraft(draft)) continue;
      // The TD's own correction wins over anything re-derived from anchors.
      if (draft.tdEdited) continue;
      geometryBefore.set(draft, draftGeometryKey(draft));
      const rows = rowsByImageId.get(String(draft.sourceImageId));
      if (!rows) continue;
      const row = rows.get(String(draft.seq));
      if (!row) continue;
      const image = getImageById(draft.sourceImageId);
      if (applyFixtureRowToDraft(draft, row, image)) touched.push(draft);
    }
    if (!touched.length) return 0;

    // Same label de-collision pass Generate runs. Hand-edited drafts stay out
    // of this too, not just out of the rebuild.
    // The pass shifts any label with labelManual === false, and a tdEdited
    // draft's label was never reset to its default here — so where every other
    // callout starts each pass from a fresh default, that one would keep and
    // compound its displacement move after move, drifting away from the line
    // the TD deliberately placed. Excluding it can let a rebuilt callout overlap
    // it, which is cosmetic and already possible; the drift was neither, since
    // Apply copies the label position onto the applied annotation.
    nudgeAutoLabelsToAvoidCollisions(drafts.filter(d => d && !d.tdEdited));

    // Now that every draft has been rebuilt, drop the approval on the drafts
    // whose line actually ended up somewhere else.
    let moved = 0;
    for (const draft of touched) {
      if (geometryBefore.get(draft) === draftGeometryKey(draft)) continue;
      moved += 1;
      if (draft.tdApproved) {
        draft.tdApproved = false;
        draft.tdApprovalRequired = true;
        draft.approvedAt = null;
      }
    }
    return moved;
  }
