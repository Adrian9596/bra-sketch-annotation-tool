// Auto Mode atomic apply-to-board pipeline: commit the approved draft set as
// real annotations, plus the duplicate / geometry-conflict recovery dialog and
// the draft -> permanent annotation record builder.
// Source part for app.js. Run `npm run build` after editing.
//
// applyApprovedDraftsAtomically is the only path that mutates
// state.annotations during Auto Mode. It refuses to apply a partial
// approved set (atomic = all-or-nothing) so the audit trail stays clean.
//
// buildAppliedAnnotation is the mirror image of buildDraftAnnotation in
// build-draft-annotation.js — a new Auto Mode metadata field must be added to
// both or it silently vanishes on Apply. The single-draft TD state
// transitions that lead here live in draft-actions.js; the whole-board
// discard/reset counterparts live in board-reset.js.

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
    recordAutoTelemetryEvent('apply_started', {
      sourceImageId: approved[0] && approved[0].sourceImageId,
      approved_count: approved.length,
    });
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
        duplicates.push({ pomLabel, sourceImageId: draft.sourceImageId || '', key });
        continue;
      }
      usedPomKeys.add(key);
    }

    // Duplicate-only conflict path: collapse the 18 repeated messages into a
    // single line, and offer to clear the existing auto-applied rows so the
    // user can recover instead of hitting Discard Drafts and starting over.
    if (duplicates.length && !geometryErrors.length) {
      // Replace ONLY the existing auto-applied rows that a new approved draft
      // actually duplicates (same POM key), NOT every auto line on the image.
      // Removing all of them and re-applying only the currently-approved drafts
      // silently dropped previously-applied POMs the TD didn't re-approve this
      // round (P1). Keying on the exact duplicate keys makes this a true 1:1
      // replace, so the dialog count equals what is removed.
      const collidingKeys = new Set(duplicates.map(d => d.key));
      const collidingExisting = existingAutoApplied.filter(a =>
        collidingKeys.has(pomKeyOf(a)));
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
    const sameImageAutoLines = state.annotations.filter(a =>
      isAutoDraft(a) && applied.some(next => next.sourceImageId === a.sourceImageId));
    nudgeAutoLabelsToAvoidCollisions(sameImageAutoLines.concat(applied));

    // Commit.
    for (const ann of applied) {
      state.annotations.push(ann);
      recordAutoTelemetryEvent('draft_applied', {
        sourceImageId: ann.sourceImageId,
        draft_id: ann.originDraftId,
        pom_id: ann.seq != null ? String(ann.seq) : (ann.text != null ? String(ann.text) : null),
      });
    }
    recordAutoAcceptanceStats(applied);
    // Remove the applied drafts from the draft layer (matched by id).
    const appliedDraftIds = new Set(approved.map(d => d.id));
    state.autoMode.draftAnnotations = drafts.filter(d => !appliedDraftIds.has(d.id));
    // Drop stale hide-toggles for drafts that no longer exist. New committed
    // annotations use fresh ids (see idCounter) so nothing carries over —
    // applied POM lines start visible by default.
    if (Array.isArray(state.hiddenDraftIds) && state.hiddenDraftIds.length > 0) {
      state.hiddenDraftIds = state.hiddenDraftIds.filter(id => !appliedDraftIds.has(id));
    }

    // Adjust selection if it pointed at one of the applied drafts.
    if (state.selection.kind === 'draft' && appliedDraftIds.has(state.selection.id)) {
      state.selection = { kind: null, id: null };
    }

    state.nextSequence = Math.max(
      state.nextSequence,
      state.annotations.reduce((m, a) => Math.max(m, (a.seq || 0) + 1), state.nextSequence),
    );

    state.autoMode.status = state.autoMode.draftAnnotations.length > 0 ? 'reviewing' : 'ready';
    // Lines are committed — hide the anchor pins so the applied POM lines
    // are readable. Detect / Reset Anchors show them again.
    state.autoMode.anchorsHidden = true;
    state.autoMode.anchorSelectedId = null;
    state.autoMode.lastError = null;
    recordAutoTelemetryEvent('apply_finished', {
      sourceImageId: applied[0] && applied[0].sourceImageId,
      count: applied.length,
      status: 'ok',
    });
    recordAutoTelemetryEvent('auto_session_done', {
      sourceImageId: applied[0] && applied[0].sourceImageId,
      count: applied.length,
      status: 'applied',
    });

    pushHistoryIfChanged();
    // Handoff: Apply means "review is done" — switch straight to Manual
    // Mode so the TD can edit the applied lines immediately. Any rows left
    // in the draft layer (REVIEW_ONLY audit rows, unapproved drafts) stay
    // there untouched; the Auto toggle brings them back into view.
    setAppMode('manual');
    updateUI();
    requestRender();
    showToast(`Applied ${applied.length} approved line${applied.length === 1 ? '' : 's'}.`);
    return true;
  }

  function buildAppliedAnnotation(draft) {
    const ann = {
      id: createUniqueAnnotationId(),
      seq: draft.seq,
      type: draft.type,
      style: draft.style,
      color: draft.color,
      arrowType: draft.arrowType,
      lineWidth: normalizeLineWidth(draft.lineWidth),
      start: clonePoint(draft.start),
      end: clonePoint(draft.end),
      midPoint: draft.midPoint ? clonePoint(draft.midPoint) : null,
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
      acceptedWithoutEdit: !draft.tdEdited,
      acceptedTrackedAt: new Date().toISOString(),
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
    ensureCurveControls(ann);
    return ann;
  }

  function isFinitePoint(p) {
    return !!(p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }
