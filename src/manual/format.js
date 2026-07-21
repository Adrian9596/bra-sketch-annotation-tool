// Manual mode: small pure formatters used by spec panel, label rendering,
// and the line-width input.
// Source part for app.js. Run `npm run build` after editing.

  function formatLineWidth(value) {
    return String(Math.round(normalizeLineWidth(value) * 10) / 10).replace(/\.0$/, '');
  }

  function formatMeasure(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function lineStyleLabel(style) {
    if (style === 'dashed') return 'Dashed';
    if (style === 'zigzag') return 'Zigzag';
    if (style === 'cover') return 'Cover';
    if (style === 'bartack') return 'Bartack';
    return 'Plain';
  }
