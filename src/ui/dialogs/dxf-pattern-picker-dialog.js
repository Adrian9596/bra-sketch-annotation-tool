// US-124 Phase 4 (ADR 0091, owner decision 3): the pre-placement pattern
// picker. Opens from importDxfText when a DXF would place more lines than
// DXF_TOTAL_OUTPUT_CAP (board performance, the one remaining hard stop).
// Instead of "Import rejected", the TD sees one row per PLACEMENT INSTANCE —
// a graded size, a piece — with its block name, ASTM annotation and line
// count, unchecks rows until the total fits, and imports the rest. The
// unit is the instance (not the pattern) because that is what both parsers
// can skip identically (dxfClassifyPatterns `excludeInstances`), keeping the
// board↔native piece pairing intact; instance 0 (direct ENTITIES) is one
// all-or-nothing row, so a file with no INSERTs cannot be split here — the
// dialog says so rather than pretending.
//
// Modelled on export-size-dialog.js (same buildDialog shell, same presets
// shape: one button per size token, ADR 0084's after-the-last-underscore
// rule). Source part for app.js. Run `npm run build` after editing.

  function dxfPickerFormat(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function openDxfPatternPickerDialog(overCap, handlers) {
    // The report may come from dxf-worker.js, which has no dxfMeasureSizeToken
    // (Board code) — derive the ADR 0084 size token here when it is missing.
    const rows = ((overCap && Array.isArray(overCap.instances)) ? overCap.instances : []).map(r => Object.assign({}, r, {
      sizeToken: r.sizeToken || (r.blockName && typeof dxfMeasureSizeToken === 'function' ? dxfMeasureSizeToken(r.blockName) : null),
    }));
    const cap = overCap && overCap.cap ? overCap.cap : DXF_TOTAL_OUTPUT_CAP;
    const already = new Set((handlers && handlers.alreadyExcluded) || []);
    const dlg = buildDialog({
      title: 'Too many lines to place at once',
      sub: (handlers && handlers.fileName ? handlers.fileName + ' — ' : '')
        + 'this DXF would place ' + dxfPickerFormat(overCap.total) + ' lines; the board holds ' + dxfPickerFormat(cap)
        + '. Untick sizes or pieces until it fits, then import the rest.',
    });
    dlg.overlay.classList.add('dxf-pattern-picker');

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:520px;max-width:720px;';

    const tokens = Array.from(new Set(rows.map(r => r.sizeToken).filter(Boolean)));
    const boxByInstance = new Map();

    if (tokens.length >= 2) {
      const presets = document.createElement('div');
      presets.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
      const lab = document.createElement('span');
      lab.style.cssText = 'font-size:12px;color:#444;margin-right:4px;';
      lab.textContent = 'Keep only size:';
      presets.appendChild(lab);
      for (const token of tokens) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-btn';
        btn.textContent = token;
        btn.addEventListener('click', () => {
          for (const r of rows) boxByInstance.get(r.instance).checked = r.sizeToken === token;
          updateFooter();
        });
        presets.appendChild(btn);
      }
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'picker-btn';
      all.textContent = 'All';
      all.addEventListener('click', () => { for (const r of rows) boxByInstance.get(r.instance).checked = true; updateFooter(); });
      presets.appendChild(all);
      body.appendChild(presets);
    }

    const list = document.createElement('div');
    list.className = 'dxf-pattern-picker-list';
    list.style.cssText = 'max-height:52vh;overflow:auto;border:1px solid #e2e8f0;border-radius:6px;';
    for (const r of rows) {
      const row = document.createElement('label');
      row.className = 'dxf-pattern-picker-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;border-top:1px solid #f1f5f9;font-size:12px;cursor:pointer;';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !already.has(r.instance);
      box.dataset.instance = String(r.instance);
      box.addEventListener('change', updateFooter);
      boxByInstance.set(r.instance, box);
      row.appendChild(box);
      const name = document.createElement('span');
      name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const title = r.blockName || (r.instance === 0 ? 'Direct entities (no block)' : 'Instance ' + r.instance);
      const meta = [r.pieceName, r.size, r.quantity != null ? 'qty ' + r.quantity : null].filter(Boolean).join(' · ');
      name.textContent = title + (meta ? '  —  ' + meta : '');
      name.title = name.textContent;
      row.appendChild(name);
      const count = document.createElement('span');
      count.style.cssText = 'flex:0 0 auto;color:#64748b;font-size:11px;';
      count.textContent = r.patterns + (r.patterns === 1 ? ' pattern · ' : ' patterns · ') + dxfPickerFormat(r.lines) + ' lines';
      row.appendChild(count);
      list.appendChild(row);
    }
    body.appendChild(list);

    if (rows.length === 1) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size:11px;color:#b45309;';
      note.textContent = rows[0].instance === 0
        ? 'This file places all its geometry directly (no INSERT blocks), so it cannot be split by piece or size here. Reduce it in the CAD tool and re-export.'
        : 'This file has a single placement instance that is itself over the limit. Reduce it in the CAD tool and re-export.';
      body.appendChild(note);
    }

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    footer.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const summary = document.createElement('span');
    summary.className = 'dxf-pattern-picker-summary';
    summary.style.cssText = 'font-size:12px;flex:1;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { dlg.close(); if (handlers && handlers.onCancel) handlers.onCancel(); });
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'picker-btn picker-btn-primary dxf-pattern-picker-ok';
    okBtn.textContent = 'Import selected';
    okBtn.addEventListener('click', () => {
      const excludeInstances = rows.filter(r => !boxByInstance.get(r.instance).checked).map(r => r.instance);
      if (excludeInstances.length === rows.length) return;
      dlg.close();
      if (handlers && handlers.onConfirm) handlers.onConfirm(excludeInstances);
    });
    footer.appendChild(summary);
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    function updateFooter() {
      let lines = 0, n = 0;
      for (const r of rows) if (boxByInstance.get(r.instance).checked) { lines += r.lines; n += 1; }
      const over = lines > cap;
      summary.textContent = n + ' of ' + rows.length + ' selected · ' + dxfPickerFormat(lines) + ' of ' + dxfPickerFormat(cap) + ' lines'
        + (over ? ' — still over the limit' : '');
      summary.style.color = over ? '#dc2626' : '#166534';
      okBtn.disabled = over || n === 0;
    }
    updateFooter();

    dlg.panel.appendChild(body);
    dlg.panel.appendChild(footer);
    dlg.open();
    return dlg;
  }
