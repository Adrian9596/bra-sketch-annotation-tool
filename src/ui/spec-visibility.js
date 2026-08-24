// Per-POM line visibility on the canvas: the state helpers plus the DOM
// controls (the per-row × / + toggle and the sticky "Hide all / Show all"
// row) that expose it in the Measurements panel.
// Extracted from src/ui/spec-panel.js; the panel orchestrator that calls
// these lives there, and the row builders that embed the toggle live in
// src/ui/spec-row-builders.js.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Per-POM visibility (review overlay) ----
  // Hide toggles let the TD isolate one POM line at a time on the canvas so
  // they can eyeball whether Auto Mode picked the right anchors. Kept as
  // arrays on state (serialization-friendly); the helpers below normalize
  // to a set-like lookup. Session-only, not persisted.
  //
  // US-093 / ADR 0053 code review, 2026-08-21: a hidden line is not merely
  // undrawn — canAddCurveAnchor() (canvas-tools.js) refuses it, so a
  // panel-only refresh leaves "Add point" visible and .active on a line every
  // click now silently refuses. Hence updateUI(), not renderSpecPanel(), and
  // one exit for it: the mutators here plus the setHiddenAnnIds debug hook
  // (src/auto/debug-api.js), which drifted once by taking its own route. The
  // only other writers clear the set inside a bigger reset (board-reset.js,
  // project-load.js) and already end in updateUI(). Drafts are out of scope:
  // nothing updateUI() syncs reads isDraftHidden, so toggleDraftHidden
  // refreshes the panel alone.
  function syncAfterHiddenPomChange() {
    updateUI();
    requestRender();
  }

  // US-096 / ADR 0055 code review, 2026-08-23: hiding is a POM-REVIEW gesture,
  // so it can only apply to a measurement line.
  //
  // state.hiddenAnnIds is not pruned when a line changes role, and nothing else
  // could prune it — a role flip is reachable from the Stitches menu, a preset,
  // and the spec panel's own POM cell. Deriving the answer here instead makes it
  // self-healing from every one of those paths at once.
  //
  // Without this, a hidden POM line restyled to a stitch style was stranded: not
  // painted (render-loop and visibleExportAnnotations both skip hidden lines),
  // no spec row left to carry its × toggle, and filtered out of
  // getSelectedAnnotationIds so it could not even be clicked. It still counted
  // in "Annotations: n" and still blocked Clear. It could also drive
  // hideablePomCount() - hiddenPomCount() negative, which permanently
  // suppressed the Hide-all control.
  function isAnnHidden(id) {
    if (id == null) return false;
    const ids = state.hiddenAnnIds;
    if (!Array.isArray(ids)) return false;
    if (ids.indexOf(id) === -1) return false;
    const ann = (state.annotations || []).find(a => a && a.id === id);
    return ann ? isMeasurementAnnotation(ann) : true;
  }

  function isDraftHidden(id) {
    if (id == null) return false;
    const ids = state.hiddenDraftIds;
    if (!Array.isArray(ids)) return false;
    return ids.indexOf(id) !== -1;
  }

  function toggleAnnHidden(id) {
    if (id == null) return;
    if (!Array.isArray(state.hiddenAnnIds)) state.hiddenAnnIds = [];
    const idx = state.hiddenAnnIds.indexOf(id);
    if (idx === -1) state.hiddenAnnIds.push(id);
    else state.hiddenAnnIds.splice(idx, 1);
    syncAfterHiddenPomChange();
  }

  function toggleDraftHidden(id) {
    if (id == null) return;
    if (!Array.isArray(state.hiddenDraftIds)) state.hiddenDraftIds = [];
    const idx = state.hiddenDraftIds.indexOf(id);
    if (idx === -1) state.hiddenDraftIds.push(id);
    else state.hiddenDraftIds.splice(idx, 1);
    renderSpecPanel();
    requestRender();
  }

  // Counted through isAnnHidden rather than off the raw array, so an id left
  // behind by a line that has since become construction cannot make this
  // exceed hideablePomCount() and drive the visible count negative.
  function hiddenPomCount() {
    const a = Array.isArray(state.hiddenAnnIds)
      ? state.hiddenAnnIds.filter(id => isAnnHidden(id)).length : 0;
    const d = Array.isArray(state.hiddenDraftIds) ? state.hiddenDraftIds.length : 0;
    return a + d;
  }

  // How many POM lines can be toggled at all: drawn annotations plus (in Auto
  // Mode) outstanding drafts. Template rows with no line drawn yet are not
  // hideable, so they don't count. Drives whether the visibility control row
  // renders and whether "Hide all" has anything to act on.
  function hideablePomCount() {
    // US-096: construction lines are not POMs, so they neither count towards
    // "is there anything to hide" nor get hidden by Hide all.
    let n = measurementAnnotations().length;
    if (state.appMode === 'auto' && state.autoMode && Array.isArray(state.autoMode.draftAnnotations)) {
      n += state.autoMode.draftAnnotations.length;
    }
    return n;
  }

  function showAllPoms() {
    let changed = false;
    if (Array.isArray(state.hiddenAnnIds) && state.hiddenAnnIds.length > 0) {
      state.hiddenAnnIds = [];
      changed = true;
    }
    if (Array.isArray(state.hiddenDraftIds) && state.hiddenDraftIds.length > 0) {
      state.hiddenDraftIds = [];
      changed = true;
    }
    if (!changed) return;
    syncAfterHiddenPomChange();
  }

  // Inverse of showAllPoms: hide every visible POM line at once so the TD can
  // clear the sketch and reveal lines one at a time. Mirrors showAllPoms'
  // ann + draft handling so the two stay symmetric.
  function hideAllPoms() {
    let changed = false;
    if (!Array.isArray(state.hiddenAnnIds)) state.hiddenAnnIds = [];
    for (const ann of measurementAnnotations()) {
      if (ann && ann.id != null && state.hiddenAnnIds.indexOf(ann.id) === -1) {
        state.hiddenAnnIds.push(ann.id);
        changed = true;
      }
    }
    if (state.appMode === 'auto' && state.autoMode && Array.isArray(state.autoMode.draftAnnotations)) {
      if (!Array.isArray(state.hiddenDraftIds)) state.hiddenDraftIds = [];
      for (const draft of state.autoMode.draftAnnotations) {
        if (draft && draft.id != null && state.hiddenDraftIds.indexOf(draft.id) === -1) {
          state.hiddenDraftIds.push(draft.id);
          changed = true;
        }
      }
    }
    if (!changed) return;
    syncAfterHiddenPomChange();
  }

  // Small × / + toggle used in each POM row. Text intentionally kept to a
  // single glyph so the button stays out of the row's way.
  function buildVisibilityToggleButton(hidden, onToggle, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pom-vis-btn' + (hidden ? ' is-hidden' : '');
    btn.textContent = hidden ? '+' : '×';
    btn.title = hidden
      ? 'Show this POM line on the sketch'
      : 'Hide this POM line so you can review other lines alone';
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    if (opts && opts.disabled) {
      btn.disabled = true;
      btn.title = opts.disabledTitle || 'Nothing drawn yet for this POM.';
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      onToggle();
    });
    return btn;
  }

  // Sticky control row at the top of the panel. Shows "Hide all POMs" while any
  // line is still visible and "Show all POMs (N hidden)" while any line is
  // hidden — both together when the sketch is partially hidden.
  function buildVisibilityControlRow() {
    const tr = document.createElement('tr');
    tr.className = 'spec-show-all-row';
    const td = document.createElement('td');
    td.colSpan = SPEC_COL_COUNT;
    const wrap = document.createElement('div');
    wrap.className = 'spec-vis-actions';

    const hiddenCount = hiddenPomCount();
    const visibleCount = hideablePomCount() - hiddenCount;

    if (visibleCount > 0) {
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'spec-hide-all-btn';
      hideBtn.textContent = 'Hide all POMs';
      hideBtn.title = 'Hide every POM line on the sketch so you can reveal them one at a time.';
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideAllPoms();
      });
      wrap.appendChild(hideBtn);
    }
    if (hiddenCount > 0) {
      const showBtn = document.createElement('button');
      showBtn.type = 'button';
      showBtn.className = 'spec-show-all-btn';
      showBtn.textContent = 'Show all POMs (' + hiddenCount + ' hidden)';
      showBtn.title = 'Restore visibility for every hidden POM line on the sketch.';
      showBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showAllPoms();
      });
      wrap.appendChild(showBtn);
    }
    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
  }

  function appendVisibilityToggle(td, opts) {
    const btn = buildVisibilityToggleButton(!!opts.hidden, opts.onToggle, {
      disabled: !!opts.disabled,
      disabledTitle: opts.disabledTitle,
    });
    td.appendChild(btn);
  }
