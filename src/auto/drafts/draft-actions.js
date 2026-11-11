// TD review actions on a single draft: mark touched, approve, mark
// review-only — plus the toolbar action that resets the anchors from the
// current detection.
// Source part for app.js. Run `npm run build` after editing.
//
// These mutate one draft's tdApproved / drawability fields. The
// atomic commit-to-board pipeline lives in apply-drafts.js, and the
// whole-board discard / reset operations in board-reset.js.

  // -------- TD review actions on drafts --------

  // A draft the TD is expected to review before it counts as their own
  // geometry. Auto Mode POM drafts are the only producer since Auto Detect
  // Seam was removed (ADR 0101), so this is a no-op on anything else and every
  // edit path may call it unconditionally.
  function markDraftTouchedByTD(ann) {
    if (!isAutoDraft(ann)) return;
    ann.tdEdited = true;
    ann.tdApprovalRequired = true;
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
    ann.approvedAt = null;
    if (!ann.uncertainty) ann.uncertainty = 'Marked REVIEW_ONLY by TD.';
  }

  // Toolbar action: throw away every TD anchor correction and re-seed the
  // whole anchor set from the current detection.
  function resetAnchorsToDetection() {
    const detection = state.autoMode.detection;
    if (!detection) {
      showToast('Run Detect Sketch first.');
      return;
    }
    const sourceImage = getImageById(detection.sourceImageId) || pickAutoSourceImage();
    if (!sourceImage) {
      showToast('No source image for the current detection.');
      return;
    }
    seedAndRelocateAnchors(detection, sourceImage);
    state.autoMode.anchorSelectedId = null;
    state.autoMode.anchorsHidden = false;
    state.autoMode.hiddenAnchorKinds = []; // US-038: fresh seed shows all
    // This moves EVERY anchor at once, so any drafts under review would be left
    // pointing at the pre-reset positions — the whole board detached, not just
    // the one POM a drag touches. moveAnchorBy re-syncs on the drag path; this
    // action bypassed it entirely.
    resyncDraftsFromAnchors();
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Anchors reset from detection.');
  }
