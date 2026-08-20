// Auto Mode live anchor-drag sync: keep the POM 1/2/3/4/16 draft lines in
// step with their anchors while the TD drags a pin.
// Source part for app.js. Run `npm run build` after editing.
//
// Called from the drag-anchor mouse-move loop in
// src/auto/anchors/anchor-interaction.js. This is the live counterpart to the
// full fixture rebuild in pom-fixture-builder.js; the POM 16 slant limit below
// is a hand-kept duplicate of that file's APEX_MAX_SLANT (see the comment at
// its use site).

  // Keep Auto Mode POM 1/2/3/4/16 drafts geometrically tied to their anchors
  // while the TD is dragging. POM 1 follows band-{left,right}; POM 3 follows
  // chest-{left,right}; POMs 2 and 4 are dashed extensions that always read
  // as 1/5 the length of their parent; POM 16 follows apex-{left,right}
  // (US-085 — without this, correcting a mis-detected apex anchor by hand
  // left POM 16's line drawn at the old, pre-drag position, the same
  // "anchors right, line wrong" symptom ADR 0049 fixed for band/chest, but
  // for a manual correction instead of a seeding fallback). Called from the
  // drag-anchor mouse-move loop; runs only if drafts exist for the affected
  // POMs. Other POMs' drafts still don't live-sync — a TD must re-generate
  // after moving those anchors.
  function syncBandChestDraftsFromAnchors(movedAnchorKind) {
    if (state.appMode !== 'auto') return;
    const drafts = state.autoMode && state.autoMode.draftAnnotations;
    if (!Array.isArray(drafts) || !drafts.length) return;
    const relevant = movedAnchorKind === 'band-left'
      || movedAnchorKind === 'band-right'
      || movedAnchorKind === 'chest-left'
      || movedAnchorKind === 'chest-right'
      || movedAnchorKind === 'apex-left'
      || movedAnchorKind === 'apex-right';
    if (!relevant) return;

    const anchors = state.autoMode.anchors || [];
    const byKind = Object.create(null);
    for (const a of anchors) byKind[a.kind] = a;
    const bandL = byKind['band-left'];
    const bandR = byKind['band-right'];
    const chestL = byKind['chest-left'];
    const chestR = byKind['chest-right'];
    const apexL = byKind['apex-left'];
    const apexR = byKind['apex-right'];

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
    if (apexL && apexR) {
      const draft16 = findDraft('16');
      // POM 16 doesn't use the plain updateLine helper above: unlike
      // band/chest it is NOT forced level onto one anchor (ADR 0049 /
      // US-084 — the apex pair is legitimately allowed to sit at different
      // heights), so the line's own credibility can change as the TD drags
      // an anchor, and drawability must flip between DRAWABLE and
      // REVIEW_ONLY live rather than staying frozen. updateLine's "never
      // touch a REVIEW_ONLY draft" rule would defeat exactly the case this
      // exists for: un-REVIEW-ONLY-ing POM 16 IS the point of the TD's fix.
      if (draft16) {
        // Keep this in lockstep with APEX_MAX_SLANT in
        // buildPOMFixtureFromAnchors (this file) and APEX_SLANT_LIMIT in
        // src/auto-detection.js — contract E4 guards all three from
        // drifting apart.
        const APEX_MAX_SLANT = 0.06;
        const apexSpanX = Math.abs(apexR.x - apexL.x);
        const apexDy = Math.abs(apexR.y - apexL.y);
        const apexSlant = apexSpanX > 0 ? apexDy / apexSpanX : Infinity;
        if (apexSlant <= APEX_MAX_SLANT) {
          const apexMidY = (apexL.y + apexR.y) / 2;
          const newStart = toWorld({ x: apexL.x, y: apexMidY });
          const newEnd = toWorld({ x: apexR.x, y: apexMidY });
          if (newStart) draft16.start = newStart;
          if (newEnd) draft16.end = newEnd;
          draft16.drawability = 'DRAWABLE';
          draft16.confidence = 'medium';
          draft16.uncertainty = null;
        } else {
          // validate-fixture.js requires REVIEW_ONLY rows to carry null
          // geometry ("must have null geometry") — leaving the pre-drag
          // start/end in place would both violate that and silently draw a
          // stale line under a "review only" label instead of no line.
          draft16.start = null;
          draft16.end = null;
          draft16.drawability = 'REVIEW_ONLY';
          draft16.confidence = 'low';
          draft16.uncertainty = 'The two apex joins were detected ' + apexDy.toFixed(3)
            + ' apart vertically over a ' + apexSpanX.toFixed(3) + ' span (slant '
            + apexSlant.toFixed(3) + ', limit ' + APEX_MAX_SLANT
            + ') — too steep for an apex-to-apex measurement, so one side is very'
            + ' likely mis-detected. Place the apex anchors and re-generate.';
        }
      }
    }
  }
