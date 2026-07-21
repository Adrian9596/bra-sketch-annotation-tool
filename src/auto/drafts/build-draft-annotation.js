// Convert a fixture row into a draft annotation in world coordinates.
// Source part for app.js. Run `npm run build` after editing.
//
// buildDraftAnnotation is the single funnel from normalized-image-space
// fixture rows to world-space annotation records. The draft layer is
// kept apart from state.annotations until applyApprovedDraftsAtomically
// promotes approved drafts.

  function getSelectedDraft() {
    return state.selection.kind === 'draft'
      ? state.autoMode.draftAnnotations.find(a => a.id === state.selection.id) || null
      : null;
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
      // Phase 7 review-note plumbing: which required anchors were missing and
      // the landmark-QA explanations behind a REVIEW_ONLY demotion.
      missingAnchors: Array.isArray(row.missingAnchors) && row.missingAnchors.length
        ? row.missingAnchors.slice()
        : null,
      reviewNotes: Array.isArray(row.reviewNotes) && row.reviewNotes.length
        ? row.reviewNotes.slice()
        : null,
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
