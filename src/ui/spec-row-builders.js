// Row and cell DOM builders for the Measurements table: the suggestion badge
// decoration, the English-description / POM / measured-value cells, the
// pairing hint, the template and annotation row shapes, and the custom-POM
// (US-011) remove control + "+ Add POM" row.
// Extracted from src/ui/spec-panel.js; the values these cells display come
// from src/ui/spec-values.js, the × / + toggle from src/ui/spec-visibility.js,
// and the orchestrator that assembles the rows stays in src/ui/spec-panel.js.
//
// NOTE: renderSpecPanel's focus-preservation guard decides what is "mid-edit
// safe" during a rebuild from three row selectors — tr[data-ann-id],
// tr[data-pom-key] and tr.add-pom-row. A row built here that matches none of
// them will have a TD's half-typed value blown away by the next rebuild, so
// keep those class / data-attribute names in sync with that guard.
// Source part for app.js. Run `npm run build` after editing.

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
        openScaleDialog(refPx, refLabel, ann.id);
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
