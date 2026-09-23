// Grading dialog (US-011 S3): view and edit the grade rule inside the tool.
// One row per POM (the 18 + any custom POMs), one column per size. Cells show
// the EFFECTIVE per-size delta — per-size TD override, else constant-step
// override (Size Run dialog), else the built-in SPEC_* tables — and edits
// write per-size overrides into gradeRules v2 (stored in inches). The L
// column is the alpha base (always 0); the L2 column edits the L2−L offset
// (gradeRules.depthOffsets, project unit). Source part for app.js — run
// `npm run build` after editing. SPEC_* tables live in export-xlsx.js and
// are referenced at call time only (shared IIFE scope).

  // Fraction parsing/formatting for grade deltas. fractionToNumber
  // (spec-panel.js) rejects negatives; deltas are frequently negative, so the
  // dialog has its own signed parser and a formatter that renders clean
  // fractions ("-1 1/4") and falls back to decimals for oddballs.
  function gradeDeltaToNumber(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const neg = raw.startsWith('-');
    const body = raw.replace(/^[+-]/, '').trim();
    // STRICT shapes only — fractionToNumber's parseFloat fallback would
    // silently truncate typos ("3 /4" → 3, a 4× grade error). Accept exactly:
    // decimal, fraction a/b, or mixed "w a/b" (single space).
    let n = null;
    let m;
    if ((m = body.match(/^(\d+)\s+(\d+)\/(\d+)$/))) {
      const den = parseInt(m[3], 10);
      if (den > 0) n = parseInt(m[1], 10) + parseInt(m[2], 10) / den;
    } else if ((m = body.match(/^(\d+)\/(\d+)$/))) {
      const den = parseInt(m[2], 10);
      if (den > 0) n = parseInt(m[1], 10) / den;
    } else if (/^\d*\.?\d+$/.test(body)) {
      n = parseFloat(body);
    }
    if (n == null || !isFinite(n)) return null;
    return neg ? -n : n;
  }

  function numberToGradeFraction(value) {
    if (value == null || !isFinite(value)) return '';
    const sign = value < 0 ? '-' : '';
    let v = Math.abs(Math.round(value * 10000) / 10000);
    const whole = Math.floor(v);
    const frac = v - whole;
    if (frac < 1e-9) return sign + String(whole);
    // Try the sewing-friendly denominators; fall back to a plain decimal.
    for (const den of [2, 4, 8, 16]) {
      const num = Math.round(frac * den);
      if (num > 0 && Math.abs(frac - num / den) < 1e-9) {
        const fracText = num + '/' + den;
        return sign + (whole ? whole + ' ' + fracText : fracText);
      }
    }
    return sign + String(v);
  }

  // Effective delta for a cell, in the PROJECT UNIT (what the sheet shows).
  // tier 1: delta vs Size L. tier 2 (except L2): delta vs L2.
  function effectiveGradeDeltaUnit(pomKey, col) {
    const key = String(pomKey);
    const unitScale = inchesToUnit(state.calibration.unit);
    const perSize = getPerSizeGradeDelta(col.tier, key, col.label);
    if (perSize != null) return perSize * unitScale;
    const rule = getGradeRule(key);
    if (rule.hold) return 0;
    const baseIdx = GRADE_SIZES.indexOf(GRADE_BASE_SIZE);
    if (col.tier === 1) {
      const alphaDeltas = SPEC_ALPHA_DELTA_L_IN[key] || null;
      const i = GRADE_SIZES.indexOf(col.label);
      if (rule.overridden || !alphaDeltas) return (i - baseIdx) * rule.step;
      return alphaDeltas[i] * unitScale;
    }
    const depthDeltas = SPEC_DEPTH_DELTA_L2_IN[key] || null;
    const depthLabels = SPEC_SIZE_RUN.filter(c => c.tier === 2).map(c => c.label);
    if (rule.overridden || !depthDeltas) {
      return (GRADE_SIZES.indexOf(col.base) - baseIdx) * rule.step;
    }
    return depthDeltas[depthLabels.indexOf(col.label)] * unitScale;
  }

  // Built-in (house default) delta for a cell, in the project unit — the
  // value "Reset to standard" restores and the reference for deciding
  // whether an edit is an override at all.
  function builtinGradeDeltaUnit(pomKey, col) {
    const key = String(pomKey);
    const unitScale = inchesToUnit(state.calibration.unit);
    const house = HOUSE_GRADE_INCHES[key] || { step: 0, hold: false };
    if (house.hold) return 0;
    if (col.tier === 1) {
      const alphaDeltas = SPEC_ALPHA_DELTA_L_IN[key] || null;
      const i = GRADE_SIZES.indexOf(col.label);
      const baseIdx = GRADE_SIZES.indexOf(GRADE_BASE_SIZE);
      if (!alphaDeltas) return (i - baseIdx) * house.step * unitScale;
      return alphaDeltas[i] * unitScale;
    }
    const depthDeltas = SPEC_DEPTH_DELTA_L2_IN[key] || null;
    const depthLabels = SPEC_SIZE_RUN.filter(c => c.tier === 2).map(c => c.label);
    const baseIdx = GRADE_SIZES.indexOf(GRADE_BASE_SIZE);
    if (!depthDeltas) return (GRADE_SIZES.indexOf(col.base) - baseIdx) * house.step * unitScale;
    return depthDeltas[depthLabels.indexOf(col.label)] * unitScale;
  }

  function ensureGradeRulesV2() {
    if (!state.gradeRules || state.gradeRules.version !== 2) {
      state.gradeRules = migrateGradeRulesV2(state.gradeRules, null);
    }
    return state.gradeRules;
  }

  function gradingPomKeys() {
    const template = Object.keys(POM_TEMPLATE).sort((a, b) => Number(a) - Number(b));
    const custom = (state.customPoms || []).map(p => String(p.pom))
      .sort((a, b) => Number(a) - Number(b));
    return template.concat(custom);
  }

  function openGradingDialog() {
    const dlg = buildDialog({
      title: 'Grading rules',
      sub: 'Per-size deltas: alpha sizes vs Size L, depth sizes vs L2. The L2 column is the L2−L offset. Edits are saved with the project.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.style.cssText = 'max-height:60vh;overflow:auto;min-width:720px;';

    const unit = state.calibration.unit || 'in';
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;font-size:11px;width:100%;';

    const renderTable = () => {
      const rules = ensureGradeRulesV2();
      const rows = ['<tr><th style="position:sticky;top:0;background:#f2f2f2;padding:4px 6px;text-align:left;">POM</th>'
        + SPEC_SIZE_RUN.map(c => '<th style="position:sticky;top:0;background:'
          + (c.tier === 1 ? '#fcd5b4' : '#c4d79b') + ';padding:4px 6px;">' + escapeHtml(c.label) + '</th>').join('')
        + '<th style="position:sticky;top:0;background:#f2f2f2;"></th></tr>'];
      for (const key of gradingPomKeys()) {
        const custom = (state.customPoms || []).find(p => String(p.pom) === key);
        const name = custom ? (custom.en || 'Custom POM')
          : ((POM_TEMPLATE[key] && POM_TEMPLATE[key].name) || '');
        const cells = SPEC_SIZE_RUN.map(col => {
          if (col.tier === 1 && col.label === GRADE_BASE_SIZE) {
            return '<td style="border:1px solid #ddd;padding:2px;text-align:center;color:#999;">base</td>';
          }
          if (col.label === 'L2') {
            const off = getDepthRule(key);
            const overridden = off.overridden;
            return '<td style="border:1px solid #ddd;padding:0;">'
              + '<input data-pom="' + escapeHtml(key) + '" data-size="L2" data-kind="offset" value="'
              + escapeHtml(numberToGradeFraction(off.offset)) + '" title="L2 − L offset'
              + (overridden ? ' (TD override)' : ' (standard)') + '"'
              + ' style="width:52px;border:0;padding:3px 4px;text-align:center;'
              + (overridden ? 'background:#fff3d6;font-weight:600;' : '') + '"/></td>';
          }
          const eff = effectiveGradeDeltaUnit(key, col);
          const overridden = getPerSizeGradeDelta(col.tier, key, col.label) != null;
          const provenance = (key === '7' && col.label === '4XL2' && !overridden)
            ? ' — interpolated standard value, TD to confirm' : '';
          return '<td style="border:1px solid #ddd;padding:0;">'
            + '<input data-pom="' + escapeHtml(key) + '" data-size="' + escapeHtml(col.label)
            + '" data-kind="' + (col.tier === 1 ? 'alpha' : 'depth') + '" value="'
            + escapeHtml(numberToGradeFraction(eff)) + '" title="'
            + (overridden ? 'TD override' : 'standard') + provenance + '"'
            + ' style="width:52px;border:0;padding:3px 4px;text-align:center;'
            + (overridden ? 'background:#fff3d6;font-weight:600;' : '') + '"/></td>';
        }).join('');
        rows.push('<tr><td style="border:1px solid #ddd;padding:3px 6px;white-space:nowrap;" title="'
          + escapeHtml(name) + '">' + escapeHtml(key) + '</td>' + cells
          + '<td style="border:1px solid #ddd;padding:0;"><button type="button" class="picker-btn" data-reset="'
          + escapeHtml(key) + '" style="font-size:10px;padding:2px 6px;" title="Restore this POM to the standard rule">Reset</button></td></tr>');
        void rules;
      }
      table.innerHTML = rows.join('');
    };

    const commitCell = (input) => {
      const key = String(input.dataset.pom);
      const size = input.dataset.size;
      const kind = input.dataset.kind;
      const rules = ensureGradeRulesV2();
      const unitScale = inchesToUnit(state.calibration.unit);
      const trimmed = String(input.value).trim();
      // Empty = "back to standard" for this cell (delete the override).
      // Pinning a size flat is an explicit act: type 0.
      if (trimmed === '') {
        if (kind === 'offset') delete rules.depthOffsets[key];
        else {
          const bucket = kind === 'alpha' ? rules.alpha : rules.depth;
          if (bucket[key]) { delete bucket[key][size]; if (!Object.keys(bucket[key]).length) delete bucket[key]; }
        }
        pushHistoryIfChanged();
        renderTable();
        if (typeof renderSpecPanel === 'function') renderSpecPanel();
        return;
      }
      const parsed = gradeDeltaToNumber(trimmed);
      if (parsed == null) {
        showToast('Could not read "' + input.value + '" — use a number or fraction like -1 1/4.', 3600);
        renderTable();
        return;
      }
      const valueUnit = parsed;
      if (kind === 'offset') {
        const house = (SPEC_DEPTH_OFFSET_IN[key] || 0) * unitScale;
        if (Math.abs(valueUnit - house) < 1e-9) delete rules.depthOffsets[key];
        else rules.depthOffsets[key] = { offset: valueUnit };
      } else {
        const bucket = kind === 'alpha' ? rules.alpha : rules.depth;
        const builtin = builtinGradeDeltaUnit(key, SPEC_SIZE_RUN.find(c => c.label === size));
        if (Math.abs(valueUnit - builtin) < 1e-9) {
          if (bucket[key]) { delete bucket[key][size]; if (!Object.keys(bucket[key]).length) delete bucket[key]; }
        } else {
          if (!bucket[key]) bucket[key] = {};
          bucket[key][size] = valueUnit / unitScale;   // stored in inches
        }
      }
      pushHistoryIfChanged();
      renderTable();
      if (typeof renderSpecPanel === 'function') renderSpecPanel();
    };

    table.addEventListener('change', (ev) => {
      const input = ev.target.closest('input[data-pom]');
      if (input) commitCell(input);
    });
    table.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-reset]');
      if (!btn) return;
      const key = String(btn.dataset.reset);
      const rules = ensureGradeRulesV2();
      delete rules.alpha[key];
      delete rules.depth[key];
      delete rules.depthOffsets[key];
      delete rules.steps[key];
      pushHistoryIfChanged();
      renderTable();
      showToast('POM ' + key + ' grading reset to the standard rule.');
    });

    body.appendChild(table);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    footer.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const note = document.createElement('span');
    note.style.cssText = 'font-size:11px;color:#666;flex:1;';
    note.textContent = 'Values in ' + unit + '. Highlighted cells are TD overrides; they drive the Excel export formulas.';
    const resetAllBtn = document.createElement('button');
    resetAllBtn.type = 'button';
    resetAllBtn.className = 'picker-btn';
    resetAllBtn.textContent = 'Reset all to standard';
    resetAllBtn.addEventListener('click', () => {
      if (!window.confirm('Discard every grading override and restore the standard rule?')) return;
      state.gradeRules = makeEmptyGradeRulesV2();
      pushHistoryIfChanged();
      renderTable();
      showToast('All grading rules reset to standard.');
    });
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'picker-btn picker-btn-primary';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => dlg.close());
    footer.appendChild(note);
    footer.appendChild(resetAllBtn);
    footer.appendChild(doneBtn);

    renderTable();
    dlg.panel.appendChild(body);
    dlg.panel.appendChild(footer);
    dlg.open();
  }
