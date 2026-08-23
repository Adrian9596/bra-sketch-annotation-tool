// Manual mode: color / line-style / arrow / line-width normalizers and
// getters. These are pure helpers that map raw annotation fields onto the
// canonical values used by rendering, plus the Stitches/POM mode flag.
// Source part for app.js. Run `npm run build` after editing.

  function normalizeColorKey(color) {
    if (LINE_COLORS[color]) return color;
    const found = Object.entries(LINE_COLORS).find(([, value]) => value.toLowerCase() === String(color || '').toLowerCase());
    return found ? found[0] : 'red';
  }

  function getAnnotationColor(ann) {
    const key = normalizeColorKey(ann?.color);
    return LINE_COLORS[key] || LINE_COLOR;
  }

  // The board has two modes, driven entirely by the active Stitches selection.
  // Plain/Dashed keep measurement (POM) mode; the three true stitch types put
  // the whole board into Stitch (construction) mode.
  function isStitchMode() {
    return state.drawStyle === 'zigzag' || state.drawStyle === 'cover' || state.drawStyle === 'bartack';
  }

  // Callout numbers are always hidden in Stitch mode; in POM mode they honor
  // the manual Hide/Show Numbers toggle.
  function labelsVisible() {
    return state.showLabels && !isStitchMode();
  }

  function getLineStyle(ann) {
    return normalizeLineStyle(ann?.style);
  }

  function normalizeLineStyle(style) {
    return ['solid', 'dashed', 'zigzag', 'cover', 'bartack'].includes(style) ? style : 'solid';
  }

  function updateLineStyleControl(activeStyle) {
    const style = normalizeLineStyle(activeStyle);
    el.stitchesBtnLabel.textContent = 'Stitches: ' + lineStyleLabel(style);
    el.stitchesBtn.classList.toggle('active', style !== 'solid');
    el.styleOptionBtns.forEach((button) => {
      button.classList.toggle('active', button.dataset.style === style);
    });
  }

  function getArrowType(ann) {
    if (ann?.arrowType === 'single' || ann?.arrowType === 'double' || ann?.arrowType === 'none') {
      return ann.arrowType;
    }
    return ann?.style === 'solid' ? 'double' : 'single';
  }

  function normalizeLineWidth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LINE_WIDTH;
    return clamp(n, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
  }

  function getLineWidth(ann) {
    return normalizeLineWidth(ann?.lineWidth);
  }

  function getActiveLineWidth() {
    const selectedAnnotation = getSelectedAnnotation();
    const selectedGraphic = getSelectedBoardGraphic();
    return selectedAnnotation ? getLineWidth(selectedAnnotation)
      : selectedGraphic ? normalizeLineWidth(selectedGraphic.lineWidth)
        : normalizeLineWidth(state.lineWidth);
  }

  // A note's own size control (US-092), mirroring getActiveLineWidth exactly:
  // a selected note's chip reads and writes THAT note's fontSize directly, and
  // falls back to the sticky "next note" default only when nothing is
  // selected — so the chip never needs state.noteFontSize resynced on select.
  function getActiveNoteFontSize() {
    const selectedNote = getSelectedNote();
    return selectedNote ? noteFontSizeOf(selectedNote) : normalizeNoteFontSize(state.noteFontSize);
  }
