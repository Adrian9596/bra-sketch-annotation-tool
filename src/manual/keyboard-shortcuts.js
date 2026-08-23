// Manual-mode keyboard shortcut router. Source part for app.js.
// Run `npm run build` after editing.
//
// onKeyDown is the flat if-chain for every board shortcut (undo/redo,
// save/open, arrow nudges, tool picks, board clears, exports, Escape); it
// calls into selection.js, canvas-tools.js, line-nudge.js and the auto/
// render/ clusters. onKeyUp only releases the space-pan modifier.

  function onKeyDown(e) {
    const target = e.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);


    // A modal (Help, Set Scale, PPTX picker) is open — let it own the keyboard.
    if (document.querySelector('.picker-overlay')) {
      return;
    }
    const isMeta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    // US-094: stable direct shortcuts are declared in command-registry.js.
    // That same metadata feeds the Command Palette, Help, and button hints.
    // Complex gestures (nudge, point cycling, pan, brush stepping, Escape)
    // remain below because they are continuous interactions, not commands.
    if (dispatchAppCommandShortcut(e, inField)) return;

    // Undo / redo work everywhere, INCLUDING while a spec-panel field
    // (Size L / TOL / 中文 / description) is focused. Blur first so any
    // pending edit commits to history, then it is undone as a single step.
    if (isMeta && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      flushLineNudgeSession();
      void undo();
      return;
    }
    if (isMeta && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      flushLineNudgeSession();
      void redo();
      return;
    }

    // Save / Open the project (⌘/Ctrl+S, ⌘/Ctrl+O) — mirror the toolbar
    // buttons; work in both modes and from a focused field (commit it first).
    // preventDefault suppresses the browser's Save-page / Open-file dialogs.
    if (isMeta && key === 's') {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      el.saveProjectBtn.click();
      return;
    }
    if (isMeta && key === 'o') {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      el.openProjectBtn.click();
      return;
    }

    // Everything below is a canvas-level shortcut — ignore while typing.
    if (inField) return;

    // Board letters never act on hidden Board state while a tech-pack sheet
    // owns the screen. Global and page-navigation chords already ran through
    // the registry above; each non-Board page owns its own local key handling.
    if (state.activePage !== 'board') return;

    // U1: arrow keys nudge the selected Auto-Mode anchor by one source-image
    // pixel (Shift = 10) — the precise landing tool after a rough drag.
    // Handled before the letter shortcuts so a selected pin owns the arrows;
    // with no pin selected they fall through untouched.
    if (!isMeta && state.appMode === 'auto' && state.autoMode.anchorSelectedId != null
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = e.shiftKey ? 10 : 1;
      const dxPx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dyPx = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudgeSelectedAnchor(dxPx, dyPx)) {
        e.preventDefault();
        return;
      }
    }

    // US-027: in Manual Mode the arrows nudge the selected line — or just its
    // active point (Tab cycles it) — by one source-image pixel (Shift = 10).
    // Moving an endpoint is how a TD changes the measured value precisely.
    if (!isMeta && state.appMode !== 'auto' && state.selection.kind === 'annotation'
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = e.shiftKey ? 10 : 1;
      const dxPx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dyPx = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudgeSelectedAnnotation(dxPx, dyPx)) {
        e.preventDefault();
        return;
      }
    }

    // US-027: Tab picks which point the arrows move — whole line → start →
    // (mid point on curves) → end. Shift+Tab cycles backwards. Only fires
    // with a line selected, so field-to-field tabbing keeps working.
    if (!isMeta && e.key === 'Tab' && state.appMode !== 'auto' && state.selection.kind === 'annotation') {
      const ann = getSelectedAnnotation();
      if (ann) {
        e.preventDefault();
        cycleNudgePart(ann, e.shiftKey ? -1 : 1);
        return;
      }
    }

    // Auto-Mode step shortcuts mirror the "1 Detect · 2 Generate · 3 Review"
    // flow chips: 1 = Detect, 2 = Generate Drafts, 3 = Apply Lines. Clicking the
    // button (rather than calling the handler) respects its disabled + hidden
    // (recovery-only) state, so a step can't fire before it's available.
    if (!isMeta && state.appMode === 'auto' && (key === '1' || key === '2' || key === '3')) {
      const btn = key === '1' ? el.autoDetectBtn : key === '2' ? el.autoGenerateBtn : el.autoApplyBtn;
      if (btn && !btn.disabled && btn.offsetParent !== null) {
        e.preventDefault();
        btn.click();
        return;
      }
    }

    if (e.code === 'Space' && !state.spacePan) {
      state.spacePan = true;
      document.body.classList.add('space-pan');
      e.preventDefault();
    }

    // Cmd/Ctrl+A — select all photos (drag moves them with their lines), or
    // all lines when a line is already selected. Fields keep native
    // select-all via the inField return above.
    if (isMeta && key === 'a') {
      e.preventDefault();
      selectAllOnBoard();
      return;
    }

    // Cmd/Ctrl+Shift+C — copy the whole board as a PNG image. Checked
    // before the plain Cmd/Ctrl+C copy-line branch so the Shift chord never
    // falls through to it. Manual-only, matching the Copy Image button.
    if (isMeta && e.shiftKey && key === 'c' && state.appMode !== 'auto') {
      e.preventDefault();
      void copyBoardImageToClipboard();
      return;
    }

    // Copy for the selected line. Cmd/Ctrl-V is NOT intercepted here: the
    // native paste event (onPasteEvent) decides between an OS-clipboard
    // image and the internal line clipboard, so copying a photo after
    // copying lines still pastes the photo.
    if (isMeta && key === 'c' && state.selection.kind === 'annotation' && state.appMode !== 'auto') {
      e.preventDefault();
      copySelectedAnnotation();
      return;
    }
    if (!isMeta && key === 'm' && state.selection.kind === 'annotation' && state.appMode !== 'auto') {
      e.preventDefault();
      reflectSelectedAnnotation();
      return;
    }

    if ((isMeta && key === '0') || (!isMeta && key === 'f')) {
      e.preventDefault();
      fitSelectionOrAll();
      return;
    }

    if (!isMeta && key === 's') {
      e.preventDefault();
      setTool('select');
      return;
    }

    // H shows/hides the Measurements side panel (same as the toolbar button).
    if (!isMeta && key === 'h') {
      e.preventDefault();
      toggleSpecPanel();
      return;
    }

    // A opens the Add Image file picker (same as the toolbar button).
    if (!isMeta && key === 'a') {
      e.preventDefault();
      el.imageFileInput.click();
      return;
    }

    // G opens the Grading dialog (same as the toolbar button).
    if (!isMeta && key === 'g') {
      e.preventDefault();
      openGradingDialog();
      return;
    }

    // L locks/unlocks every photo at once — works in both modes since
    // locking is purely an image-state concern.
    if (!isMeta && key === 'l') {
      e.preventDefault();
      toggleAllImagesLock();
      return;
    }

    // Board-level clears — both work in Auto Mode (this is an auto-only
    // build) and are one history step, so Undo restores what they remove.
    //   R — reset the whole working board (photo + lines + drafts). Same as
    //       the Reset Board button; it keeps its own confirm dialog.
    //   D — delete every POM line (applied + drafts) but keep the photo, so
    //       the TD can re-Generate on the same sketch.
    if (!isMeta && key === 'r') {
      e.preventDefault();
      resetWorkingBoard();
      return;
    }
    if (!isMeta && key === 'd') {
      e.preventDefault();
      clearAllLinesKeepImage();
      return;
    }

    // In Auto Mode, manual creation/eraser shortcuts must not steal the
    // tool away from select. The project annotations are locked.
    if (state.appMode !== 'auto') {
      if (!isMeta && key === '0') {
        e.preventDefault();
        setTool('straight');
        return;
      }

      if (!isMeta && (key === 'b' || key === 'c')) {
        e.preventDefault();
        setTool('curved');
        return;
      }

      // Eraser moved E → X (TD request 2026-07-10: E now exports Excel).
      if (!isMeta && key === 'x' && state.images.length > 0) {
        e.preventDefault();
        setTool('eraser');
        return;
      }

      // US-092: T = Text note. No image requirement, unlike the eraser — a
      // note may be a title or a general remark on an empty board.
      if (!isMeta && key === 't') {
        e.preventDefault();
        setTool('text');
        return;
      }
    }

    // E exports the Excel measurement spec (same as the toolbar button;
    // opens the size picker first). Manual-only, matching the button's
    // manual-only class and the Cmd/Ctrl+Shift+C copy-image precedent.
    if (!isMeta && key === 'e' && state.appMode !== 'auto') {
      e.preventDefault();
      void exportSpecXlsx();
      return;
    }

    // P exports the PDF, I imports a PPTX — mirror the manual-only toolbar
    // buttons (parity with E = Export Excel). Click the button so behavior
    // (dialogs, disabled state) matches exactly.
    if (!isMeta && key === 'p' && state.appMode !== 'auto') {
      e.preventDefault();
      el.exportPdfBtn.click();
      return;
    }
    if (!isMeta && key === 'i' && state.appMode !== 'auto') {
      e.preventDefault();
      el.importPptxBtn.click();
      return;
    }

    if (!isMeta && key === 'n') {
      e.preventDefault();
      toggleLabels();
      return;
    }

    if (!isMeta && state.tool === 'eraser' && (key === '[' || key === ']')) {
      e.preventDefault();
      const factor = key === ']' ? 1.18 : 1 / 1.18;
      state.brushSize = Math.max(4, Math.min(200, Math.round(state.brushSize * factor)));
      showToast('Brush size: ' + state.brushSize + ' px', { replace: true });
      updateUI();
      return;
    }

    if (e.key === 'Enter' && state.appMode !== 'auto' && state.tool === 'select' && state.selection.kind === 'graphic') {
      e.preventDefault(); bgEnterEdit(getSelectedBoardGraphic()); return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.kind != null) {
      // In Auto Mode, project annotations/drafts are locked from Delete (use
      // Discard Drafts or Mark Review-Only). Deleting an added PHOTO is allowed
      // (US-052) — otherwise the only way to remove a photo is Reset Board.
      if (state.appMode === 'auto' && state.selection.kind !== 'image') return;
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === 'Escape') {
      if (!el.stitchesMenu.hidden) {
        closeLineStyleMenu();
      } else if (state.drawSession) {
        state.drawSession = null;
        state.tool = 'select';
        showToast('Drawing canceled.');
        updateUI();
        requestRender();
      } else if (state.eraseSession) {
        state.eraseSession = null;
        showToast('Erase canceled.');
        updateUI();
        requestRender();
      } else if (state.tool === 'straight' || state.tool === 'curved' || state.tool === 'add-point'
                 || state.tool === 'eraser' || state.tool === 'text'
                 || ['rectangle','circle','hexagon'].includes(state.tool)) {
        setTool('select');
      } else if (state.selection.kind === 'graphic' && state.graphicEdit) {
        bgExitEdit();
      } else if (state.selection.kind === 'annotation' && state.selection.part) {
        // First Escape drops back to whole-line nudging; the next one
        // clears the selection itself.
        state.selection.part = null;
        updateUI();
        requestRender();
      } else if (state.selection.kind != null) {
        clearSelection();
      }
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      state.spacePan = false;
      document.body.classList.remove('space-pan');
      document.body.classList.remove('grabbing');
    }
  }
