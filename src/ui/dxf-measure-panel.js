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
  }
