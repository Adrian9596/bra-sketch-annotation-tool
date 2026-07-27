// Measurement / spec panel rendering and the calibration commands it owns.
// Source part for app.js. Run `npm run build` after editing.
//
// renderSpecPanel rebuilds the table on the right side of the board. It
// renders the Auto Mode draft review section (if drafts are present),
// then walks the 18 POM template slots in order — using a drawn
// annotation when the label matches, or a read-only template row when
// nothing has been drawn yet — pairing primary/secondary POMs into one
// row where the schema defines a pair. Every row exposes editable Size L
// and TOL inputs so the TD can enter spec-sheet targets even before a
// line is drawn; those values live on state.pomSpecs (per POM label) and
// persist through save/load + undo/redo. Cell builders here are paired
// helpers; setScaleFromSelection / clearScale drive the calibration row
// shown above the table.

  // ---- Per-POM visibility (review overlay) ----
  // Hide toggles let the TD isolate one POM line at a time on the canvas so
  // they can eyeball whether Auto Mode picked the right anchors. Kept as
  // arrays on state (serialization-friendly); the helpers below normalize
  // to a set-like lookup. Session-only, not persisted.
  function isAnnHidden(id) {
    if (id == null) return false;
    const ids = state.hiddenAnnIds;
    if (!Array.isArray(ids)) return false;
    return ids.indexOf(id) !== -1;
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
    renderSpecPanel();
    requestRender();
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

  function hiddenPomCount() {
    const a = Array.isArray(state.hiddenAnnIds) ? state.hiddenAnnIds.length : 0;
    const d = Array.isArray(state.hiddenDraftIds) ? state.hiddenDraftIds.length : 0;
    return a + d;
  }

  // How many POM lines can be toggled at all: drawn annotations plus (in Auto
  // Mode) outstanding drafts. Template rows with no line drawn yet are not
  // hideable, so they don't count. Drives whether the visibility control row
  // renders and whether "Hide all" has anything to act on.
  function hideablePomCount() {
    let n = Array.isArray(state.annotations) ? state.annotations.length : 0;
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
    renderSpecPanel();
    requestRender();
  }

  // Inverse of showAllPoms: hide every visible POM line at once so the TD can
  // clear the sketch and reveal lines one at a time. Mirrors showAllPoms'
  // ann + draft handling so the two stay symmetric.
  function hideAllPoms() {
    let changed = false;
    if (!Array.isArray(state.hiddenAnnIds)) state.hiddenAnnIds = [];
    for (const ann of state.annotations) {
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
    renderSpecPanel();
    requestRender();
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

  // ---- Calibration ----
  function setScaleFromSelection() {
    const ann = getSelectedAnnotation();
    if (!ann) {
      showToast('Select a line first, then click Set Scale to calibrate by its real length.');
      return;
    }
    const px = lineLength(ann);
    if (px <= 0) {
      showToast('That line is too short to calibrate.');
      return;
    }
    openScaleDialog(px);
  }

  function clearScale() {
    if (state.calibration.unitsPerPx == null) return;
    state.calibration = { unitsPerPx: null, unit: state.calibration.unit };
    pushHistoryIfChanged();
    showToast('Scale cleared. Values are now manual only.');
    updateUI();
    requestRender();
  }

  // ---- Measurement table panel ----
  // Total column count in the spec table:
  //   POM | Description | 中文 | Value | Size L | Size L2 | TOL.
  // Value is the measured length of the drawn line (the connection back to
  // the sketch); Size L is the spec target and TOL its allowed variance.
  // Size L2 is the optional second sample base that anchors the depth tier
  // (M2–5XL2) in the Excel export — blank derives L2 = L + offset.
  const SPEC_COL_COUNT = 7;

  // ---- US-033: rebuild-skip fingerprint -----------------------------------
  // renderSpecPanel runs on every updateUI (every click), but most calls
  // change nothing the table renders from — only the selection moved. The
  // fingerprint captures the table's actual data inputs; when it matches the
  // one stored after the last full rebuild, we refresh highlight classes and
  // stop. Selection is deliberately NOT fingerprinted.
  //
  // If you add a panel feature that renders from state not listed here, add
  // its input to this fingerprint or the panel will go stale.
  let lastSpecPanelFingerprint = null;
  const specDepIds = new WeakMap();
  let specDepNext = 1;

  // Identity marker for heavyweight objects that are replaced wholesale
  // (detection) rather than mutated — cheaper than stringifying them.
  function specDepId(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    if (!specDepIds.has(obj)) specDepIds.set(obj, specDepNext++);
    return specDepIds.get(obj);
  }

  function specPanelFingerprint() {
    const r = (p) => (p ? [Math.round(p.x * 1000), Math.round(p.y * 1000)] : 0);
    const annBits = state.annotations.map(a => [
      a.id, a.seq, a.text, a.type,
      r(a.start), r(a.end), r(a.midPoint),
      r(a.control1), r(a.control2), r(a.midHandleIn), r(a.midHandleOut),
    ]);
    const draftBits = state.autoMode.draftAnnotations.map(d => [
      d.id, d.seq, d.text, !!d.tdApproved, !!d.tdEdited, !!d.tdTouched,
      d.drawability, d.confidence, d.reason, d.uncertainty, d.reviewNotes,
    ]);
    const anchors = state.autoMode.anchors;
    return JSON.stringify([
      state.appMode,
      annBits,
      draftBits,
      state.pomSpecs,
      state.customPoms,
      state.calibration.unitsPerPx, state.calibration.unit,
      state.hiddenAnnIds, state.hiddenDraftIds,
      state.images.length,
      specDepId(state.autoMode.detection),
      anchors.length, anchors.filter(a => a && a.reviewRequired).length,
      // US-038 anchor visibility lives in its OWN floating panel, not the
      // exported Measurements panel — so it is deliberately NOT fingerprinted
      // here.
    ]);
  }

  // US-035: the three numeric column headers name the board's active unit.
  // Runs before the US-033 fingerprint skip — it's three textContent sets,
  // and calibration is fingerprinted so full rebuilds stay correct too.
  function updateSpecUnitHeaders() {
    const u = '(' + (state.calibration.unit || 'in') + ')';
    document.querySelectorAll('.specPanel thead .th-unit').forEach((elm) => {
      if (elm.textContent !== u) elm.textContent = u;
    });
  }

  function renderSpecPanel() {
    renderSpecCalNote();
    updateSpecUnitHeaders();
    // Only preserve focus when the user is mid-edit in a text field inside
    // the panel — annotation rows, template rows, and paired rows all
    // qualify. Draft rows have no editable inputs, so Approve / R/O buttons
    // must always allow a full rebuild — otherwise row badges and the
    // review-header counts go stale (e.g. Approved/Edited badges, the
    // "N approved" line in the panel header).
    const active = document.activeElement;
    const editingPanelField = active
      && el.specBody.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      // The Add-POM inline form (US-011) also counts: rebuilding while the
      // TD types the new POM's name would destroy the half-typed entry.
      && !!(active.closest('tr[data-ann-id]') || active.closest('tr[data-pom-key]')
        || active.closest('tr.add-pom-row'));
    if (editingPanelField) {
      updateSpecHighlightOnly();
      return;
    }

    // US-033: nothing the table renders from changed — selection-only call.
    const fingerprint = specPanelFingerprint();
    if (fingerprint === lastSpecPanelFingerprint) {
      updateSpecHighlightOnly();
      return;
    }

    el.specBody.innerHTML = '';

    // Sticky visibility control row: renders whenever there is at least one
    // hideable line, offering "Hide all" (isolate the sketch) and, once
    // anything is hidden, "Show all" — each a one-click toggle so the TD can
    // reveal and re-hide lines while checking evidence.
    if (hideablePomCount() > 0) {
      el.specBody.appendChild(buildVisibilityControlRow());
    }

    // Auto Mode: render the 18-row draft review section first.
    const draftPomKeys = new Set();
    // Construction summary renders whenever a detection exists — the TD
    // lands in Manual mode after Apply (ADR 0008) and still needs to see
    // what the detector recognized. No-op on pure manual projects.
    renderConstructionSummary();

    if (state.appMode === 'auto') {
      renderAutoReviewHeader();
      const drafts = state.autoMode.draftAnnotations
        .slice()
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const draft of drafts) {
        el.specBody.appendChild(buildDraftRow(draft));
        const draftKey = String(draft.text != null ? draft.text : draft.seq);
        if (draftKey) draftPomKeys.add(draftKey);
      }
    }

    // Panel is now pre-populated with the 18 POM template rows, so the
    // "No measurements yet" placeholder is redundant.
    el.specEmpty.style.display = 'none';

    // Lookup by effective POM label so each slot can find its annotation.
    const anns = state.annotations.slice();
    const annByPom = new Map();
    for (const ann of anns) annByPom.set(getLabelText(ann), ann);

    // Render one row per POM slot in POM order — every POM gets its own row,
    // including the band (1 & 2) and chest (3 & 4) pairs, which each show
    // their own description, 中文, TOL and Size L. Pairing still lives in the
    // rule data (it drives the POM 2/4 extension-stub geometry) but is no
    // longer merged into a single panel row. Uses the annotation when one
    // exists, else a template row so 中文 / TOL / Size L stay editable. In
    // Auto Mode, POMs covered by an outstanding draft skip their template row
    // so the draft review section is not duplicated.
    const renderedAnnIds = new Set();
    const templateOrder = Object.keys(POM_TEMPLATE).sort((a, b) => Number(a) - Number(b));
    for (const pomKey of templateOrder) {
      const ann = annByPom.get(pomKey) || null;
      if (ann) {
        el.specBody.appendChild(buildSingleSpecRow(ann));
        renderedAnnIds.add(ann.id);
      } else if (!draftPomKeys.has(pomKey)) {
        el.specBody.appendChild(buildTemplateSpecRow(pomKey));
      }
    }

    // Registered custom POMs (19+, US-011) render template-style rows right
    // after the core 18 — with or without a drawn line — so a TD can spec them
    // before drawing. A row with a line behaves exactly like a template POM.
    const customKeys = (state.customPoms || []).map(p => String(p.pom))
      .sort((a, b) => Number(a) - Number(b));
    for (const pomKey of customKeys) {
      const ann = annByPom.get(pomKey) || null;
      if (ann) {
        el.specBody.appendChild(buildSingleSpecRow(ann));
        renderedAnnIds.add(ann.id);
      } else if (!draftPomKeys.has(pomKey)) {
        const tr = buildTemplateSpecRow(pomKey);
        decorateCustomPomRow(tr, pomKey);
        el.specBody.appendChild(tr);
      }
    }

    // Any additional user-labeled annotations that fall outside 1..18
    // (unregistered custom labels, renamed labels) render after the template
    // block in POM-numerical order.
    const extras = anns
      .filter(a => !renderedAnnIds.has(a.id))
      .sort((a, b) => labelSortKey(a) - labelSortKey(b) || a.seq - b.seq);
    for (const ann of extras) {
      if (renderedAnnIds.has(ann.id)) continue;
      el.specBody.appendChild(buildSingleSpecRow(ann));
      renderedAnnIds.add(ann.id);
    }

    el.specBody.appendChild(buildAddPomRow());

    // Stored only after a COMPLETED rebuild — the focus-guard early return
    // above must never mark a skipped rebuild as up to date.
    lastSpecPanelFingerprint = fingerprint;
  }

  // Small × on a custom POM's template row: removing the registry entry is
  // only offered while no drawn line carries the number (a row with a line
  // renders as a normal annotation row, so this control never shows there).
  function decorateCustomPomRow(tr, pomKey) {
    tr.classList.add('custom-pom-row');
    const pomTd = tr.querySelector('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove custom POM ' + pomKey + ' (no line uses it)';
    removeBtn.style.cssText = 'margin-left:4px;border:0;background:none;color:#b91c1c;cursor:pointer;font-size:12px;';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.customPoms = (state.customPoms || []).filter(p => String(p.pom) !== String(pomKey));
      if (state.pomSpecs) delete state.pomSpecs[String(pomKey)];
      pushHistoryIfChanged();
      renderSpecPanel();
      showToast('Custom POM ' + pomKey + ' removed.');
    });
    pomTd.appendChild(removeBtn);
  }

  // Full-width "+ Add POM" row (US-011 S4): creates the next free number
  // (17, 18, …) with a TD-entered English name (中文 optional). The new POM
  // gets a template-style row with full Size L / L2 / TOL / grading / export
  // parity; the 18-POM rule JSON is never touched (ADR 0018).
  function buildAddPomRow() {
    const tr = document.createElement('tr');
    tr.className = 'add-pom-row';
    const td = document.createElement('td');
    td.colSpan = SPEC_COL_COUNT;
    td.style.cssText = 'text-align:center;padding:6px;';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'picker-btn';
    addBtn.textContent = '+ Add POM';
    addBtn.title = 'Add a style-specific POM beyond the standard 16';
    addBtn.addEventListener('click', () => {
      const nextNum = String(nextCustomPomNumber());
      td.innerHTML = '';
      const form = document.createElement('span');
      form.style.cssText = 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;';
      const label = document.createElement('span');
      label.textContent = 'POM ' + nextNum + ':';
      label.style.cssText = 'font-weight:600;font-size:12px;';
      const enInput = document.createElement('input');
      enInput.type = 'text';
      enInput.placeholder = 'Description - English (required)';
      enInput.style.cssText = 'width:220px;font-size:12px;padding:3px 6px;';
      const zhInput = document.createElement('input');
      zhInput.type = 'text';
      zhInput.placeholder = '中文 (optional)';
      zhInput.style.cssText = 'width:140px;font-size:12px;padding:3px 6px;';
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'picker-btn';
      okBtn.textContent = 'Add';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'picker-btn';
      cancelBtn.textContent = 'Cancel';
      okBtn.addEventListener('click', () => {
        const en = enInput.value.trim();
        if (!en) { showToast('Enter an English description for the new POM.'); enInput.focus(); return; }
        if (!Array.isArray(state.customPoms)) state.customPoms = [];
        state.customPoms.push({ pom: nextNum, en, zh: zhInput.value.trim() });
        pushHistoryIfChanged();
        renderSpecPanel();
        showToast('POM ' + nextNum + ' added — label a drawn line "' + nextNum + '" to measure it.');
      });
      cancelBtn.addEventListener('click', () => renderSpecPanel());
      enInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') okBtn.click(); });
      zhInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') okBtn.click(); });
      form.appendChild(label);
      form.appendChild(enInput);
      form.appendChild(zhInput);
      form.appendChild(okBtn);
      form.appendChild(cancelBtn);
      td.appendChild(form);
      enInput.focus();
    });
    td.appendChild(addBtn);
    tr.appendChild(td);
    return tr;
  }

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

  function appendSuggestBadge(td, text, cls, title) {
    const badge = document.createElement('div');
    badge.className = 'spec-conf spec-suggest-badge ' + cls;
    badge.textContent = text;
    if (title) badge.title = title;
    td.appendChild(badge);
  }

  // Decorate a Size L / TOL cell to show it holds a library suggestion (not a
  // TD entry): mute the input and, for Size L, add a "library · <confidence>"
  // provenance badge — or a "no data" badge for POMs with no corpus value
  // (15 back-straps distance, 16 front apex). Skipped once the TD overrides.
  function decorateSuggestedCell(td, pomKey, field) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    const sug = getPomSuggestion(key);
    if (!sug) return;
    const raw = (state.pomSpecs && state.pomSpecs[key]) || {};
    const hasOverride = raw[field] != null;
    if (hasOverride) return;

    if (field === 'sizeL' && !hasSuggestedValue(key)) {
      appendSuggestBadge(td, 'no data', 'very_low',
        'No library value for this POM — enter Size L manually.');
      return;
    }
    const suggested = field === 'sizeL' ? suggestedSizeL(key) : suggestedTol(key);
    if (!suggested) return;
    const input = td.querySelector('input');
    if (input) input.classList.add('is-suggested');
    if (field === 'sizeL') {
      // Mode B: a fused sketch measurement is a distinct, estimated suggestion.
      const m = measuredFor(key);
      if (m) {
        appendSuggestBadge(td, 'measured · ' + (m.confidence || 'low'), 'library',
          'Sketch measurement (Mode B, estimated) — detected anchors × view-local scale, fused toward the library median'
          + ' (k ' + m.k + ', residual ' + (Math.round((m.residual || 0) * 1000) / 10) + '%, library ' + m.library_in + ' in). Type to override.');
        return;
      }
      const conf = sug.confidence || 'very_low';
      const rangeIn = (sug.min != null && sug.max != null) ? ' · range ' + sug.min + '–' + sug.max + ' in' : '';
      appendSuggestBadge(td, 'library · ' + conf, 'library',
        'Library suggestion — median of ' + sug.n + ' Size-L samples' + rangeIn
        + ' · source: corpus. Type to override.');
    }
  }

  // Editable English Description cell (mirrors the 中文 column): a textarea
  // pre-filled with the built-in POM name, editable, with per-POM overrides
  // persisted in state.pomSpecs[pom].en. Used on both template and applied
  // rows so the TD can rename any POM's English term. `ann` (optional) links
  // focus to the annotation so clicking the field selects its line.
  function buildEnDescCell(pomKey, ann) {
    const td = document.createElement('td');
    const input = document.createElement('textarea');
    input.className = 'spec-desc';
    input.rows = 2;
    input.value = getPomSpec(pomKey).en;
    input.placeholder = builtinPomEn(pomKey) || '—';
    const refreshTitle = () => { input.title = input.value || input.placeholder || ''; };
    refreshTitle();
    if (ann) input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('input', refreshTitle);
    input.addEventListener('change', () => {
      if (setPomSpec(pomKey, 'en', input.value)) pushHistoryIfChanged();
      refreshTitle();
    });
    td.appendChild(input);
    return td;
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

  // Rich hover tooltip for a POM badge. Surfaces the JSON contract data
  // (view, required + optional anchors, expected confidence tier) so the
  // TD reviewing evidence can see at a glance what a POM is supposed to
  // depend on. Falls back to the standard description for anything not
  // in the POM_TEMPLATE (e.g. custom-labeled annotations).
  function getPomTooltip(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key) return '';
    const entry = POM_TEMPLATE && POM_TEMPLATE[key];
    if (!entry) return getPomInfo(key).desc || '';
    const bits = [];
    bits.push('POM ' + key + ' — ' + entry.desc);
    if (entry.viewRole) bits.push('View: ' + prettyView(entry.viewRole));
    if (Array.isArray(entry.requiredAnchors) && entry.requiredAnchors.length) {
      bits.push('Anchors: ' + entry.requiredAnchors.join(' ↔ '));
    }
    if (Array.isArray(entry.optionalAnchors) && entry.optionalAnchors.length) {
      bits.push('Optional: ' + entry.optionalAnchors.join(', '));
    }
    if (entry.expected_confidence_tier) {
      bits.push('Expected confidence: ' + entry.expected_confidence_tier);
    }
    return bits.join('\n');
  }

  function prettyView(viewRole) {
    if (viewRole === 'front_outer') return 'front outer';
    if (viewRole === 'front_inner') return 'front inner';
    if (viewRole === 'back') return 'back';
    return String(viewRole);
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

  function buildMeasuredValueCell(ann, pomKey) {
    const td = document.createElement('td');
    td.className = 'spec-td-value';
    const text = measuredValueText(ann);
    if (!text) {
      td.textContent = '—';
      td.title = 'No line drawn for this POM yet.';
      return td;
    }
    const measuredEl = document.createElement('span');
    measuredEl.className = 'spec-measured';
    measuredEl.textContent = text;
    td.appendChild(measuredEl);

    const unit = state.calibration.unit;
    const ev = evaluateSpecTolerance(ann, pomKey);
    if (ev.status) {
      const signed = (ev.delta > 0 ? '+' : ev.delta < 0 ? '−' : '±') + formatMeasure(Math.abs(ev.delta));
      const chip = document.createElement('span');
      chip.className = 'spec-delta spec-delta-' + (ev.status === 'in' ? 'in' : ev.status === 'out' ? 'out' : 'neutral');
      chip.textContent = specDeltaText(ev);
      td.appendChild(chip);
      if (ev.status === 'in') td.classList.add('spec-in');
      else if (ev.status === 'out') td.classList.add('spec-out');
      td.title = ev.status === 'delta'
        ? `Measured ${formatMeasure(ev.measured)} ${unit} · target ${formatMeasure(ev.target)} ${unit} · Δ ${signed} (no TOL set)`
        : `Measured ${formatMeasure(ev.measured)} ${unit} · target ${formatMeasure(ev.target)} ± ${formatMeasure(ev.tol)} ${unit} · Δ ${signed} · ${ev.status === 'in' ? 'in tolerance' : 'OUT of tolerance'}`;
    } else {
      td.title = state.calibration.unitsPerPx != null
        ? 'Measured from the line on the sketch. Enter Size L (+ TOL) to check tolerance.'
        : 'Measured length in pixels — use Set Scale to show real ' + state.calibration.unit + '.';
    }

    // Per-row calibration shortcut: because a line exists here (measuredValueText
    // was non-empty), the TD can set the board scale straight from this POM —
    // type its real length and every POM re-estimates. Reuses the Set Scale
    // engine (openScaleDialog), so it stays one global, undoable scale.
    const refPx = lineLength(ann);
    if (refPx > 0) {
      const entry = POM_TEMPLATE && POM_TEMPLATE[String(pomKey)];
      const refLabel = entry && entry.desc ? ('POM ' + pomKey + ' — ' + entry.desc) : null;
      const scaleBtn = document.createElement('button');
      scaleBtn.type = 'button';
      scaleBtn.className = 'spec-scale-ref';
      scaleBtn.textContent = '📏';
      scaleBtn.title = state.calibration.unitsPerPx == null
        ? 'Set scale from this line — type its real length and every POM switches to real units.'
        : 'Re-calibrate scale from this line — type its real length and every POM re-estimates.';
      scaleBtn.style.cssText = 'margin-left:6px;border:none;background:none;cursor:pointer;font-size:11px;line-height:1;padding:0;opacity:0.5;';
      scaleBtn.addEventListener('mouseenter', () => { scaleBtn.style.opacity = '1'; });
      scaleBtn.addEventListener('mouseleave', () => { scaleBtn.style.opacity = '0.5'; });
      scaleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openScaleDialog(refPx, refLabel);
      });
      td.appendChild(scaleBtn);
    }
    return td;
  }

  // Relationship hint so the split band/chest rows still show that POM 2/4
  // (Extend) are derived from POM 1/3 (Relax). Reads the pairing that still
  // drives the extension-stub geometry in the rule data.
  function pomPairHint(pomKey) {
    const entry = POM_TEMPLATE && POM_TEMPLATE[String(pomKey)];
    const pairing = entry && entry.pairing;
    if (!pairing) return '';
    if (pairing.role === 'primary') {
      return (pairing.primaryLabel || 'Primary') + ' · pairs with POM ' + pairing.partner;
    }
    if (pairing.role === 'secondary') {
      const primaryEntry = POM_TEMPLATE[String(pairing.primary)];
      const label = (primaryEntry && primaryEntry.pairing && primaryEntry.pairing.secondaryLabel) || 'Extend';
      return label + ' · derived from POM ' + pairing.primary;
    }
    return '';
  }

  function appendPairHint(descTd, pomKey) {
    const hint = pomPairHint(pomKey);
    if (!hint) return;
    const hintEl = document.createElement('div');
    hintEl.className = 'spec-pair-hint';
    hintEl.textContent = hint;
    descTd.appendChild(hintEl);
  }

  // Template row: no annotation exists yet for this POM. Shows the POM
  // number and description as read-only text plus editable Size L / TOL
  // cells so the TD can enter spec-sheet targets before drawing anything.
  function buildTemplateSpecRow(pomKey) {
    const tr = document.createElement('tr');
    tr.classList.add('template-row');
    tr.dataset.pomKey = pomKey;

    const pomTd = document.createElement('td');
    const pomBadge = document.createElement('span');
    pomBadge.className = 'spec-pom';
    pomBadge.textContent = pomKey;
    pomBadge.title = getPomTooltip(pomKey);
    pomTd.appendChild(pomBadge);
    appendVisibilityToggle(pomTd, {
      hidden: false,
      disabled: true,
      disabledTitle: 'Draw or apply a line labeled ' + pomKey + ' first.',
      onToggle: () => {},
    });

    const descTd = buildEnDescCell(pomKey, null);
    appendPairHint(descTd, pomKey);

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(buildSpecInputCell(pomKey, 'zh', ''));
    tr.appendChild(buildMeasuredValueCell(null, pomKey));
    const sizeTd = buildSpecInputCell(pomKey, 'sizeL', '');
    decorateSuggestedCell(sizeTd, pomKey, 'sizeL');
    tr.appendChild(sizeTd);
    tr.appendChild(buildSpecInputCell(pomKey, 'sizeL2', ''));
    const tolTd = buildSpecInputCell(pomKey, 'tol', '');
    decorateSuggestedCell(tolTd, pomKey, 'tol');
    tr.appendChild(tolTd);
    return tr;
  }

  // Standard one-annotation spec row
  // (POM | Description | 中文 | Value | Size L | TOL).
  function buildSingleSpecRow(ann) {
    const tr = document.createElement('tr');
    tr.dataset.annId = ann.id;
    const specKey = getLabelText(ann);
    tr.dataset.pomKey = specKey;
    if (state.selection.kind === 'annotation' && state.selection.id === ann.id) {
      tr.className = 'selected';
    }
    if (isAnnHidden(ann.id)) tr.classList.add('pom-hidden');
    tr.addEventListener('click', () => setSelection('annotation', ann.id));

    const { td: pomTd } = buildPomCell(ann);
    const descTd = buildEnDescCell(specKey, ann);
    appendPairHint(descTd, specKey);
    const zhTd = buildSpecInputCell(specKey, 'zh', '');
    const valueTd = buildMeasuredValueCell(ann, specKey);
    const sizeTd = buildSpecInputCell(specKey, 'sizeL', '');
    decorateSuggestedCell(sizeTd, specKey, 'sizeL');
    const sizeL2Td = buildSpecInputCell(specKey, 'sizeL2', '');
    const tolTd = buildSpecInputCell(specKey, 'tol', '');
    decorateSuggestedCell(tolTd, specKey, 'tol');

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(zhTd);
    tr.appendChild(valueTd);
    tr.appendChild(sizeTd);
    tr.appendChild(sizeL2Td);
    tr.appendChild(tolTd);
    return tr;
  }

  function buildPomCell(ann) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spec-pom';
    input.value = ann.text != null ? ann.text : '';
    input.placeholder = String(ann.seq);
    const refreshPomTooltip = () => {
      const key = input.value.trim() || String(ann.seq);
      const tip = getPomTooltip(key);
      input.title = tip || '';
      td.title = tip || '';
    };
    refreshPomTooltip();
    input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('input', refreshPomTooltip);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const next = v === '' ? null : v;
      if (ann.text !== next) { ann.text = next; pushHistoryIfChanged(); requestRender(); }
      refreshPomTooltip();
    });
    td.appendChild(input);
    appendVisibilityToggle(td, {
      hidden: isAnnHidden(ann.id),
      onToggle: () => toggleAnnHidden(ann.id),
    });
    // No metadata badges here (TD request 2026-07-10: the POM-number cell
    // shows only the number). Confidence/drawability/accepted state remain
    // visible in the Auto Mode draft-review rows.
    return { td, getValue: () => input.value.trim() };
  }

  function labelSortKey(ann) {
    const m = String(getLabelText(ann)).match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 9999;
  }

  function renderSpecCalNote() {
    let note = 'Label a callout with its <b>POM number</b> (e.g. 8) to auto-fill its description and standard size-L value. Values are editable per style.';
    if (state.appMode === 'auto') {
      const det = state.autoMode.detection;
      const anchors = state.autoMode.anchors;
      const drafts = state.autoMode.draftAnnotations;
      if (drafts.length > 0) {
        note = 'Auto Mode — <b>review drafts</b>: approve, mark review-only, or drag endpoints to edit. Then <i>Apply Approved Lines</i>.';
      } else if (anchors.length > 0 && state.autoMode.anchorsHidden) {
        note = '<b>Auto Mode — POM lines applied.</b> Anchors are hidden. Click <b>Reset Anchors</b> to show and re-tune them, or <b>Detect</b> to start over.';
      } else if (anchors.length > 0) {
        const edited = anchors.filter(a => !a.autoFilled).length;
        note = '<b>Auto Mode — anchors placed.</b> ' + anchors.length + ' anchors' +
          (edited > 0 ? ' (' + edited + ' adjusted)' : ' (all auto-seeded)') +
          '. Drag any that look wrong, then click <b>Generate POM Drafts</b>.';
      } else if (det) {
        const pct = (det.coverage * 100).toFixed(1);
        const features = [];
        features.push('band');
        if (det.chestY != null) features.push('chest');
        if (det.cradleY != null) features.push('cradle');
        if (det.sideLeftX != null) features.push('seam L');
        if (det.sideRightX != null) features.push('seam R');
        if (det.apexLeft) features.push('apex L');
        if (det.apexRight) features.push('apex R');
        if (det.strapTop && det.strapBottom) features.push('strap');
        if (det.back && det.back.top && det.back.bottom) features.push('back center');
        const sym = det.symmetry != null ? ' • sym ' + Math.round(det.symmetry * 100) + '%' : '';
        const fit = det.quality != null
          ? ' • fit ' + (det.quality >= 0.65 ? 'A' : (det.quality >= 0.40 ? 'B' : 'C'))
          : '';
        let views = '';
        if (det.viewBoxes && det.viewBoxes.length > 1) {
          const frontOuter = det.viewBoxes.find(v => v && (v.viewRole === 'front_outer' || v.role === 'front'));
          const frontInner = det.viewBoxes.find(v => v && v.viewRole === 'front_inner');
          const back  = det.viewBoxes.find(v => v && (v.viewRole === 'back' || v.role === 'back'));
          if (frontOuter && back && frontInner) {
            views = ' • front outer + back + front inner identified';
          } else if (frontOuter && back) {
            views = ' • front outer + back identified';
          } else if (frontOuter) {
            views = ' • ' + det.viewBoxes.length + ' views, front outer identified';
          } else {
            views = ' • ' + det.viewBoxes.length + ' views, using #' + ((det.primaryViewIndex || 0) + 1);
          }
          if (det.viewRoleReviewRequired) views += ' • roles need review';
        }
        note = '<b>Auto Mode — detected sketch.</b> ' + det.sampleWidth + '×' + det.sampleHeight +
          ' • local offline vision' + views + ' • ' + pct + '% coverage' + sym + fit +
          (det.durationMs != null ? ' • ' + det.durationMs + 'ms' : '') +
          '<br><span class="muted">Features: ' + features.join(', ') +
          '</span>. Next: drag any wrong anchors, then <i>Generate POM Drafts</i>.';
      } else {
        note = 'Auto Mode — click <b>Detect Sketch</b> to estimate the bra shape, then anchors, then POM drafts.';
      }
    }
    // Scale status applies in every mode, so append it last — the Auto Mode
    // branch above rebuilds `note` from scratch and would otherwise drop it.
    if (state.calibration.unitsPerPx != null) {
      note += ' <b>Scale set</b> — Value shown in <b>' + state.calibration.unit + '</b>.';
    } else {
      note += ' <span class="muted">Value in px — use <b>Set Scale</b> for real units.</span>';
    }
    el.specCal.innerHTML = note;
  }

  // Read-only "Detected from sketch" summary (v1). Surfaces the construction
  // facts the detector already knows — detected views, the front-closure
  // placket signature (ADR 0023 junction tier), the cup model, and how many
  // anchors are flagged for review — so the TD sees what the tool recognized
  // before reading the 18 draft rows. Display-only in this slice; confirming
  // these as library style-feature evidence (LIBRARY_CONSTRUCTION_TAXONOMY.md
  // Tier A) is a later slice. Absence of the placket signature is reported as
  // "not found", never as a claim about the back closure.
  // ---- US-038: Anchors visibility manager (its OWN floating panel) -------
  // Deliberately NOT part of the Measurements panel: measurements are the
  // exported spec; anchors are a testing / accuracy-checking aid that never
  // exports. The panel floats over the board (non-modal) and is opened from
  // the Auto toolbar "Anchors" button. Offers Hide all / Show all, per-group
  // hide, per-anchor hide, and Isolate ("show only one"); a row click selects
  // the pin on the canvas.

  function anchorGroupLabel(group) {
    const map = {
      axis: 'Center / cradle', band: 'Band', chest: 'Chest', 'inner-cup': 'Cup',
      side: 'Side seam', apex: 'Apex', strap: 'Straps', back: 'Back',
      neckline: 'Neckline (17)', armhole: 'Armhole (18)',
    };
    return map[group] || group;
  }

  function anchorMiniBtn(label, title, onClick, extraCss) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'border:1px solid #cbd5e1;background:#fff;border-radius:5px;'
      + 'cursor:pointer;font-size:11px;line-height:1;padding:2px 6px;color:#334155;'
      + (extraCss || '');
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function isAnchorManagerOpen() {
    return !!(el.anchorManagerPanel && !el.anchorManagerPanel.hidden);
  }

  // Toolbar entry point: open the floating anchor panel (Auto Mode only).
  function openAnchorManager() {
    if (state.appMode !== 'auto') {
      showToast('Anchor management is available in Auto Mode.');
      return;
    }
    if (!state.autoMode.anchors.length) {
      showToast('Run Detect Sketch first to place anchors.');
      return;
    }
    if (!el.anchorManagerPanel) return;
    el.anchorManagerPanel.hidden = false;
    if (el.autoManageAnchorsBtn) el.autoManageAnchorsBtn.classList.add('active');
    renderAnchorManagerPanel();
  }

  function closeAnchorManager() {
    if (!el.anchorManagerPanel) return;
    el.anchorManagerPanel.hidden = true;
    if (el.autoManageAnchorsBtn) el.autoManageAnchorsBtn.classList.remove('active');
  }

  function toggleAnchorManager() {
    if (isAnchorManagerOpen()) closeAnchorManager();
    else openAnchorManager();
  }

  // Rebuild the floating panel body from the current anchor set + hidden
  // state. Called on open, on every in-panel action, and from updateUI while
  // open (so a fresh Detect / canvas pin selection stays in sync).
  function renderAnchorManagerPanel() {
    const panel = el.anchorManagerPanel;
    const body = el.anchorManagerBody;
    if (!panel || !body) return;
    // Anchors only exist in Auto Mode; auto-close if we left it or lost them.
    if (state.appMode !== 'auto' || !state.autoMode.anchors.length) {
      closeAnchorManager();
      return;
    }
    const anchors = state.autoMode.anchors;
    const nameByKind = Object.create(null);
    const groupByKind = Object.create(null);
    const groupOrder = [];
    for (const schema of ANCHOR_SCHEMA) {
      nameByKind[schema.kind] = schema.name || schema.kind;
      groupByKind[schema.kind] = schema.group || 'other';
      if (groupOrder.indexOf(schema.group) === -1) groupOrder.push(schema.group);
    }
    const hidden = (k) => isAnchorHidden(k);
    const visibleCount = anchors.filter(a => !hidden(a.kind)).length;
    if (el.anchorManagerCount) {
      el.anchorManagerCount.textContent = visibleCount + '/' + anchors.length + ' shown';
    }

    body.innerHTML = '';
    for (const group of groupOrder) {
      const groupAnchors = anchors.filter(a => groupByKind[a.kind] === group);
      if (!groupAnchors.length) continue;
      const groupKinds = groupAnchors.map(a => a.kind);
      const groupAllHidden = groupKinds.every(hidden);

      const gRow = document.createElement('div');
      gRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;'
        + 'font-size:11.5px;color:#475569;background:#f8fafc;border-top:1px solid #eef2f7;';
      const gName = document.createElement('span');
      gName.style.fontWeight = '600';
      gName.textContent = anchorGroupLabel(group) + ' (' + groupAnchors.length + ')';
      gRow.appendChild(gName);
      const gSpacer = document.createElement('span'); gSpacer.style.flex = '1'; gRow.appendChild(gSpacer);
      gRow.appendChild(anchorMiniBtn(groupAllHidden ? 'Show' : 'Hide',
        groupAllHidden ? 'Show this group' : 'Hide this group',
        () => { toggleAnchorGroup(groupKinds); renderAnchorManagerPanel(); }));
      body.appendChild(gRow);

      for (const anchor of groupAnchors) {
        const isHidden = hidden(anchor.kind);
        const aRow = document.createElement('div');
        aRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px 4px 22px;'
          + 'font-size:12px;border-top:1px solid #f4f6fa;'
          + (state.autoMode.anchorSelectedId === anchor.id ? 'background:#eff6ff;' : '')
          + (isHidden ? 'opacity:.5;' : '');
        const dot = document.createElement('span');
        dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;'
          + 'background:' + anchorFillForConfidence(anchor.confidence) + ';'
          + 'border:1px solid rgba(15,23,42,.5);';
        aRow.appendChild(dot);
        const aName = document.createElement('span');
        aName.textContent = nameByKind[anchor.kind] || anchor.kind;
        aName.style.cssText = 'color:#0f172a;cursor:pointer;';
        aName.title = anchor.name + ' — click to select on the sketch';
        aRow.appendChild(aName);
        if (anchor.reviewRequired) {
          const flag = document.createElement('span');
          flag.textContent = 'review';
          flag.style.cssText = 'font-size:10px;color:#b45309;background:#fffbeb;'
            + 'border:1px solid #fde68a;border-radius:4px;padding:0 4px;';
          aRow.appendChild(flag);
        }
        const aSpacer = document.createElement('span'); aSpacer.style.flex = '1'; aRow.appendChild(aSpacer);
        aRow.appendChild(anchorMiniBtn('◎', 'Isolate — show only this anchor',
          () => { isolateAnchor(anchor.kind); renderAnchorManagerPanel(); }));
        aRow.appendChild(anchorMiniBtn(isHidden ? '+' : '×',
          isHidden ? 'Show this anchor' : 'Hide this anchor',
          () => { toggleAnchorHidden(anchor.kind); renderAnchorManagerPanel(); },
          isHidden ? 'color:#2563eb;' : 'color:#b91c1c;'));
        aName.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isHidden) return;
          state.autoMode.anchorSelectedId = anchor.id;
          updateUI();
          requestRender();
          renderAnchorManagerPanel();
        });
        body.appendChild(aRow);
      }
    }
  }

  function renderConstructionSummary() {
    const det = state.autoMode.detection;
    if (!det) return;

    const parts = [];

    const roleLabels = { front_outer: 'front outer', front_inner: 'front inner', back: 'back' };
    const seen = [];
    for (const v of (Array.isArray(det.views) ? det.views : [])) {
      const label = roleLabels[v && (v.viewRole || v.role)];
      if (label && !seen.includes(label)) seen.push(label);
    }
    if (seen.length) {
      parts.push('<b>Views:</b> ' + escapeHtml(seen.join(' + '))
        + (det.viewRoleReviewRequired
          ? ' <span style="color:#b45309;font-weight:600">— roles need review</span>' : ''));
    }

    parts.push('<b>Closure:</b> ' + (det.cradleCfTopJunction
      ? 'front-closure signature (placket interrupts the CF seam) — '
        + '<span style="color:#b45309;font-weight:600">confirm</span>'
      : 'no front-closure signature found'));

    const cm = det.cupModel;
    if (cm) {
      const bits = [cm.side === 1 ? 'right cup' : (cm.side === -1 ? 'left cup' : 'cup')];
      if (cm.visibility) bits.push(cm.visibility + ' visibility');
      if (typeof cm.contourConfidence === 'number') bits.push('contour ' + cm.contourConfidence.toFixed(2));
      if (typeof cm.seamConfidence === 'number') bits.push('seam ' + cm.seamConfidence.toFixed(2));
      parts.push('<b>Cup:</b> ' + escapeHtml(bits.join(' · ')));
    }

    const anchors = state.autoMode.anchors;
    if (anchors.length) {
      const revCount = anchors.filter(a => a && a.reviewRequired).length;
      parts.push('<b>Anchors:</b> ' + (revCount ? revCount + ' flagged for review' : 'none flagged'));
    }

    const tr = document.createElement('tr');
    tr.className = 'draft-row';
    tr.style.background = 'transparent';
    const td = document.createElement('td');
    td.colSpan = SPEC_COL_COUNT;
    td.innerHTML = '<div class="construction-summary" style="background:#f0f9ff;'
      + 'border:1px solid #bae6fd;color:#0c4a6e;border-radius:6px;padding:6px 8px;'
      + 'margin:4px 0;font-size:12px;line-height:1.5">'
      + '<b>Detected from sketch</b><br>' + parts.join('<br>')
      + '</div>';
    tr.appendChild(td);
    el.specBody.appendChild(tr);
  }

  function renderAutoReviewHeader() {
    const auto = state.autoMode;
    const drafts = auto.draftAnnotations;
    const hasDrafts = drafts.length > 0;
    const hasErrors = !!(auto.validation && auto.validation.errors && auto.validation.errors.length);
    const hasWarnings = !!(auto.validation && auto.validation.warnings && auto.validation.warnings.length);
    const hasLastError = !!auto.lastError;
    // Nothing to review and nothing to report — skip the section entirely so
    // the applied board isn't cluttered with an empty "0 rows" header.
    if (!hasDrafts && !hasErrors && !hasWarnings && !hasLastError) return;

    const approvable = drafts.filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
    const highApprovable = approvable.filter(d => d.confidence === 'high');
    const approved = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const reviewOnly = drafts.filter(d => isReviewOnlyDraft(d)).length;

    const headerTr = document.createElement('tr');
    headerTr.className = 'draft-row';
    headerTr.style.background = 'transparent';
    const headerTd = document.createElement('td');
    headerTd.colSpan = SPEC_COL_COUNT;
    // Draft-review summary + bulk actions only when drafts are outstanding;
    // the error / warning blocks below render on their own.
    let html = '';
    if (hasDrafts) {
      html += '<div class="auto-review-head">' +
        '<b>Auto Mode draft review</b> — ' + drafts.length + ' row' + (drafts.length === 1 ? '' : 's') + ' • ' +
        approved + ' approved • ' + reviewOnly + ' review-only' +
        (auto.runId ? '<br><span style="font-weight:400">Run: ' + auto.runId + '</span>' : '') +
        '<div class="auto-review-bulk">' +
          '<button type="button" class="auto-bulk-btn" data-bulk="approve-all"' +
            (approvable.length === 0 ? ' disabled' : '') + '>' +
            'Approve all (' + approvable.length + ')' +
          '</button>' +
          '<button type="button" class="auto-bulk-btn" data-bulk="approve-high"' +
            (highApprovable.length === 0 ? ' disabled' : '') + '>' +
            'Approve high-confidence (' + highApprovable.length + ')' +
          '</button>' +
        '</div>' +
        '</div>';
    }

    if (auto.validation && auto.validation.errors && auto.validation.errors.length) {
      html += '<div class="auto-review-errors"><b>Validation errors</b><ul>' +
        auto.validation.errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.validation && auto.validation.warnings && auto.validation.warnings.length) {
      html += '<div class="auto-review-errors" style="background:#fffbeb;border-color:#fde68a;color:#854d0e"><b>Warnings</b><ul>' +
        auto.validation.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.lastError) {
      html += '<div class="auto-review-errors"><b>Last error</b><br>' +
        escapeHtml(auto.lastError) + '</div>';
    }
    headerTd.innerHTML = html;
    headerTd.querySelectorAll('[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.getAttribute('data-bulk');
        const targets = mode === 'approve-high' ? highApprovable : approvable;
        if (targets.length === 0) return;
        for (const d of targets) approveDraftAnnotation(d);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        showToast('Approved ' + targets.length + ' draft' + (targets.length === 1 ? '' : 's') + '.');
      });
    });
    headerTr.appendChild(headerTd);
    el.specBody.appendChild(headerTr);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildDraftRow(draft) {
    const tr = document.createElement('tr');
    tr.dataset.draftId = draft.id;
    tr.classList.add('draft-row');
    if (isReviewOnlyDraft(draft)) tr.classList.add('review-only');
    if (draft.tdApproved) tr.classList.add('approved');
    if (state.selection.kind === 'draft' && state.selection.id === draft.id) {
      tr.classList.add('selected');
    }
    if (isDraftHidden(draft.id)) tr.classList.add('pom-hidden');
    tr.addEventListener('click', () => setSelection('draft', draft.id));

    const pomTd = document.createElement('td');
    const pomLabel = document.createElement('span');
    const draftKey = draft.text != null ? String(draft.text) : String(draft.seq);
    pomLabel.textContent = draftKey;
    pomLabel.style.fontWeight = '700';
    pomLabel.title = getPomTooltip(draftKey);
    pomTd.appendChild(pomLabel);
    appendVisibilityToggle(pomTd, {
      hidden: isDraftHidden(draft.id),
      onToggle: () => toggleDraftHidden(draft.id),
    });
    const status = document.createElement('span');
    status.className = 'draft-status';
    if (isReviewOnlyDraft(draft)) status.textContent = 'Review-only';
    else if (draft.tdApproved) status.textContent = 'Approved';
    else if (draft.tdEdited) status.textContent = 'Edited';
    else status.textContent = draft.drawability === 'APPROXIMATE' ? 'Approx' : 'Draft';
    pomTd.appendChild(status);

    const descTd = document.createElement('td');
    const descBody = document.createElement('div');
    descBody.className = 'spec-desc-text';
    const standardDesc = getPomInfo(draft.text || draft.seq).desc || '—';
    descBody.textContent = standardDesc;
    descBody.title = standardDesc;
    descTd.appendChild(descBody);
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10.5px;color:#6b7280;margin-top:2px;line-height:1.35';
    const metaBits = [];
    if (draft.confidence) metaBits.push('conf: ' + draft.confidence);
    if (draft.reason) metaBits.push(draft.reason);
    if (draft.uncertainty && isReviewOnlyDraft(draft)) metaBits.push(draft.uncertainty);
    // Phase 7: the landmark-QA explanations behind a review-only demotion
    // (missing seam, no back view, inferred cup, …) so the TD sees the "why"
    // without opening the debug payload.
    if (isReviewOnlyDraft(draft) && Array.isArray(draft.reviewNotes)) {
      for (const note of draft.reviewNotes) metaBits.push(note);
    }
    if (metaBits.length) meta.textContent = metaBits.join(' • ');
    descTd.appendChild(meta);

    const actionsTd = document.createElement('td');
    actionsTd.colSpan = SPEC_COL_COUNT - 2;
    actionsTd.style.cssText = 'white-space:nowrap';

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.textContent = draft.tdApproved ? 'Approved' : 'Approve';
    approveBtn.disabled = isReviewOnlyDraft(draft) || draft.tdApproved;
    approveBtn.style.cssText = 'padding:3px 8px;font-size:11px;margin-right:4px';
    approveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      approveDraftAnnotation(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(approveBtn);

    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.textContent = 'R/O';
    reviewBtn.title = 'Mark this row REVIEW_ONLY';
    reviewBtn.disabled = isReviewOnlyDraft(draft);
    reviewBtn.style.cssText = 'padding:3px 8px;font-size:11px';
    reviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      markDraftReviewOnly(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(reviewBtn);

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(actionsTd);
    return tr;
  }

  function blurActivePanelField() {
    // Drop focus off any input/button inside the spec panel so the next
    // renderSpecPanel pass is free to rebuild rows (Approve / R/O state).
    const active = document.activeElement;
    if (active && el.specBody.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
  }

  // US-028: live measured value. While an endpoint is dragged or key-nudged,
  // replace just that line's Value cell — a full renderSpecPanel rebuild per
  // mousemove/keystroke would steal focus from other panel fields and is
  // needlessly heavy. buildMeasuredValueCell keeps value, tolerance chip,
  // tooltip, and the 📏 re-calibrate button in one code path. The commit-time
  // renderSpecPanel (via pushHistoryIfChanged → updateUI) stays the backstop.
  function refreshMeasuredValueForAnnotation(annId) {
    const ann = state.annotations.find(a => a.id === annId) || null;
    if (!ann) return; // Auto-Mode drafts have no annotation spec row — no-op.
    const tr = el.specBody.querySelector('tr[data-ann-id="' + ann.id + '"]');
    if (!tr) return;
    const oldTd = tr.querySelector('.spec-td-value');
    if (!oldTd) return;
    tr.replaceChild(buildMeasuredValueCell(ann, getLabelText(ann)), oldTd);
  }

  function updateSpecHighlightOnly() {
    const rows = el.specBody.querySelectorAll('tr');
    rows.forEach((tr) => {
      const selId = state.selection.kind === 'annotation' ? String(state.selection.id) : null;
      const isAnnSel = selId != null
        && (selId === tr.dataset.annId || selId === tr.dataset.pairAnnId);
      const isDraftSel = state.selection.kind === 'draft' && String(state.selection.id) === tr.dataset.draftId;
      tr.classList.toggle('selected', isAnnSel || isDraftSel);
    });
  }

