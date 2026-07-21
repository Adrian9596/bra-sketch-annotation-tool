// Export size picker (US-011 S2). Opens from Export Excel: checkboxes for
// every SPEC_SIZE_RUN column (grouped alpha / depth) with one-click presets.
// The choice persists in state.sizeSelection (null = all sizes) so the next
// export starts from the same subset. Source part for app.js — run
// `npm run build` after editing. Loads before export-xlsx.js; SPEC_SIZE_RUN
// is referenced at call time only (shared IIFE scope).

  // The size columns Export Excel emits, honouring state.sizeSelection.
  // null / malformed selection → the full run (back-compat default).
  function selectedSizeRun() {
    const sel = state.sizeSelection;
    if (!sel || typeof sel !== 'object') return SPEC_SIZE_RUN.slice();
    const alpha = Array.isArray(sel.alpha) ? sel.alpha : [];
    const depth = Array.isArray(sel.depth) ? sel.depth : [];
    return SPEC_SIZE_RUN.filter(c => (c.tier === 1 ? alpha : depth).includes(c.label));
  }

  function openExportSizeDialog(onConfirm) {
    const dlg = buildDialog({
      title: 'Export sizes',
      sub: 'Choose which size columns the Excel spec includes.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;min-width:420px;';

    const current = new Set(selectedSizeRun().map(c => c.label));
    const boxByLabel = new Map();

    const groupWrap = document.createElement('div');
    groupWrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const makeGroup = (title, tier) => {
      const wrap = document.createElement('div');
      const h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:6px;';
      wrap.appendChild(h);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 14px;';
      for (const col of SPEC_SIZE_RUN.filter(c => c.tier === tier)) {
        const label = document.createElement('label');
        label.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = current.has(col.label);
        box.addEventListener('change', updateFooter);
        boxByLabel.set(col.label, box);
        label.appendChild(box);
        label.appendChild(document.createTextNode(col.label));
        row.appendChild(label);
      }
      wrap.appendChild(row);
      return wrap;
    };
    groupWrap.appendChild(makeGroup('Alpha sizes (graded from Size L)', 1));
    groupWrap.appendChild(makeGroup('Depth sizes (graded from Size L2)', 2));
    body.appendChild(groupWrap);

    // Presets: one click to the common export shapes.
    const presets = document.createElement('div');
    presets.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const applyPreset = (predicate) => {
      for (const col of SPEC_SIZE_RUN) boxByLabel.get(col.label).checked = predicate(col);
      updateFooter();
    };
    const presetDefs = [
      ['All sizes', () => true],
      ['Size L only', (c) => c.label === 'L'],
      ['Alpha only', (c) => c.tier === 1],
      ['Depth only', (c) => c.tier === 2],
    ];
    for (const [name, predicate] of presetDefs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-btn';
      btn.textContent = name;
      btn.addEventListener('click', () => applyPreset(predicate));
      presets.appendChild(btn);
    }
    body.appendChild(presets);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#666;';
    hint.textContent = 'Formulas stay live for sizes whose base column (L or L2) is included; '
      + 'otherwise values are exported as plain numbers.';
    body.appendChild(hint);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    footer.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const count = document.createElement('span');
    count.style.cssText = 'font-size:12px;color:#444;flex:1;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => dlg.close());
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'picker-btn picker-btn-primary';
    okBtn.textContent = 'Export';
    okBtn.addEventListener('click', () => {
      const chosen = SPEC_SIZE_RUN.filter(c => boxByLabel.get(c.label).checked);
      if (!chosen.length) return;
      // null when everything is selected — the back-compat "no preference"
      // shape old builds also understand (they ignore the field entirely).
      state.sizeSelection = chosen.length === SPEC_SIZE_RUN.length
        ? null
        : {
          alpha: chosen.filter(c => c.tier === 1).map(c => c.label),
          depth: chosen.filter(c => c.tier === 2).map(c => c.label),
        };
      if (typeof scheduleAutosave === 'function') scheduleAutosave();
      dlg.close();
      onConfirm();
    });
    footer.appendChild(count);
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    function updateFooter() {
      const n = SPEC_SIZE_RUN.filter(c => boxByLabel.get(c.label).checked).length;
      count.textContent = n + ' of ' + SPEC_SIZE_RUN.length + ' sizes selected';
      okBtn.disabled = n === 0;
    }
    updateFooter();

    dlg.panel.appendChild(body);
    dlg.panel.appendChild(footer);
    dlg.open();
  }
