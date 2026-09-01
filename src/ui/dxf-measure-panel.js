// US-105: DXF Pattern Measurement — Tools-menu entry wiring. Sibling to
// src/ui/dxf-import-panel.js, same split: this file owns only the button
// click -> tool-mode wiring; the actual interaction lives in
// src/manual/dxf-measure-interaction.js, the session model in
// src/manual/dxf-measure-session.js.
// Source part for app.js. Run `npm run build` after editing.

  function setDxfMeasureMode(mode) {
    const session = state.dxfMeasureSession;
    if (!session) {
      showToast('Import a DXF file first (Tools → Open DXF file…).');
      return;
    }
    session.pendingMode = mode;
    session.placementArmed = true;
    session.interaction = null;
    setTool('pattern-measure');
    updateUI();
    requestRender();
  }

  function bindDxfMeasurePanel() {
    if (el.dxfMeasureAlongBtn) el.dxfMeasureAlongBtn.addEventListener('click', () => setDxfMeasureMode('along-path'));
    if (el.dxfMeasureOutBtn) el.dxfMeasureOutBtn.addEventListener('click', () => setDxfMeasureMode('out-of-path'));
    // US-112: snap preference toggles — always clickable (a TD preference,
    // not gated on a session existing, same as Smart Align).
    if (el.dxfMeasureSnapEndpointBtn) el.dxfMeasureSnapEndpointBtn.addEventListener('click', () => toggleDxfMeasureSnapKind('endpoint'));
    if (el.dxfMeasureSnapMidpointBtn) el.dxfMeasureSnapMidpointBtn.addEventListener('click', () => toggleDxfMeasureSnapKind('midpoint'));
    if (el.dxfMeasureSnapIntersectionBtn) el.dxfMeasureSnapIntersectionBtn.addEventListener('click', () => toggleDxfMeasureSnapKind('intersection'));
    // US-113: the session's measurement list panel.
    bindDxfMeasurementsPanel();
    // ADR 0073: picking a unit is an explicit override even when it matches
    // the parser's guess — "the TD confirmed in" and "the parser assumed in"
    // are different provenance states, and the note reflects that.
    if (el.dxfMeasureUnitSelect) {
      el.dxfMeasureUnitSelect.addEventListener('change', () => {
        const session = state.dxfMeasureSession;
        if (!session) return;
        dxfMeasureSetUnitOverride(session, el.dxfMeasureUnitSelect.value);
      });
      // The Tools menu closes itself on stray clicks; a click that is just
      // opening the select's dropdown must not bubble into that handler.
      el.dxfMeasureUnitSelect.addEventListener('click', (event) => event.stopPropagation());
    }
  }
