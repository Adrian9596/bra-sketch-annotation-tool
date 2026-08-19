// BOM page — material-suggestion engine (library lookup, fill-empty-only
// autofill, floating in-cell ▾ dropdown, side-panel search list) plus the
// per-row material photo popover (US-072, ADR 0041). Source part for
// app.js. Run `npm run build` after editing. Static suggestion data lives in
// bom-material-data.js (BOM_MATERIAL_LIBRARY), which must load before this
// part; state.bom shape and bmRowById come from bom-state.js (see
// scripts/source-parts.mjs).
//
// The material-suggestion picker is a side-panel searchable list (mirroring
// Construction's phrase quick-list, ADR 0039), not the reference tool's
// per-cell floating popover. Picking a material always sets the selected
// row's description, and pre-fills areaOfUse/supplier/article/width/size
// only into cells the TD has not yet typed into — never overwrites.

  function bmMaterialMatches(m, tokens) {
    const s = m.name.toLowerCase();
    return tokens.every(t => s.includes(t));
  }

  // Fills the selected row's description (the point of picking a material)
  // and pre-fills the remaining suggestion fields only into cells the TD
  // has not already typed into — never overwrites a TD's own entry.
  function bmApplyMaterial(rowId, material) {
    const row = bmRowById(rowId);
    if (!row || !material) return;
    row.cells.description = material.name;
    if (!row.cells.areaOfUse && material.areaOptions && material.areaOptions.length) {
      row.cells.areaOfUse = material.areaOptions[0];
    }
    if (!row.cells.supplier && material.supplierOptions && material.supplierOptions.length) {
      row.cells.supplier = material.supplierOptions[0];
    }
    if (!row.cells.article && material.articleOptions && material.articleOptions.length) {
      row.cells.article = material.articleOptions[0];
    }
    if (!row.cells.width && material.width) row.cells.width = material.width;
    if (!row.cells.size && material.size) row.cells.size = material.size;
    renderBom();
    pushHistoryIfChanged();
  }

  function bmApplyMaterialByIndex(i) {
    const m = bmMaterialHits[i];
    if (m && bmSelectedRowId) bmApplyMaterial(bmSelectedRowId, m);
  }

  /* ---- In-cell suggestion menu (reference bom-dd / SuggMenu, simplified) --- */

  let bmDdOpenFor = null;   // 'rowId|field' the menu is open for, or null
  let bmDdItems = [];

  function bmMaterialInfoFor(description) {
    const key = String(description || '').trim().toLowerCase();
    if (!key) return null;
    return BOM_MATERIAL_LIBRARY.find(m => m.name.toLowerCase() === key) || null;
  }

  // Suggestions are offered, never auto-inserted — same "chọn tay, KHÔNG tự
  // điền" rule as the reference sheet. Non-description columns resolve from
  // the row's OWN material when its description matches a library entry.
  function bmSuggestItems(row, field) {
    const out = [];
    const add = (value, tag) => {
      if (value && !out.some(x => x.value === value)) out.push({ value, tag: tag || '' });
    };
    if (field === 'description') {
      BOM_MATERIAL_LIBRARY.forEach(m => add(m.name, m.section));
      return out;
    }
    const info = bmMaterialInfoFor(row.cells.description);
    if (field === 'areaOfUse') {
      if (info) (info.areaOptions || []).forEach(v => add(v));
      if (!out.length) {
        BOM_MATERIAL_LIBRARY.forEach(m => (m.areaOptions || []).forEach(v => add(v, m.name)));
      }
    } else if (field === 'supplier') {
      if (info) (info.supplierOptions || []).forEach(v => add(v));
    } else if (field === 'article') {
      if (info) (info.articleOptions || []).forEach(v => add(v));
    } else if (field === 'width') {
      if (info) add(info.width);
    } else if (field === 'size') {
      if (info) add(info.size);
      add('ALL', 'default');
    }
    return out;
  }

  function bmDdMenuEl() {
    let menu = document.getElementById('bomDdMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'bomDdMenu';
    menu.className = 'bm-dd-menu';
    menu.hidden = true;
    menu.innerHTML = '<input type="search" class="bm-dd-q" spellcheck="false" placeholder="Type to filter&hellip;">'
      + '<div class="bm-dd-list"></div>';
    document.body.appendChild(menu);
    menu.querySelector('.bm-dd-q').addEventListener('input', e => bmDdRenderList(e.target.value));
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { bmCloseDd(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = menu.querySelector('.bm-dd-list [data-bm-pick]');
        if (first) bmDdPick(+first.dataset.bmPick);
      }
    });
    menu.addEventListener('click', e => {
      const pick = e.target.closest('[data-bm-pick]');
      if (pick) bmDdPick(+pick.dataset.bmPick);
    });
    return menu;
  }

  function bmDdRenderList(query) {
    const menu = bmDdMenuEl();
    const list = menu.querySelector('.bm-dd-list');
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length
      ? bmDdItems.filter(it => tokens.every(t => it.value.toLowerCase().includes(t)))
      : bmDdItems;
    list.innerHTML = hits.slice(0, 60).map(it =>
      '<button type="button" data-bm-pick="' + bmDdItems.indexOf(it) + '">'
      + escapeHtml(it.value)
      + (it.tag ? '<span class="bm-dd-tag">' + escapeHtml(it.tag) + '</span>' : '')
      + '</button>').join('')
      || '<div class="bm-dd-empty">Library has nothing for this cell yet — type your own value</div>';
  }

  function bmOpenDd(btn) {
    const [rowIdStr, field] = String(btn.dataset.bomDd).split('|');
    const row = bmRowById(+rowIdStr);
    if (!row) return;
    bmDdOpenFor = btn.dataset.bomDd;
    bmDdItems = bmSuggestItems(row, field);
    const menu = bmDdMenuEl();
    menu.hidden = false;
    const q = menu.querySelector('.bm-dd-q');
    q.value = '';
    bmDdRenderList('');
    const r = btn.getBoundingClientRect();
    const w = 300;
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 80) + 'px';
    q.focus();
  }

  function bmCloseDd() {
    const menu = document.getElementById('bomDdMenu');
    if (menu) menu.hidden = true;
    bmDdOpenFor = null;
  }

  function bmDdPick(index) {
    const it = bmDdItems[index];
    if (!it || !bmDdOpenFor) return;
    const [rowIdStr, field] = bmDdOpenFor.split('|');
    const row = bmRowById(+rowIdStr);
    bmCloseDd();
    if (!row) return;
    if (field === 'description') {
      // Route through the same fill-empty rule as the side-panel pick: sets
      // the description, pre-fills only cells the TD has not typed into.
      const material = bmMaterialInfoFor(it.value);
      if (material) { bmApplyMaterial(row.id, material); return; }
    }
    row.cells[field] = it.value;
    renderBom();
    pushHistoryIfChanged();
  }

  /* ---- Material photo cell (reference photo-trigger, offline-only) --------
     A row's photo is { dataURL } in row.photo — uploaded or pasted by the
     TD, stored in the project like board images. No catalog matching (the
     reference's exact-article/same-material badges need its photo catalog,
     which this offline tool does not carry). */

  let bmPhotoOpenRow = null;

  function bmSetRowPhoto(rowId, dataURL) {
    const row = bmRowById(rowId);
    if (!row) return;
    if (dataURL) row.photo = { dataURL };
    else delete row.photo;
    bmClosePhotoMenu();
    renderBom();
    pushHistoryIfChanged();
  }

  function bmPhotoMenuEl() {
    let menu = document.getElementById('bomPhotoMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'bomPhotoMenu';
    menu.className = 'bm-dd-menu bm-photo-menu';
    menu.hidden = true;
    menu.innerHTML = '<div class="bm-photo-hint">Material photo for this row — prints on the BOM sheet.</div>'
      + '<div class="bm-photo-actions">'
      + '<button type="button" data-bm-photo-upload title="Or Cmd/Ctrl+V to paste a copied image">Upload&hellip; / Paste</button>'
      + '<button type="button" data-bm-photo-clear>Remove</button></div>';
    document.body.appendChild(menu);
    const filePick = document.createElement('input');
    filePick.type = 'file';
    filePick.accept = 'image/*';
    filePick.hidden = true;
    menu.appendChild(filePick);
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      const rowId = bmPhotoOpenRow;
      filePick.value = '';
      if (!f || rowId == null || !/^image\//i.test(f.type)) return;
      const rd = new FileReader();
      rd.onload = () => bmSetRowPhoto(rowId, rd.result);
      rd.readAsDataURL(f);
    });
    menu.addEventListener('click', e => {
      if (bmPhotoOpenRow == null) return;
      if (e.target.closest('[data-bm-photo-upload]')) { filePick.click(); return; }
      if (e.target.closest('[data-bm-photo-clear]')) bmSetRowPhoto(bmPhotoOpenRow, null);
    });
    // Paste lands here (not on the board): stopPropagation keeps the app's
    // document-level paste router from also adopting the image as a sketch.
    menu.addEventListener('paste', e => {
      if (bmPhotoOpenRow == null || !e.clipboardData) return;
      const it = Array.from(e.clipboardData.items)
        .find(x => x.kind === 'file' && /^image\//i.test(x.type));
      if (!it) return;
      const f = it.getAsFile();
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      const rowId = bmPhotoOpenRow;
      const rd = new FileReader();
      rd.onload = () => bmSetRowPhoto(rowId, rd.result);
      rd.readAsDataURL(f);
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { bmClosePhotoMenu(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
    });
    return menu;
  }

  function bmOpenPhotoMenu(btn) {
    bmCloseDd();
    bmPhotoOpenRow = +btn.dataset.bomPhoto;
    const menu = bmPhotoMenuEl();
    menu.hidden = false;
    // tabindex makes the menu focusable so the paste event targets it.
    menu.tabIndex = -1;
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 90) + 'px';
    menu.focus();
  }

  function bmClosePhotoMenu() {
    const menu = document.getElementById('bomPhotoMenu');
    if (menu) menu.hidden = true;
    bmPhotoOpenRow = null;
  }

  function bmRenderMaterialPanel() {
    const empty = document.getElementById('bomMatEmpty');
    const panel = document.getElementById('bomMatPanel');
    if (!empty || !panel) return;
    const row = bmSelectedRowId ? bmRowById(bmSelectedRowId) : null;
    if (!row) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }
    empty.hidden = true;
    panel.hidden = false;
    const label = document.getElementById('bomMatRowLabel');
    if (label) {
      const seq = bmRowSeq(row.id, bmVariant);
      label.textContent = (seq ? seq + '. ' : '') + (row.cells.description || '(empty description)');
    }
    bmRenderMaterialList();
  }

  function bmRenderMaterialList() {
    const box = document.getElementById('bomMatList');
    if (!box) return;
    const tokens = bmSearchText.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length
      ? BOM_MATERIAL_LIBRARY.filter(m => bmMaterialMatches(m, tokens))
      : BOM_MATERIAL_LIBRARY;
    bmMaterialHits = hits.slice(0, 60);
    box.innerHTML = bmMaterialHits.map((m, i) =>
      '<button type="button" data-bom-mat="' + i + '">' + escapeHtml(m.name)
      + '<span class="bm-mat-section">' + escapeHtml(m.section) + '</span></button>').join('')
      || '<div class="bm-mat-empty">No material matches — type your own description in the row</div>';
  }
