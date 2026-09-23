// Value model behind the Measurements panel's Size L / Size L2 / TOL / 中文 /
// English columns: built-in POM name fallbacks, the Tier-0 library-suggestion
// lookup, the ADR 0033 Mode-B measured-fusion gate, the imperial
// fraction <-> decimal math, the state.pomSpecs read/write layer, and the
// tolerance evaluation shared with the on-canvas readout. buildSpecInputCell
// lives here too because its ArrowUp/Down stepping is bound to
// scheduleSpecStepCommit's module-private timer.
// Extracted from src/ui/spec-panel.js; the row/cell DOM that consumes these
// values lives in src/ui/spec-row-builders.js.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Size L / TOL cell helpers ----
  // Values are stored per POM label in state.pomSpecs, so a paired row can
  // hold two independent Size L / TOL values (e.g. POM 1 Relax vs POM 2
  // Extend) even though only the primary row is visible.
  // Built-in labels for a POM (from POM_TEMPLATE), used as defaults for the
  // editable Description (English) and 中文 columns when the project has no
  // per-POM override.
  function builtinPomZh(pomKey) {
    return getPomInfo(String(pomKey == null ? '' : pomKey).trim()).zh || '';
  }
  function builtinPomEn(pomKey) {
    return getPomInfo(String(pomKey == null ? '' : pomKey).trim()).desc || '';
  }

  // ---- Library-value suggestions (Tier-0 measurement layer) ----
  // Each POM may carry a corpus-derived Size L suggestion (median + range +
  // default TOL + confidence) loaded from auto_mode_rules/sizeL-suggestions.json
  // and exposed as POM_SUGGESTIONS. These are PRE-FILLED as TD-owned defaults:
  // shown muted with a "library" badge, used for tolerance + export until the
  // TD types an override, and never persisted into state.pomSpecs — so a
  // regenerated corpus updates every POM the TD has not touched. Values are
  // stored in inches (the corpus unit); we only convert for display when the TD
  // has switched the working scale to cm (docs/decisions/0009-*).
  function getPomSuggestion(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key || !POM_SUGGESTIONS) return null;
    const s = POM_SUGGESTIONS[key];
    return s && typeof s === 'object' ? s : null;
  }

  // True when the POM has a usable library median (corpus data exists).
  function hasSuggestedValue(pomKey) {
    const s = getPomSuggestion(pomKey);
    return !!(s && s.median != null && s.n > 0);
  }

  // ---- Mode B measured suggestions (ADR 0033, flagged OFF by default) ----
  // When Mode B is on, a sketch-reliable POM's Size-L suggestion becomes the
  // library×sketch FUSED value derived from the detected anchors (fusion.js) —
  // still a suggestion, never assigned or persisted. Memoized by a cheap anchor
  // signature so getPomSpec stays cheap across a full panel rebuild.
  let _measuredCache = { sig: null, map: null };
  function measuredSuggestionsMap() {
    if (typeof modeBAnyEnabled !== 'function' || !modeBAnyEnabled()) return null;
    const am = (state && state.autoMode) || {};
    const anchors = Array.isArray(am.anchors) ? am.anchors : [];
    const det = am.detection || null;
    if (!anchors.length || !det) return null;
    const first = anchors[0] || {};
    const sig = anchors.length + ':' + (det.naturalWidth || 0) + 'x' + (det.naturalHeight || 0) + ':' + (first.kind || '') + first.x;
    if (_measuredCache.sig === sig) return _measuredCache.map;
    let map = null;
    try { map = mbComputeMeasuredSuggestions(anchors, POM_SUGGESTIONS, { width: det.naturalWidth, height: det.naturalHeight }); }
    catch (_e) { map = null; }
    _measuredCache = { sig, map };
    return map;
  }
  // Gated measured entry for a POM: only a coherent, positive numeric proposal
  // surfaces; a conflicted (review/outlier) POM returns null so the panel falls
  // back to the library value rather than showing a wrong number.
  function measuredFor(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    // Per-POM roll-out gate (US-041): only a globally-flagged or promoted POM
    // surfaces a measured value.
    if (typeof modeBEnabledForPom === 'function' && !modeBEnabledForPom(key)) return null;
    const map = measuredSuggestionsMap();
    if (!map) return null;
    const m = map[key];
    return (m && m.decision === 'ESTIMATED_SUGGESTION' && Number.isFinite(Number(m.value_in)) && Number(m.value_in) > 0) ? m : null;
  }

  // Corpus inches -> active display unit (no-op for the default 'in').
  function suggestionToDisplay(inchValue) {
    if (inchValue == null) return null;
    return state.calibration.unit === 'cm' ? inchValue * 2.54 : inchValue;
  }

  // Precision-preserving formatter (formatMeasure rounds to 0.1, too coarse for
  // eighth-inch specs like 3.75 or a 1/8 tolerance). Keeps up to 3 decimals.
  function formatSuggestion(inchValue) {
    const v = suggestionToDisplay(inchValue);
    if (v == null) return '';
    return String(Math.round(v * 1000) / 1000);
  }

  // ---- US-048: imperial fraction display for spec numbers ----
  // Size L / Size L2 / TOL are shown (panel) and exported (TOL) as reduced
  // fractions in INCH mode — the house spec convention (0.375 → 3/8, 5.5 →
  // 5 1/2, 2.25 → 2 1/4). cm mode keeps decimals. A value is fractionised only
  // when it lands EXACTLY on the 1/16 grid, so an odd/typed value (9.9, a raw
  // median) is shown verbatim rather than misrepresented as a near fraction.
  function gcdInt(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; }
  function decimalToFraction(value) {
    const DEN = 16;
    const v = Math.max(0, Number(value) || 0);
    const whole = Math.floor(v + 1e-9);
    const num = Math.round((v - whole) * DEN);
    if (num >= DEN) return String(whole + 1);
    if (num === 0) return String(whole);
    const g = gcdInt(num, DEN);
    const frac = (num / g) + '/' + (DEN / g);
    return whole > 0 ? (whole + ' ' + frac) : frac;
  }
  // Display string for a stored spec value: a fraction when on-grid in inches,
  // else the value verbatim. Preserves a leading "± " (TOL may carry one).
  function inchesToFractionOrDecimal(str) {
    const raw = String(str == null ? '' : str).trim();
    if (!raw) return raw;
    if (state.calibration.unit !== 'in') return raw; // cm → decimal as-is
    const pm = /^±\s*/.test(raw) ? '± ' : '';
    const body = raw.replace(/^±\s*/, '');
    const n = parseSpecNumber(body);
    if (n == null || n < 0) return raw;
    const scaled = n * 16;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return raw; // off 1/16 grid → decimal
    return pm + decimalToFraction(n);
  }
  function specNumEq(a, b) { return a != null && b != null && Math.abs(a - b) < 1e-9; }

  // Parse a fraction / mixed-number / decimal string ('1/4', '5 1/2', '0.25').
  // TOL defaults arrive as fractions but the tool's inputs are decimal.
  function fractionToNumber(raw) {
    if (raw == null) return null;
    const str = String(raw).trim();
    if (!str) return null;
    const mixed = str.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (mixed) return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    const frac = str.match(/^(\d+)\/(\d+)$/);
    if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : null;
  }

  // Formatted Size L suggestion ('' when the POM has no library data). With
  // Mode B on, a gated measured (library×sketch fused) value takes precedence
  // over the raw library median; both remain TD-owned suggestions.
  function suggestedSizeL(pomKey) {
    const m = measuredFor(pomKey);
    if (m) return formatSuggestion(m.value_in);
    const s = getPomSuggestion(pomKey);
    if (!s || s.median == null || !(s.n > 0)) return '';
    return formatSuggestion(s.median);
  }

  // Formatted default-TOL suggestion as a decimal in the active unit.
  function suggestedTol(pomKey) {
    const s = getPomSuggestion(pomKey);
    if (!s || !s.tol) return '';
    const n = fractionToNumber(s.tol);
    return n == null ? '' : formatSuggestion(n);
  }

  function getPomSpec(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key) return { sizeL: '', sizeL2: '', tol: '', zh: '', en: '' };
    const raw = (state.pomSpecs && state.pomSpecs[key]) || {};
    return {
      // sizeL / tol fall back to the library suggestion when the TD has no
      // override (mirrors how en / zh fall back to the built-in name). This is
      // what pre-fills the panel and drives tolerance + Excel export.
      sizeL: raw.sizeL != null ? String(raw.sizeL) : suggestedSizeL(key),
      sizeL2: raw.sizeL2 != null ? String(raw.sizeL2) : '',
      tol: raw.tol != null ? String(raw.tol) : suggestedTol(key),
      // en / zh fall back to the built-in name so every row shows a label
      // without the TD typing one; only edits that differ are persisted.
      zh: raw.zh != null ? String(raw.zh) : builtinPomZh(key),
      en: raw.en != null ? String(raw.en) : builtinPomEn(key),
    };
  }

  function setPomSpec(pomKey, field, rawValue) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key) return false;
    if (field !== 'sizeL' && field !== 'sizeL2' && field !== 'tol' && field !== 'zh' && field !== 'en') return false;
    if (!state.pomSpecs || typeof state.pomSpecs !== 'object') state.pomSpecs = {};
    const trimmed = String(rawValue == null ? '' : rawValue).trim();
    const current = state.pomSpecs[key] || {};
    const next = { ...current };
    // en / 中文 are name fields: a blank value OR one equal to the built-in
    // default stores no override (so the built-in can still evolve); anything
    // else is a per-project override. sizeL / tol just clear on blank.
    let clears;
    if (field === 'zh') clears = (trimmed === '' || trimmed === builtinPomZh(key));
    else if (field === 'en') clears = (trimmed === '' || trimmed === builtinPomEn(key));
    // sizeL / tol store no override when blank OR equal to the library
    // suggestion, so an accepted suggestion stays live and a regenerated corpus
    // can still evolve it (matches en / zh handling above).
    // US-048: compare NUMERICALLY, so accepting a suggestion still counts as
    // "no override" whether the field shows it as a fraction (5 1/2) or a
    // decimal (5.5) — both parse to the same number.
    else if (field === 'sizeL') clears = (trimmed === '' || trimmed === suggestedSizeL(key) || specNumEq(parseSpecNumber(trimmed), parseSpecNumber(suggestedSizeL(key))));
    else if (field === 'tol') clears = (trimmed === '' || trimmed === suggestedTol(key) || specNumEq(parseSpecNumber(trimmed), parseSpecNumber(suggestedTol(key))));
    else clears = (trimmed === '');
    if (clears) {
      if (next[field] == null) return false;
      delete next[field];
    } else {
      if (next[field] === trimmed) return false;
      next[field] = trimmed;
    }
    if (Object.keys(next).length === 0) {
      if (!state.pomSpecs[key]) return false;
      delete state.pomSpecs[key];
    } else {
      state.pomSpecs[key] = next;
    }
    return true;
  }

  function specFieldTdClass(field) {
    if (field === 'sizeL' || field === 'sizeL2') return 'spec-td-size';
    if (field === 'zh') return 'spec-td-zh';
    return 'spec-td-tol';
  }

  // US-031: rapid arrow-steps in a Size L / L2 / TOL field are one "burst" —
  // each step writes the spec immediately (so the tolerance chip tracks it),
  // but history commits once, after the last press. renderSpecPanel's
  // editing-field guard keeps the commit from rebuilding under the caret.
  const SPEC_STEP_COMMIT_MS = 700;
  let specStepCommitTimer = null;

  function scheduleSpecStepCommit() {
    if (specStepCommitTimer) clearTimeout(specStepCommitTimer);
    specStepCommitTimer = setTimeout(() => {
      specStepCommitTimer = null;
      pushHistoryIfChanged();
    }, SPEC_STEP_COMMIT_MS);
  }

  function buildSpecInputCell(pomKey, field, placeholder) {
    const td = document.createElement('td');
    td.className = specFieldTdClass(field);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = field === 'zh' ? 'spec-zh' : 'spec-val';
    // US-048: Size L / L2 / TOL display as imperial fractions (inch mode); zh
    // is a name field, shown verbatim.
    const rawFieldVal = getPomSpec(pomKey)[field];
    input.value = (field === 'sizeL' || field === 'sizeL2' || field === 'tol')
      ? inchesToFractionOrDecimal(rawFieldVal)
      : rawFieldVal;
    input.placeholder = placeholder || '';
    input.addEventListener('change', () => {
      if (setPomSpec(pomKey, field, input.value)) pushHistoryIfChanged();
    });
    // US-050: focusing selects the whole value, so one click + type REPLACES a
    // pre-filled library value — no manual clearing. Deferred a tick so a click
    // that positions the caret doesn't immediately deselect.
    input.addEventListener('focus', () => { setTimeout(() => { try { input.select(); } catch (_) { /* noop */ } }, 0); });
    // US-031: ArrowUp/Down steps the numeric spec fields by 1/8 — the Excel
    // export's fraction grain — or 0.1 in cm mode; Shift = a whole unit.
    if (field === 'sizeL' || field === 'sizeL2' || field === 'tol') {
      // US-035: name the unit in the tooltip, and mark unparseable values
      // instead of ignoring them silently. Refreshed live while typing.
      const unitTitle = () => {
        const u = state.calibration.unit || 'in';
        if (field === 'tol') return 'Tolerance in ' + u + ' — allowed ± variance from Size L. Decimal (0.25) or fraction (1/4).';
        if (field === 'sizeL2') return 'Optional Size L2 sample base in ' + u + ' for the depth tier — blank derives it from Size L.';
        return 'Size L target in ' + u + '. Decimal (12.5) or fraction (12 1/2).';
      };
      const refreshValidity = () => {
        const raw = input.value.trim();
        const bad = raw !== '' && parseSpecNumber(raw) == null;
        input.classList.toggle('spec-invalid', bad);
        input.title = bad
          ? 'Not a number — this value is ignored. Enter a decimal (12.5) or a fraction (12 1/2).'
          : unitTitle();
      };
      input.addEventListener('input', refreshValidity);
      refreshValidity();
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
        ev.preventDefault();
        const unitStep = state.calibration.unit === 'cm' ? 0.1 : 0.125;
        const step = (ev.shiftKey ? 1 : unitStep) * (ev.key === 'ArrowUp' ? 1 : -1);
        const base = parseSpecNumber(input.value);
        const next = Math.max(0, Math.round(((base == null ? 0 : base) + step) * 1000) / 1000);
        // Write the decimal to the store, but keep the field showing a fraction
        // (inch mode) so stepping by 1/8 reads as 3/8 → 1/2 → 5/8, not decimals.
        if (setPomSpec(pomKey, field, String(next))) scheduleSpecStepCommit();
        input.value = inchesToFractionOrDecimal(String(next));
        const tr = input.closest('tr');
        if (tr && tr.dataset.annId) refreshMeasuredValueForAnnotation(Number(tr.dataset.annId));
        refreshValidity();
      });
    }
    td.appendChild(input);
    return td;
  }

  // Read-only measured value for a drawn line: its length in the calibrated
  // unit when a scale is set, else raw board pixels. This is the connection
  // from the detected / adjusted geometry back to a usable number — Size L is
  // the target, TOL the allowed variance, and this is what the sketch is.
  function measuredValueText(ann) {
    if (!ann || !ann.start || !ann.end) return '';
    const lengthPx = lineLength(ann);
    if (!(lengthPx > 0)) return '';
    if (state.calibration.unitsPerPx != null) {
      return formatMeasure(lengthPx * state.calibration.unitsPerPx) + ' ' + state.calibration.unit;
    }
    return Math.round(lengthPx) + ' px';
  }

  // Tolerant numeric parse for a Size L / TOL field (leading number wins;
  // blank / non-numeric → null so the caller can treat it as "not set").
  // US-035: also accepts the fraction forms TDs actually type — "1/2",
  // "12 1/2", "12-1/2" — so a typed fraction behaves like its decimal
  // everywhere this parser is used (chip, readout, stepping, size run,
  // Excel export L2).
  function parseSpecNumber(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const frac = s.match(/^(\d+(?:\.\d+)?)?[\s-]*(\d+)\s*\/\s*(\d+)$/);
    if (frac && parseInt(frac[3], 10) !== 0) {
      const whole = frac[1] ? parseFloat(frac[1]) : 0;
      return whole + parseInt(frac[2], 10) / parseInt(frac[3], 10);
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // Compare a drawn line's measured length against its Size L ± TOL target.
  // Only meaningful when a real-unit scale is set (Size L / TOL are entered in
  // the calibrated unit; an uncalibrated px value can't be compared to cm/in).
  // status: 'in' (within TOL) | 'out' (outside TOL) | 'delta' (target set, no
  // TOL — show the difference only) | null (cannot compare).
  function evaluateSpecTolerance(ann, pomKey) {
    const out = { measured: null, target: null, tol: null, delta: null, status: null };
    if (!ann || state.calibration.unitsPerPx == null) return out;
    const lengthPx = lineLength(ann);
    if (!(lengthPx > 0)) return out;
    out.measured = lengthPx * state.calibration.unitsPerPx;
    const target = parseSpecNumber(getPomSpec(pomKey).sizeL);
    if (target == null) return out;
    out.target = target;
    out.delta = out.measured - target;
    const tol = parseSpecNumber(getPomSpec(pomKey).tol);
    if (tol == null) { out.status = 'delta'; return out; }
    out.tol = Math.abs(tol);
    out.status = Math.abs(out.delta) <= out.tol + 1e-9 ? 'in' : 'out';
    return out;
  }

  // Signed Δ against Size L with its ✓ / ✗ verdict — one formatter shared by
  // the panel's Value-cell chip and the on-canvas adjustment readout
  // (US-029), so the two can never disagree.
  function specDeltaText(ev) {
    if (!ev || !ev.status) return '';
    const signed = (ev.delta > 0 ? '+' : ev.delta < 0 ? '−' : '±') + formatMeasure(Math.abs(ev.delta));
    return ev.status === 'in' ? signed + ' ✓' : ev.status === 'out' ? signed + ' ✗' : signed;
  }
