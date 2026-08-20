// Anchor lookup by id, plus the US-038 per-anchor visibility state the
// Anchor Manager panel drives (hide / show / isolate / group-toggle).
// Source part for app.js. Run `npm run build` after editing.
//
// This is "which pins does the TD choose to see", not "how does a pin move":
// the pointer/keyboard drag-nudge-snap pipeline lives in
// anchor-interaction.js, which also consumes isAnchorHidden so hidden pins
// stay ungrabbable.

  function getAnchorById(id) {
    return state.autoMode.anchors.find(a => a.id === id) || null;
  }

  // ---- US-038: per-anchor visibility -------------------------------------
  // Session-only view state keyed by anchor KIND (one anchor per kind in the
  // seed). An anchor is visible iff !anchorsHidden && !isAnchorHidden(kind).
  // Every mutator requests a render; the panel's Anchors section rebuilds via
  // the specPanelFingerprint (which includes hiddenAnchorKinds).
  function hiddenAnchorSet() {
    if (!Array.isArray(state.autoMode.hiddenAnchorKinds)) state.autoMode.hiddenAnchorKinds = [];
    return state.autoMode.hiddenAnchorKinds;
  }

  function isAnchorHidden(kind) {
    return hiddenAnchorSet().indexOf(kind) !== -1;
  }

  function toggleAnchorHidden(kind) {
    const set = hiddenAnchorSet();
    const i = set.indexOf(kind);
    if (i === -1) set.push(kind); else set.splice(i, 1);
    // A hidden pin can't stay the selected/dragged one.
    if (isAnchorHidden(kind)) {
      const sel = getAnchorById(state.autoMode.anchorSelectedId);
      if (sel && sel.kind === kind) state.autoMode.anchorSelectedId = null;
    }
    requestRender();
  }

  function hideAllAnchors() {
    state.autoMode.hiddenAnchorKinds = state.autoMode.anchors.map(a => a.kind);
    state.autoMode.anchorSelectedId = null;
    requestRender();
  }

  function showAllAnchors() {
    state.autoMode.hiddenAnchorKinds = [];
    requestRender();
  }

  // Isolate: hide every anchor except `kind` — the "show only one" action.
  function isolateAnchor(kind) {
    state.autoMode.hiddenAnchorKinds = state.autoMode.anchors
      .map(a => a.kind).filter(k => k !== kind);
    requestRender();
  }

  // Group toggle: if any anchor in the group is visible, hide the whole
  // group; otherwise show it (mirrors the all-or-nothing lock/hide idiom).
  function toggleAnchorGroup(kinds) {
    const anyVisible = kinds.some(k => !isAnchorHidden(k));
    const set = new Set(hiddenAnchorSet());
    if (anyVisible) kinds.forEach(k => set.add(k));
    else kinds.forEach(k => set.delete(k));
    state.autoMode.hiddenAnchorKinds = [...set];
    requestRender();
  }
