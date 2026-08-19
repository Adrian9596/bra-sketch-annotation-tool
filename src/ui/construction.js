// Construction working sheets (US-078, ADR 0045) — top-level orchestration:
// toolbar/tool UI sync, the page render entry point, and DOM wiring.
// Source part for app.js. Run `npm run build` after editing.
//
// The rest of the page lives in sibling parts, all loaded before this one:
// construction-state.js (schema constants, state.construction seeding,
// legacy migration, project serialize/load), construction-images.js
// (working-board image management), construction-canvas.js (leader-line
// geometry, hit-testing, drawing, pointer drag), construction-rows.js
// (row CRUD, row table markup, phrase picker).

  function ccSyncUi() {
    document.querySelectorAll('[data-cc-sheet]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ccSheet === ccSheet));
    });
    document.querySelectorAll('[data-cc-active-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ccActiveView === ccActiveView));
    });
    const tools = {
      select: document.getElementById('ccSelectToolBtn'),
      callout: document.getElementById('ccAddCalloutBtn'),
      leader: document.getElementById('ccAddLeaderBtn'),
    };
    Object.keys(tools).forEach(tool => {
      const button = tools[tool];
      if (!button) return;
      button.classList.toggle('cc-tool-active', ccTool === tool);
      button.setAttribute('aria-pressed', String(ccTool === tool));
    });
    if (tools.leader) tools.leader.disabled = !ccSelectedCallout();
    const deleteCallout = document.getElementById('ccDeleteCalloutBtn');
    if (deleteCallout) deleteCallout.disabled = !ccSelectedCallout();
    const deleteImage = document.getElementById('ccDeleteImageBtn');
    if (deleteImage) deleteImage.disabled = !ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    const hint = document.getElementById('ccToolHint');
    if (hint) {
      if (ccTool === 'callout') {
        const row = ccRowById(ccSelectedRowId);
        hint.textContent = row ? 'Add Callouts: place row ' + ccRowSeq(row.id) + ' in ' + row.view.toUpperCase() + '; Select/Esc finishes.' : 'Add Callouts: place the highlighted row.';
      } else if (ccTool === 'leader') {
        hint.textContent = 'Add Leaders: click multiple targets on the selected callout image; Select/Esc finishes.';
      } else {
        hint.textContent = 'Active panel: ' + ccActiveView.toUpperCase() + ' · select a label, leader, target, or image to adjust it.';
      }
    }
    const canvas = document.getElementById('constructionCanvas');
    if (canvas) {
      canvas.classList.remove('cc-tool-select', 'cc-tool-callout', 'cc-tool-leader');
      canvas.classList.add('cc-tool-' + ccTool);
    }
  }

  function renderConstruction() {
    ensureConstruction();
    if (ccTool === 'leader' && !ccSelectedCallout()) ccTool = 'select';
    const title = document.getElementById('ccSheetTitle');
    if (title) title.textContent = 'CONSTRUCTION · ' + ccSheet.toUpperCase();
    ccDrawCanvas();
    ccRenderTable();
    ccSyncUi();
  }

  function initConstruction() {
    ensureConstruction();
    const page = document.getElementById('constructionPage');
    if (!page) return;
    const canvas = document.getElementById('constructionCanvas');
    const imageInput = document.getElementById('ccImageInput');
    const tableBody = document.getElementById('ccTableBody');

    document.querySelectorAll('[data-cc-sheet]').forEach(button => {
      button.addEventListener('click', () => {
        ccSheet = ccSheetKey(button.dataset.ccSheet);
        ccSelectedRowId = null;
        ccSelectedCalloutId = null;
        ccSelectedImageId = null;
        ccSetTool('select');
        renderConstruction();
      });
    });
    document.querySelectorAll('[data-cc-active-view]').forEach(button => {
      button.addEventListener('click', () => {
        ccActiveView = ccViewKey(button.dataset.ccActiveView);
        ccSelectedImageId = null;
        renderConstruction();
      });
    });

    const addImage = document.getElementById('ccAddImageBtn');
    if (addImage) addImage.addEventListener('click', () => imageInput && imageInput.click());
    if (imageInput) imageInput.addEventListener('change', async () => {
      await ccAddImageFiles(imageInput.files, ccSheet, ccActiveView);
      imageInput.value = '';
    });
    const pasteImage = document.getElementById('ccPasteImageBtn');
    if (pasteImage) pasteImage.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('Use Ctrl/Cmd+V while Construction is open to paste images.');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        const urls = [];
        for (const item of items) {
          const type = item.types.find(value => /^image\//i.test(value));
          if (type) urls.push(await blobToDataURL(await item.getType(type)));
        }
        if (urls.length) await ccAddImagesFromDataURLs(urls, ccSheet, ccActiveView);
        else showToast('Clipboard has no image.');
      } catch (_) { showToast('Clipboard access was blocked; use Ctrl/Cmd+V instead.'); }
    });
    const deleteImage = document.getElementById('ccDeleteImageBtn');
    if (deleteImage) deleteImage.addEventListener('click', ccDeleteSelectedImage);
    const zoomOut = document.getElementById('ccImageZoomOutBtn');
    const zoomIn = document.getElementById('ccImageZoomInBtn');
    if (zoomOut) zoomOut.addEventListener('click', () => ccZoomSelectedImage(0.9));
    if (zoomIn) zoomIn.addEventListener('click', () => ccZoomSelectedImage(1.1));
    const selectTool = document.getElementById('ccSelectToolBtn');
    const addCallout = document.getElementById('ccAddCalloutBtn');
    const addLeader = document.getElementById('ccAddLeaderBtn');
    const deleteCallout = document.getElementById('ccDeleteCalloutBtn');
    if (selectTool) selectTool.addEventListener('click', () => ccSetTool('select'));
    if (addCallout) addCallout.addEventListener('click', () => ccStartCalloutTool(ccSelectedRowId));
    if (addLeader) addLeader.addEventListener('click', () => ccSetTool('leader'));
    if (deleteCallout) deleteCallout.addEventListener('click', ccDeleteSelectedCallout);

    if (canvas) {
      canvas.addEventListener('mousedown', ccOnPointerDown);
      canvas.addEventListener('dblclick', event => {
        if (ccTool === 'select') ccDeleteAnchorAt(ccEventPoint(event, canvas));
      });
      canvas.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
      canvas.addEventListener('drop', async event => {
        event.preventDefault();
        const layout = ccPanelAt(ccEventPoint(event, canvas));
        if (layout) ccActiveView = layout.view;
        await ccAddImageFiles(event.dataTransfer.files, ccSheet, ccActiveView);
      });
    }
    window.addEventListener('mousemove', ccOnPointerMove);
    window.addEventListener('mouseup', ccOnPointerUp);
    window.addEventListener('resize', () => { if (state.activePage === 'construction') ccDrawCanvas(); });

    if (tableBody) {
      tableBody.addEventListener('input', event => {
        const detail = event.target.closest('[data-cc-row-detail]');
        if (!detail) return;
        const row = ccRowById(Number(detail.dataset.ccRowDetail));
        if (!row) return;
        row.detail = detail.value;
        ccDrawCanvas();
      });
      tableBody.addEventListener('change', event => {
        const viewSelect = event.target.closest('[data-cc-row-view]');
        if (viewSelect) {
          const rowId = Number(viewSelect.dataset.ccRowView);
          const nextView = viewSelect.value;
          // A focused table control suppresses tbody rebuilds to preserve the
          // caret. Blur before moving so the row immediately relocates under
          // its new OUTER/INNER band.
          viewSelect.blur();
          ccMoveRowView(ccRowById(rowId), nextView);
          return;
        }
        const areaSelect = event.target.closest('[data-cc-row-area]');
        if (areaSelect) {
          const row = ccRowById(Number(areaSelect.dataset.ccRowArea));
          if (!row) return;
          row.area = ccNormalizeArea(areaSelect.value);
          ccDrawCanvas();
          pushHistoryIfChanged();
        }
      });
      tableBody.addEventListener('focusout', event => {
        if (event.target.closest('[data-cc-row-detail]')) {
          pushHistoryIfChanged();
          setTimeout(ccRenderTable, 0);
        }
      });
      tableBody.addEventListener('keydown', event => {
        const detail = event.target.closest('[data-cc-row-detail]');
        if (!detail || event.key !== 'Enter') return;
        if (event.shiftKey) return;
        event.preventDefault();
        detail.blur();
      });
      tableBody.addEventListener('click', event => {
        const phrase = event.target.closest('[data-cc-phrase-row]');
        if (phrase) { ccOpenPhraseMenu(Number(phrase.dataset.ccPhraseRow), phrase); return; }
        const callout = event.target.closest('[data-cc-row-callout]');
        if (callout) { callout.blur(); ccArmRowCallout(Number(callout.dataset.ccRowCallout)); return; }
        const remove = event.target.closest('[data-cc-row-del]');
        if (remove) { remove.blur(); ccDeleteRow(Number(remove.dataset.ccRowDel)); return; }
        const add = event.target.closest('[data-cc-add-row]');
        if (add) { add.blur(); ccAddRow(add.dataset.ccAddRow); return; }
        if (event.target.closest('select,textarea,button')) return;
        const tr = event.target.closest('tr[data-cc-row]');
        if (!tr) return;
        const row = ccRowById(Number(tr.dataset.ccRow));
        if (!row) return;
        ccSelectedRowId = row.id;
        ccActiveView = row.view;
        const existing = ccCalloutForRow(row.id);
        ccSelectedCalloutId = existing ? existing.id : null;
        renderConstruction();
      });
    }

    const phraseSearch = document.getElementById('ccPhraseSearch');
    const phraseList = document.getElementById('ccPhraseList');
    if (phraseSearch) phraseSearch.addEventListener('input', ccRenderPhraseList);
    if (phraseList) phraseList.addEventListener('click', event => {
      const button = event.target.closest('[data-cc-phrase]');
      if (button) ccApplyPhrase(Number(button.dataset.ccPhrase));
    });
    document.addEventListener('click', event => {
      const menu = document.getElementById('ccPhraseMenu');
      if (menu && !menu.hidden && !event.target.closest('#ccPhraseMenu,[data-cc-phrase-row]')) ccClosePhraseMenu();
    });
    document.addEventListener('paste', async event => {
      if (state.activePage !== 'construction') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
      const files = Array.from((event.clipboardData && event.clipboardData.items) || [])
        .filter(item => item.kind === 'file' && /^image\//i.test(item.type || ''))
        .map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      await ccAddImageFiles(files, ccSheet, ccActiveView);
    }, true);
    document.addEventListener('keydown', event => {
      if (state.activePage !== 'construction') return;
      if (event.key === 'Escape') {
        if (ccTool !== 'select') { ccSetTool('select'); return; }
        if (ccSelectedCalloutId != null || ccSelectedImageId != null || ccSelectedRowId != null) {
          ccSelectedCalloutId = null; ccSelectedImageId = null; ccSelectedRowId = null; renderConstruction(); return;
        }
        setActivePage('board');
        return;
      }
      if (event.key === 'Backspace') {
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
        if (ccSelectedCallout()) { event.preventDefault(); ccDeleteSelectedCallout(); }
      }
    }, true);
    renderConstruction();
  }
