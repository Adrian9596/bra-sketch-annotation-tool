// Auto Mode entry/exit: mode switching, Auto Mode status chip, source
// image selection. Source part for app.js. Run `npm run build`
// after editing.
//
// requestAppModeChange guards the manual ← auto transition with an
// 'apply / discard / stay' dialog when there are unapplied drafts —
// canLeaveAutoMode is the single predicate that decides if a clean exit
// is possible. pickAutoSourceImage prefers the selected image, falling
// back to the first one on the board.

  // =============================================================
  // Auto Mode — offline sketch detection + anchor-driven POM drafting.
  // Drafts live entirely outside state.annotations until an
  // explicit, atomic Apply moves approved rows into the project.
  // =============================================================

  function setAppMode(mode) {
    // mode is 'auto' or 'manual'. Auto is the default on fresh load; Manual
    // is entered via the toolbar toggle, the post-Apply handoff, or by
    // reopening a saved project that contains applied lines.
    state.appMode = mode;
    document.body.classList.toggle('app-auto', mode === 'auto');
    el.modeManualBtn.classList.toggle('active', mode === 'manual');
    el.modeAutoBtn.classList.toggle('active', mode === 'auto');
    // visibility handled by body.app-auto CSS class

    if (mode === 'auto') {
      // Force the user out of any creation-flavored tool so manual line
      // creation cannot fire while project annotations are locked. Route
      // through setTool — not a raw state.tool assignment — so an armed
      // Template's activeStampId (and any drawSession/eraseSession) is
      // cleared the same way Escape or picking another tool clears it;
      // a raw assignment here would leave activeStampId stale. setTool does
      // NOT touch state.interaction (it is a per-gesture record, not tool
      // state), so a Template placement drag caught mid-gesture — the
      // gesture is state.interaction.type === 'draw-stamp', not drawSession —
      // needs its own explicit clear here, same as sketch-mode.js's own
      // toggle-off cleanup does.
      setTool('select');
      state.interaction = null;
      // US-102: Sketch Focus is Manual-only and must never leak into Auto —
      // its toggle control is itself manual-only (invisible here), so the
      // body class, the button sync, and every focus-only effect (hidden
      // More menu, hidden POM numbers) would otherwise silently survive the
      // switch with no way for the TD to see or undo it from this mode.
      // applySketchModeVisual is the single state+body-class+button-sync
      // path the toolbar button itself uses (src/manual/sketch-mode.js).
      applySketchModeVisual(false);
      // US-105: Pattern Measure is Manual + Sketch Focus only — a measure
      // session (and every overlay it holds) must not survive a switch back
      // to Auto Mode.
      resetDxfMeasureSession();
      // Clear any project selection so the user does not accidentally edit
      // locked annotations. US-092 adds 'note': notes are Manual-only to edit,
      // and a selection carried into Auto would keep painting its outline over
      // a board where nothing can act on it. Any open note editor closes with
      // its text committed — losing what the TD typed because they clicked the
      // mode toggle would be the worse of the two answers.
      if (state.selection.kind === 'annotation' || state.selection.kind === 'image'
          || state.selection.kind === 'note') {
        state.selection = { kind: null, id: null };
      }
      commitNoteEditor();
      ensureAutoModeStatus();
    } else {
      // Leaving Auto Mode: clear draft selection + drop detection /
      // anchors so nothing leaks into Manual rendering.
      if (state.selection.kind === 'draft') {
        state.selection = { kind: null, id: null };
      }
      state.autoMode.detection = null;
      state.autoMode.anchors = [];
      state.autoMode.anchorSelectedId = null;
    }
    updateUI();
    // Showing/hiding the Auto toolbar changes the canvas' page position and
    // available height. Recompute immediately so subsequent clicks map to the
    // correct world coordinates.
    resizeCanvas();
  }

  function requestAppModeChange(mode) {
    if (mode === state.appMode) return;
    if (mode === 'manual' && !canLeaveAutoMode()) {
      // Leaving Auto Mode with unapplied drafts: the draft layer would be
      // stranded, so ask the TD to apply, discard, or stay first.
      const drafts = state.autoMode.draftAnnotations;
      const approvedCount = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
      openAutoModeExitDialog({
        approvedCount,
        totalCount: drafts.length,
      }).then(choice => {
        if (choice === 'apply') {
          // A successful apply hands off to Manual Mode by itself (see
          // applyApprovedDraftsAtomically); on failure we stay in Auto with
          // the drafts intact. Unapplied rows (e.g. REVIEW_ONLY) stay in
          // the Auto draft layer — toggling back to Auto shows them again.
          applyApprovedDraftsAtomically();
        } else if (choice === 'discard') {
          discardAutoDrafts(true);
          setAppMode('manual');
        }
        // 'stay' = no-op: user keeps Auto Mode and their drafts.
      });
      return;
    }
    setAppMode(mode);
  }

  function canLeaveAutoMode() {
    return state.autoMode.draftAnnotations.length === 0;
  }

  function ensureAutoModeStatus() {
    // Status priority:
    //   reviewing > detected > ready > idle
    // Drafts win because they need the most attention. Detection (with
    // anchors seeded) is next so the chip reflects "you can generate now".
    if (state.autoMode.draftAnnotations.length > 0) {
      state.autoMode.status = 'reviewing';
      return;
    }
    if (state.autoMode.detection) {
      state.autoMode.status = 'detected';
      return;
    }
    state.autoMode.status = pickAutoSourceImage() ? 'ready' : 'idle';
  }

  function pickAutoSourceImage() {
    const ready = state.images.filter(
      (im) => im && im.img && im.img.complete && (im.img.naturalWidth || im.img.width) > 0
    );
    // Single (or no) photo: the selected one, else the first. Unchanged — this
    // is the common case and every headless test loads exactly one image.
    if (ready.length <= 1) {
      return getSelectedImage() || ready[0] || state.images[0] || null;
    }
    // Multiple photos on the board: the PRIMARY must be the front + back OUTER
    // view — the photo with two garment panels side by side — while a separate
    // front-inner cutaway is a single panel (TD rule: the 2-view photo is
    // front+back, the other is front inner). Picking the selected image is
    // wrong here because pasting/adding a photo auto-selects it, so loading the
    // inner second would make IT primary and swap the roles. A 2-panel board is
    // markedly wider relative to its height (aspect ~2) than a 1-panel cutaway
    // (aspect ~1), so pick the widest-by-aspect photo as primary; the rest
    // become auxiliary front-inner views regardless of load order / selection.
    const aspect = (im) => (im.img.naturalWidth || im.img.width) / Math.max(1, im.img.naturalHeight || im.img.height);
    return ready.slice().sort((a, b) => aspect(b) - aspect(a))[0];
  }
