// Editable callout labels: positions a floating textarea (el.labelEditor)
// over a canvas-space point, then commits or cancels the edit — firing the
// Phase 2/3 learning-sample hook on commit. worldToScreen, the canvas ->
// screen coordinate helper it needs, lives here and is shared with the
// renderers. The two el.labelEditor listeners are wired in bindUI()
// (src/ui/bindings.js).
// Source part for app.js. Run `npm run build` after editing.

  function worldToScreen(x, y) {
    return { x: x * state.zoom + state.panX, y: y * state.zoom + state.panY };
  }

  // ---- Editable labels ----
  function openLabelEditor(id) {
    const ann = getAnnotationById(id);
    if (!ann) return;
    state.editingLabelId = id;
    const screen = worldToScreen(ann.label.x, ann.label.y);
    el.labelEditor.style.display = 'block';
    el.labelEditor.style.left = screen.x + 'px';
    el.labelEditor.style.top = screen.y + 'px';
    el.labelEditor.style.color = getAnnotationColor(ann);
    // US-096 / ADR 0055, second code review 2026-08-23: a construction line
    // paints no callout, so there is no current label to pre-fill — and
    // pre-filling one here was a zero-keystroke trap.
    //
    // getLabelText falls back to String(ann.seq), and a construction line is
    // born holding state.nextSequence WITHOUT advancing it, so that number is
    // exactly the one the next measurement line will take. The editor commits
    // on blur (bindings.js), so a stray double-click on a stitch mark followed
    // by a click anywhere else wrote `ann.text = "<that number>"` — which is
    // the ADR's deliberate "a labelled stitch line still measures" exception,
    // fired by accident, producing two measurement lines answering to one POM
    // key. Before US-096 the same commit was a semantic no-op.
    //
    // Opening empty keeps the exception REACHABLE (a TD who genuinely wants a
    // labelled stitch line types the number) while making it deliberate.
    el.labelEditor.value = annotationShowsCallout(ann) ? getLabelText(ann) : (ann.text || '');
    requestRender();
    requestAnimationFrame(() => {
      el.labelEditor.focus();
      el.labelEditor.select();
    });
  }

  function onLabelEditorKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLabelEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelLabelEditor();
    }
    e.stopPropagation();
  }

  function commitLabelEditor() {
    const id = state.editingLabelId;
    if (id == null) return;
    const ann = getAnnotationById(id);
    state.editingLabelId = null;
    el.labelEditor.style.display = 'none';
    if (ann) {
      const raw = el.labelEditor.value.trim();
      const next = raw === '' ? null : raw;
      if (ann.text !== next) {
        ann.text = next;
        pushHistoryIfChanged();
      }
      // Phase 2/3 learning hook. POM 1–5 record silently. POM 6+ with
      // no confirmed meaning surface a one-click picker. Unknown labels
      // and re-commits without endpoint changes return 'skipped'.
      const evalResult = evaluateManualPomSample(ann);
      if (evalResult.status === 'recorded') {
        showToast('POM ' + ann.learnSamplePom + ' learning sample saved');
        updateUI();
      }
    }
    updateUI();
    requestRender();
  }

  function cancelLabelEditor() {
    state.editingLabelId = null;
    el.labelEditor.style.display = 'none';
    updateUI();
    requestRender();
  }
