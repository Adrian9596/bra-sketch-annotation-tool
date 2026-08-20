// BOM page: editable material table + material-key canvas annotation
// (US-072, ADR 0041). Source part for app.js. Run `npm run build` after
// editing.
//
// Rebuilt on this tool's primitives from the sibling tech-pack project's
// mod-bom module — that project has its own globals/closures with no shared
// module, so this is a fork, not a link (same pattern as MAIN PAGE/
// Construction, ADR 0037/0039). Static suggestion data is carried across
// verbatim in bom-material-data.js (BOM_MATERIAL_LIBRARY, 27 entries mined
// from 1,748 historical BOM records) — that file must load before this one
// (see scripts/source-parts.mjs).
//
// This part is now the page's DOM wiring only (initBom); it loads last of
// the bom-* parts. The rest of the page lives in bom-state.js (schema,
// seeding, persistence, row CRUD/numbering), bom-images.js (Material Key
// image board), bom-materials.js (suggestion engine + per-row photo
// popover), bom-canvas.js (Material Key leader-line engine) and
// bom-table.js (factory table + print sheets).

  /* ---- Wiring --------------------------------------------------------------- */
  // Page open/close belongs to page-nav.js's setActivePage('bom' | 'board' |
  // 'mainpage' | 'construction') — the BOM page is a peer page, not a modal
  // this file owns the visibility of.

  function initBom() {
    ensureBom();
    const page = document.getElementById('bomPage');
    if (!page) return;
    // US-090 — see observeCanvasBox in construction.js for why. The Material
    // Key is the worse of the two: switching tool rewraps the toolbar hint and
    // shrinks the canvas ~19px with no redraw, so leader arrowheads landed a
    // few percent off the click and were saved there.
    observeCanvasBox('bomMatkeyCanvas', () => bmDrawCanvas());

    document.querySelectorAll('[data-bom-variant]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.bomVariant;
        if (v !== 'solid' && v !== 'lace') return;
        bmVariant = v;
        bmCloseDd();
        bmSelectedRowId = null;
        bmSelectedCalloutId = null;
        bmSelectedImageId = null;
        bmSetTool('select');
        bmSyncVariantTabs();
        renderBom();
      });
    });

    const selectToolBtn = document.getElementById('bomSelectToolBtn');
    if (selectToolBtn) selectToolBtn.addEventListener('click', () => {
      bmSetTool('select');
      showToast('Select tool active');
    });

    const addCalloutBtn = document.getElementById('bomAddCalloutBtn');
    if (addCalloutBtn) {
      addCalloutBtn.addEventListener('click', () => {
        if (bmTool === 'callout') {
          bmSetTool('select');
          showToast('Select tool active');
          return;
        }
        bmStartCalloutTool();
      });
    }

    const addArrowBtn = document.getElementById('bomAddArrowBtn');
    if (addArrowBtn) {
      addArrowBtn.addEventListener('click', () => {
        if (!bmSelectedCallout()) { showToast('Select a callout first'); return; }
        if (bmTool === 'leader') {
          bmSetTool('select');
          showToast('Select tool active');
          return;
        }
        bmSetTool('leader');
        showToast('Add Leaders · click multiple targets; Select/Esc finishes');
      });
    }

    const deleteCalloutBtn = document.getElementById('bomDeleteCalloutBtn');
    if (deleteCalloutBtn) deleteCalloutBtn.addEventListener('click', bmDeleteSelectedCallout);

    const imageInput = document.getElementById('bomImageFileInput');
    const addImageBtn = document.getElementById('bomAddImageBtn');
    if (addImageBtn && imageInput) addImageBtn.addEventListener('click', () => imageInput.click());
    if (imageInput) imageInput.addEventListener('change', async () => {
      const files = Array.from(imageInput.files || []);
      imageInput.value = '';
      await bmAddImageFiles(files, bmVariant);
    });
    const pasteImageBtn = document.getElementById('bomPasteImageBtn');
    if (pasteImageBtn) pasteImageBtn.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('Use Cmd/Ctrl+V while Material Key is open.');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        const dataURLs = [];
        for (const item of items) {
          const type = item.types.find(t => /^image\//i.test(t));
          if (type) dataURLs.push(await blobToDataURL(await item.getType(type)));
        }
        if (dataURLs.length) await bmAddImagesFromDataURLs(dataURLs, bmVariant);
        else showToast('Clipboard has no image.');
      } catch (_) {
        showToast('Clipboard access was blocked. Use Cmd/Ctrl+V instead.');
      }
    });
    const deleteImageBtn = document.getElementById('bomDeleteImageBtn');
    if (deleteImageBtn) deleteImageBtn.addEventListener('click', bmDeleteSelectedImage);
    const zoomOutImageBtn = document.getElementById('bomImageZoomOutBtn');
    if (zoomOutImageBtn) zoomOutImageBtn.addEventListener('click', () => bmZoomSelectedImage(0.9));
    const zoomInImageBtn = document.getElementById('bomImageZoomInBtn');
    if (zoomInImageBtn) zoomInImageBtn.addEventListener('click', () => bmZoomSelectedImage(1.1));
    const fitImagesBtn = document.getElementById('bomFitImagesBtn');
    if (fitImagesBtn) fitImagesBtn.addEventListener('click', () => {
      if (!bmVariantImages().length) return;
      bmReflowImages();
      bmSelectedImageId = null;
      renderBom();
      pushHistoryIfChanged();
    });

    const rowSelect = document.getElementById('bomMkRowSelect');
    if (rowSelect) {
      rowSelect.addEventListener('change', () => {
        const c = bmSelectedCallout();
        if (!c) return;
        const rowId = +rowSelect.value;
        const occupied = bmCalloutForRow(rowId, bmVariant);
        if (occupied && occupied.id !== c.id) {
          showToast('That BOM row already owns a callout on this variant');
          renderBom();
          return;
        }
        c.rowId = rowId;
        bmSelectedRowId = rowId;
        renderBom();
        pushHistoryIfChanged();
      });
    }

    const canvas = document.getElementById('bomMatkeyCanvas');
    if (canvas) {
      canvas.addEventListener('mousedown', bmOnPointerDown);
      canvas.addEventListener('dblclick', bmOnDoubleClick);
      const filesDragging = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      canvas.addEventListener('dragover', e => {
        if (!filesDragging(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        canvas.classList.add('bm-drag-over');
      });
      canvas.addEventListener('dragleave', () => canvas.classList.remove('bm-drag-over'));
      canvas.addEventListener('drop', async e => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        canvas.classList.remove('bm-drag-over');
        await bmAddImageFiles(e.dataTransfer.files, bmVariant);
      });
    }
    window.addEventListener('mousemove', bmOnPointerMove);
    window.addEventListener('mouseup', bmOnPointerUp);
    window.addEventListener('resize', () => {
      if (state.activePage === 'bom') bmDrawCanvas();
    });

    const searchEl = document.getElementById('bomMatSearch');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        bmSearchText = searchEl.value;
        bmRenderMaterialList();
      });
      searchEl.addEventListener('keydown', e => {
        if (e.key !== 'Tab') e.stopPropagation();
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (bmMaterialHits[0]) bmApplyMaterialByIndex(0);
      });
    }

    const matList = document.getElementById('bomMatList');
    if (matList) {
      matList.addEventListener('click', e => {
        const btn = e.target.closest('[data-bom-mat]');
        if (btn) bmApplyMaterialByIndex(+btn.dataset.bomMat);
      });
    }

    // The floating ▾ menu is parked on <body>; anything that moves the cell
    // out from under it (outside click, scroll, tab/variant switches) closes
    // it rather than leaving it hovering over stale coordinates.
    document.addEventListener('click', e => {
      if (bmDdOpenFor && !e.target.closest('#bomDdMenu,[data-bom-dd]')) bmCloseDd();
      if (bmPhotoOpenRow != null && !e.target.closest('#bomPhotoMenu,[data-bom-photo]')) bmClosePhotoMenu();
    });
    window.addEventListener('scroll', () => {
      if (bmDdOpenFor) bmCloseDd();
      if (bmPhotoOpenRow != null) bmClosePhotoMenu();
    }, true);

    // Delegated on the page element, which survives every table re-render —
    // a listener on a cell/row/button would die on the next renderBom().
    page.addEventListener('input', e => {
      const cell = e.target.closest('[data-cell]');
      if (cell) {
        const row = bmRowById(+cell.dataset.row);
        if (row) {
          row.cells[cell.dataset.cell] = cell.textContent;
          if (cell.dataset.cell === 'description') {
            bmDrawCanvas();
            bmRenderPrintSheets();
          }
        }
        return;
      }
      const cw = e.target.closest('[data-cw]');
      if (cw) {
        const row = bmRowById(+cw.dataset.row);
        if (row) {
          if (!row.cwOverride || typeof row.cwOverride !== 'object') row.cwOverride = {};
          row.cwOverride[cw.dataset.cw] = cw.textContent;
        }
      }
    });

    // One history entry per cell, not per keystroke: mutate on input, push
    // on blur, same pattern as main-page.js's contenteditable fields.
    page.addEventListener('focusout', e => {
      if (e.target.closest('[contenteditable]')) pushHistoryIfChanged();
    });

    page.addEventListener('change', e => {
      const scopeSel = e.target.closest('[data-scope]');
      if (!scopeSel) return;
      const row = bmRowById(+scopeSel.dataset.row);
      if (!row) return;
      row.scope = scopeSel.value;
      const allowed = row.scope === 'BOTH'
        ? new Set(['solid', 'lace'])
        : new Set([row.scope.toLowerCase()]);
      const removed = state.bom.callouts.filter(c => c.rowId === row.id && !allowed.has(bmVariantKey(c.variant)));
      if (removed.length) {
        const removedIds = new Set(removed.map(c => c.id));
        state.bom.callouts = state.bom.callouts.filter(c => !removedIds.has(c.id));
        if (removedIds.has(bmSelectedCalloutId)) bmSelectedCalloutId = null;
        if (bmTool === 'leader' && !bmSelectedCallout()) bmTool = 'select';
      }
      renderBom();
      pushHistoryIfChanged();
      if (removed.length) showToast('Scope updated · removed ' + removed.length + ' callout(s) from excluded variant(s) · Ctrl/Cmd+Z to undo');
    });

    page.addEventListener('click', e => {
      const dd = e.target.closest('[data-bom-dd]');
      if (dd) {
        if (bmDdOpenFor === dd.dataset.bomDd) bmCloseDd();
        else bmOpenDd(dd);
        return;
      }
      const photoBtn = e.target.closest('[data-bom-photo]');
      if (photoBtn) {
        if (bmPhotoOpenRow === +photoBtn.dataset.bomPhoto) bmClosePhotoMenu();
        else bmOpenPhotoMenu(photoBtn);
        return;
      }
      const addRow = e.target.closest('[data-bom-add]');
      if (addRow) { bmAddRow(addRow.dataset.bomAdd); return; }
      const mk = e.target.closest('[data-bom-mk]');
      if (mk) { bmArmRowCallout(+mk.dataset.row); return; }
      const split = e.target.closest('[data-bom-split]');
      if (split) { bmSplitRow(+split.dataset.row); return; }
      const rm = e.target.closest('[data-bom-rm]');
      if (rm) { bmRemoveRow(+rm.dataset.row); return; }
      const rowEl = e.target.closest('[data-bom-row]');
      if (rowEl) {
        const id = +rowEl.dataset.bomRow;
        if (bmSelectedRowId !== id) {
          bmSelectedRowId = id;
          bmSyncSelectedRowClass();
          bmRenderMaterialPanel();
        }
      }
    });

    document.addEventListener('keydown', e => {
      if (state.activePage !== 'bom') return;
      if (e.key === 'Escape') {
        if (bmDdOpenFor) { bmCloseDd(); return; }
        if (bmPhotoOpenRow != null) { bmClosePhotoMenu(); return; }
        if (bmTool !== 'select') { bmSetTool('select'); showToast('Select tool active'); return; }
        if (bmSelectedCalloutId !== null) { bmSelectedCalloutId = null; renderBom(); return; }
        if (bmSelectedImageId !== null) { bmSelectedImageId = null; renderBom(); return; }
        setActivePage('board');
        return;
      }
      if (e.key === 'Backspace' && bmSelectedCalloutId !== null) {
        const active = document.activeElement;
        const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
        if (inField) return;
        e.preventDefault();
        bmDeleteSelectedCallout();
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && bmSelectedImageId !== null) {
        const active = document.activeElement;
        const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
        if (inField) return;
        e.preventDefault();
        bmDeleteSelectedImage();
      }
    }, true);

    bmSyncVariantTabs();
    renderBom();
  }
