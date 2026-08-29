// US-102: POM Focus / Sketch Focus — a session-only display/tool-visibility
// toggle WITHIN Manual Mode (not a new state.appMode value, not a new page).
// POM Focus is the IMPLICIT default and has no button of its own; the one
// visible control is a single Manual-only toggle, `#sketchFocusBtn`, that
// enters or leaves the exceptional Sketch Focus (2026-08-28 correction — the
// original two-button "POM Focus | Sketch Focus" segmented control is wrong;
// see docs/archive/stories/E01-manual-mode/US-102-sketch-mode-handoff.md).
// It never touches stored data (annotations/graphics/notes/stamps/presets
// stay exactly where they are); it only changes what the toolbar and canvas
// SHOW, and whether Smart Align is live:
//   - `.sketch-mode-only` elements (index.html) — Templates (Shape Stamp),
//     the Treatment/Line-preset library browsing UI, Smart Align's own
//     control, and the zigzag/cover/bartack stitch styles — surface only in
//     Sketch Focus.
//   - `.pom-mode-only` elements — the "More" toolbar menu (Grading, Set
//     Scale, Size Run, Learning, ...) — surface only in POM Focus.
//   - Smart Align (computeSmartAlignment in smart-align.js) is a hard off in
//     POM Focus regardless of its own on/off preference, and honors that
//     preference again in Sketch Focus.
//   - POM callout numbers on the LIVE canvas are hidden in Sketch Focus via
//     annotationShowsCallout (annotation-lookup.js) — deliberately NOT via
//     labelsVisible (style.js), which also gates PDF/Copy Image/Excel/
//     Preview export and must never change because of this live-only toggle.
//   - Straight/Curved/Eraser/Rectangle/Circle/Hexagon/Text and the
//     Plain/Dashed line styles are UNAFFECTED either way.
//   - US-103: Smart Hit's expanded Treatment-rail catch zone
//     (annotationVisualHitDistance, hit-testing.js) is live only in Sketch
//     Focus; POM Focus and Auto Mode hit-test the plain host centerline.
//   - US-103: the pending arrow default (state.arrowType) resets to `none` on
//     entry and restores the POM-side preference on exit; selecting a line
//     while Sketch Focus is on does not steer it (adoptArrowTypeFrom,
//     selection.js), so tapping an arrowed POM mid-sketch cannot poison the
//     next drawn path's arrows.
// Session-only: absent from project JSON, autosave payloads, and undo/redo
// history — see project-load.js (every reopen/restore forces POM Focus) and
// auto/mode.js (every switch to Auto forces POM Focus, since the control
// itself is Manual-only and would otherwise leave no way to see or undo a
// leaked Sketch Focus effect from Auto Mode). Both call applySketchModeVisual
// directly — the SAME state+body-class+button-sync path the toolbar button
// uses — so the button can never show "active"/aria-pressed=true while
// runtime state has already left it; each site clears its own armed-Template
// state alongside it (auto/mode.js via setTool('select'), project-load.js via
// a direct activeStampId reset next to its other tool-state resets), not by
// re-running setSketchModeEnabled's toggle-specific cleanup (which also
// resets state.drawStyle off a stitch style — correct for a live toggle,
// wrong for a reopened project, whose drawStyle is the file's own saved
// value).
// Source part for app.js. Run `npm run build` after editing.

  // The one place that writes state.sketchMode, the body class, and the
  // button's active class + aria-pressed. setAppMode('auto') and
  // loadProject() call this directly (with no toast/tool cleanup — see
  // setSketchModeEnabled) so a focus that was on when either fires cannot
  // leave the button stuck showing active/aria-pressed=true while runtime
  // state has already moved on.
  //
  // US-103: also the one place that swaps state.arrowType for the Sketch
  // Focus "no arrows" default and restores it afterward, so all three exits
  // (toggle-off, Auto, Open Project) hand the POM preference back the same
  // way. Gated on an ACTUAL flip (comparing against the prior state.sketchMode)
  // so a call that repeats the current value — every Auto/Open-Project call,
  // since neither can ever be entering Sketch Focus — never stomps a POM
  // arrow preference that was never touched.
  function applySketchModeVisual(enabled) {
    const next = !!enabled;
    const wasOn = state.sketchMode;
    if (next && !wasOn) {
      state.pomArrowType = state.arrowType;
      state.arrowType = 'none';
    } else if (!next && wasOn) {
      if (state.pomArrowType != null) state.arrowType = state.pomArrowType;
      state.pomArrowType = null;
    }
    state.sketchMode = next;
    document.body.classList.toggle('sketch-mode-on', state.sketchMode);
    if (el.sketchFocusBtn) {
      el.sketchFocusBtn.classList.toggle('active', state.sketchMode);
      el.sketchFocusBtn.setAttribute('aria-pressed', String(state.sketchMode));
    }
  }

  function setSketchModeEnabled(enabled, announce) {
    applySketchModeVisual(enabled);
    if (state.sketchMode) {
      // Auto-close the Measurements panel on entry — it has nothing to show
      // in Sketch Focus work. This reuses the SAME toggle the H key/button
      // already drive (toggleSpecPanel), so a TD can still reopen it by
      // hand; only the default on ENTRY changes.
      if (el.workspace && !el.workspace.classList.contains('panel-hidden')) toggleSpecPanel();
    } else {
      // Whatever just lost its toolbar entry point must not stay silently
      // active with no visible way to tell what is selected. Route through
      // setTool('select') — not a hand-rolled state.tool assignment — so the
      // SAME cleanup a TD gets from pressing Escape or picking another tool
      // runs here too: it already clears activeStampId (US-097 code review),
      // drawSession, eraseSession, and the eraser body class.
      if (state.tool === 'stamp' && typeof setTool === 'function') setTool('select');
      // Defensive: cancel an in-progress placement drag outright, in the
      // (practically unreachable via mouse, but keyboard/Command-Palette
      // dispatch makes it not impossible) case one was mid-gesture.
      state.interaction = null;
      if (isStitchStyle(state.drawStyle)) state.drawStyle = 'solid';
    }
    if (announce !== false) showToast(state.sketchMode
      ? 'Sketch Focus — Templates, Smart Align, and stitch styles are available.'
      : 'POM Focus — measurement review and correction.');
    updateUI();
    requestRender();
    return state.sketchMode;
  }

  function toggleSketchMode() {
    return setSketchModeEnabled(!state.sketchMode, true);
  }
