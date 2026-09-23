// Manual-mode keyboard line nudge (US-027). Source part for app.js.
// Run `npm run build` after editing.
//
// Arrow keys move the selected line — or just its active point, cycled with
// Tab — by one source-image pixel. Reuses dragHandle/moveAnnotation from
// pointer-events.js so curve semantics match a mouse drag; the key routing
// itself lives in keyboard-shortcuts.js.

  // ---- US-027: arrow-key nudge for Manual-Mode lines ------------------------
  // Mirrors the Auto-Mode anchor nudge: arrows move one source-image pixel
  // (Shift = 10), and rapid keystrokes form one "nudge session" that pushes a
  // single history entry LINE_NUDGE_COMMIT_MS after the last keystroke — the
  // same one-commit-per-drag contract the mouse path follows. Tab cycles the
  // active part; with no part active the whole line moves.
  const LINE_NUDGE_COMMIT_MS = 700;
  let lineNudgeSession = null; // { annId, timer }

  // Ring order: the main points first (the common Tab targets), then the
  // bend handles (US-030) in geometric order start-side → end-side. Only
  // parts the annotation actually has are included, so single-segment
  // curves and straight lines get shorter rings automatically.
  function lineNudgeParts(ann) {
    const parts = [null, 'start'];
    if (ann.type === 'curved') {
      if (ann.midPoint) parts.push('midPoint');
      parts.push('end');
      if (ann.control1) parts.push('control1');
      if (ann.midHandleIn) parts.push('midHandleIn');
      if (ann.midHandleOut) parts.push('midHandleOut');
      if (ann.control2) parts.push('control2');
      // US-093: interior anchors the TD added, appended after the fixed
      // fields so a curve with none cycles exactly as it always has.
      (ann.points || []).forEach((_, i) => {
        parts.push('point' + i + '.handleIn', 'point' + i + '.point', 'point' + i + '.handleOut');
      });
    } else {
      parts.push('end');
    }
    return parts;
  }

  function nudgePartLabel(part) {
    if (part === 'start') return 'start point';
    if (part === 'midPoint') return 'mid point';
    if (part === 'end') return 'end point';
    if (part === 'control1') return 'start bend handle';
    if (part === 'control2') return 'end bend handle';
    if (part === 'midHandleIn') return 'mid bend handle (start side)';
    if (part === 'midHandleOut') return 'mid bend handle (end side)';
    const anchor = parseCurveAnchorPart(part);
    if (anchor) {
      const n = anchor.index + 1;
      if (anchor.field === 'point') return 'point ' + n;
      return 'point ' + n + ' bend handle (' + (anchor.field === 'handleIn' ? 'in' : 'out') + ' side)';
    }
    return 'whole line';
  }

  function cycleNudgePart(ann, dir) {
    const parts = lineNudgeParts(ann);
    const idx = parts.indexOf(state.selection.part || null);
    const next = parts[(idx + dir + parts.length) % parts.length];
    state.selection.part = next;
    // Live status — latest wins; queueing stale part names after a Tab
    // burst would mislead (US-032).
    showToast('Arrows move the ' + nudgePartLabel(next) + '.', { replace: true });
    updateUI();
    requestRender();
  }

  // World-units-per-source-pixel for the image under the line's midpoint —
  // the same association rule as getAnnotationsOnImage. Off-image lines fall
  // back to one screen pixel so the nudge always does something visible.
  function lineNudgeWorldStep(ann) {
    const mid = { x: (ann.start.x + ann.end.x) / 2, y: (ann.start.y + ann.end.y) / 2 };
    const hit = hitTestImages(mid);
    const image = hit ? getImageById(hit.id) : null;
    if (image && image.img && image.img.naturalWidth && image.width) {
      return image.width / image.img.naturalWidth;
    }
    return 1 / state.zoom;
  }

  function nudgeSelectedAnnotation(dxPx, dyPx) {
    const ann = getSelectedAnnotation();
    if (!ann) return false;
    const stepWorld = lineNudgeWorldStep(ann);
    const dx = dxPx * stepWorld;
    const dy = dyPx * stepWorld;
    if (lineNudgeSession && lineNudgeSession.annId !== ann.id) {
      flushLineNudgeSession();
    }
    if (!lineNudgeSession) {
      lineNudgeSession = { annId: ann.id, timer: null };
    }
    const part = state.selection.part;
    const point = part ? getAnnPartPoint(ann, part) : null;
    if (part && point) {
      // Route through dragHandle so curve semantics (endpoint carrying its
      // control, mid point carrying both mid handles, an interior anchor's
      // handles mirroring per US-093) match a mouse drag. Keyboard nudging
      // has no Alt-modifier gesture defined, so a handle always mirrors.
      const prev = clonePoint(point);
      dragHandle(ann, part, { x: prev.x + dx, y: prev.y + dy }, prev, false);
    } else {
      moveAnnotation(ann, dx, dy);
    }
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    if (lineNudgeSession.timer) clearTimeout(lineNudgeSession.timer);
    lineNudgeSession.timer = setTimeout(flushLineNudgeSession, LINE_NUDGE_COMMIT_MS);
    refreshMeasuredValueForAnnotation(ann.id); // US-028: live Value cell
    requestRender();
    return true;
  }

  // Lets the renderer show the adjustment readout (US-029) while a nudge
  // burst is still open, without reaching into the session object.
  function isLineNudgeActive(annId) {
    return !!(lineNudgeSession && lineNudgeSession.annId === annId);
  }

  function flushLineNudgeSession() {
    const session = lineNudgeSession;
    lineNudgeSession = null;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    const ann = getAnnotationById(session.annId);
    pushHistoryIfChanged();
    requestRender(); // drop the on-canvas readout now that the burst committed
    // Same learning capture as a committed mouse drag on an applied draft.
    if (state.appMode === 'manual' && ann && isAutoDraft(ann)) {
      const evalResult = evaluateManualPomSample(ann, { allowAuto: true });
      if (evalResult.status === 'recorded') {
        showToast('POM ' + evalResult.pom + ' learning sample saved from TD edit.');
        updateUI();
      }
    }
  }
