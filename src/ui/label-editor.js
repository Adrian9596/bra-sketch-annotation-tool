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
    el.labelEditor.value = getLabelText(ann);
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
