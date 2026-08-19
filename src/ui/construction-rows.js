// Construction working sheets (US-078, ADR 0045) — row/callout lookup
// accessors, row CRUD, the "arm the next missing row" callout workflow, the
// editable row table markup, and the construction-phrase quick picker.
// Source part for app.js. Run `npm run build` after editing.
//
// Must load after construction-phrase-data.js: CONSTRUCTION_PHRASES below is
// built by an IIFE that runs at load time over that file's three arrays.
//
// One row owns at most one callout. Callout number/area/detail are derived
// live from the row; only label and target geometry (construction-canvas.js)
// is independently edited.

  let ccPhraseRowId = null;
  let ccPhraseHits = [];

  const CONSTRUCTION_PHRASES = (function () {
    const seen = new Set();
    const out = [];
    function add(text, extra) {
      const clean = String(text || '').trim();
      const key = clean.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(Object.assign({ text: clean }, extra || {}));
    }
    CONSTRUCTION_STARTER_PHRASES.forEach(p => add(p.text, { favorite: !!p.favorite }));
    CONSTRUCTION_TERM_LIBRARY.forEach(t => add(t.en));
    CONSTRUCTION_GENERATED_PHRASES.forEach(p => add(p.text));
    return out;
  })();

  function ccRows(sheet) {
    const key = ccSheetKey(sheet);
    const rows = ensureConstruction().rows.filter(row => row.sheet === key);
    return rows.slice().sort((a, b) => {
      const va = CC_VIEWS.indexOf(a.view), vb = CC_VIEWS.indexOf(b.view);
      if (va !== vb) return va - vb;
      return ensureConstruction().rows.indexOf(a) - ensureConstruction().rows.indexOf(b);
    });
  }

  function ccRowsForView(view, sheet) {
    const key = ccViewKey(view);
    return ccRows(sheet).filter(row => row.view === key);
  }

  function ccRowById(id) {
    return ensureConstruction().rows.find(row => row.id === id) || null;
  }

  function ccRowSeq(id, sheet) {
    const index = ccRows(sheet).findIndex(row => row.id === id);
    return index === -1 ? '' : String(index + 1);
  }

  function ccCalloutForRow(rowId) {
    return ensureConstruction().callouts.find(callout => callout.rowId === rowId) || null;
  }

  function ccVisibleCallouts() {
    return ensureConstruction().callouts.filter(callout => callout.sheet === ccSheet);
  }

  function ccSelectedCallout() {
    return ccVisibleCallouts().find(callout => callout.id === ccSelectedCalloutId) || null;
  }

  function ccAddRow(view) {
    const row = {
      id: state.idCounter++, sheet: ccSheet, view: ccViewKey(view), area: 'CUP', detail: '',
    };
    ensureConstruction().rows.push(row);
    ccSelectedRowId = row.id;
    ccActiveView = row.view;
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccDeleteRow(rowId) {
    const cc = ensureConstruction();
    const index = cc.rows.findIndex(row => row.id === rowId);
    if (index === -1) return;
    const callout = ccCalloutForRow(rowId);
    cc.rows.splice(index, 1);
    if (callout) cc.callouts = cc.callouts.filter(item => item.id !== callout.id);
    if (ccSelectedRowId === rowId) ccSelectedRowId = null;
    if (callout && ccSelectedCalloutId === callout.id) ccSelectedCalloutId = null;
    if (ccTool === 'leader' && !ccSelectedCallout()) ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
    showToast('Construction row deleted · Ctrl/Cmd+Z to undo');
  }

  function ccMoveRowView(row, nextView) {
    const view = ccViewKey(nextView);
    if (!row || row.view === view) return;
    const callout = ccCalloutForRow(row.id);
    if (callout) {
      state.construction.callouts = state.construction.callouts.filter(item => item.id !== callout.id);
      if (ccSelectedCalloutId === callout.id) ccSelectedCalloutId = null;
    }
    row.view = view;
    ccActiveView = view;
    if (ccTool === 'leader') ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
    showToast(callout ? 'Row moved to ' + view.toUpperCase() + '; old-view callout removed · Undo restores both' : 'Row moved to ' + view.toUpperCase());
  }

  function ccMissingRows() {
    return ccRows(ccSheet).filter(row => !ccCalloutForRow(row.id));
  }

  function ccNextMissingRow(afterId) {
    const rows = ccRows(ccSheet);
    const start = Math.max(-1, rows.findIndex(row => row.id === afterId));
    for (let step = 1; step <= rows.length; step += 1) {
      const row = rows[(start + step) % rows.length];
      if (!ccCalloutForRow(row.id)) return row;
    }
    return null;
  }

  function ccArmRowCallout(rowId) {
    const row = ccRowById(rowId);
    if (!row || row.sheet !== ccSheet) return;
    ccSelectedRowId = row.id;
    ccActiveView = row.view;
    const callout = ccCalloutForRow(row.id);
    if (callout) {
      ccSelectedCalloutId = callout.id;
      ccSelectedImageId = null;
      ccSetTool('select');
      showToast('Selected the existing callout for Construction row ' + ccRowSeq(row.id));
    } else {
      ccSelectedCalloutId = null;
      ccSelectedImageId = null;
      ccSetTool('callout');
      showToast('Click an image in ' + row.view.toUpperCase() + ' to place row ' + ccRowSeq(row.id));
    }
    renderConstruction();
  }

  function ccStartCalloutTool(preferredRowId) {
    const missing = ccMissingRows();
    if (!missing.length) {
      ccSetTool('select');
      showToast('Every Construction row on this sheet already has a callout');
      return;
    }
    const row = missing.find(item => item.id === preferredRowId)
      || missing.find(item => item.id === ccSelectedRowId)
      || missing[0];
    ccSelectedRowId = row.id;
    ccSelectedCalloutId = null;
    ccSelectedImageId = null;
    ccActiveView = row.view;
    ccSetTool('callout');
    renderConstruction();
  }

  function ccSetTool(tool) {
    if (!['select', 'callout', 'leader'].includes(tool)) tool = 'select';
    if (tool === 'leader' && !ccSelectedCallout()) {
      showToast('Select a Construction callout before adding leaders');
      tool = 'select';
    }
    ccTool = tool;
    ccSyncUi();
  }

  function ccDeleteSelectedCallout() {
    const callout = ccSelectedCallout();
    if (!callout) return;
    state.construction.callouts = state.construction.callouts.filter(item => item.id !== callout.id);
    ccSelectedCalloutId = null;
    if (ccTool === 'leader') ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccAreaOptions(selected) {
    return CC_AREAS.map(area => '<option value="' + area + '"' + (area === selected ? ' selected' : '') + '>' + escapeHtml(CC_AREA_LABELS[area]) + '</option>').join('');
  }

  function ccRowHtml(row) {
    const callout = ccCalloutForRow(row.id);
    const selected = row.id === ccSelectedRowId || (callout && callout.id === ccSelectedCalloutId);
    return '<tr data-cc-row="' + row.id + '"' + (selected ? ' class="cc-row-selected"' : '') + '>'
      + '<td class="cc-tbl-seq">' + ccRowSeq(row.id) + '</td>'
      + '<td class="cc-tbl-view"><select data-cc-row-view="' + row.id + '" aria-label="Construction view">'
      + '<option value="outer"' + (row.view === 'outer' ? ' selected' : '') + '>Outer</option>'
      + '<option value="inner"' + (row.view === 'inner' ? ' selected' : '') + '>Inner</option></select></td>'
      + '<td class="cc-tbl-area"><select data-cc-row-area="' + row.id + '" aria-label="Construction area">' + ccAreaOptions(row.area) + '</select></td>'
      + '<td class="cc-tbl-detail"><div class="cc-detail-wrap"><textarea rows="1" spellcheck="false" data-cc-row-detail="' + row.id + '" aria-label="Construction detail">' + escapeHtml(row.detail) + '</textarea>'
      + '<button type="button" data-cc-phrase-row="' + row.id + '" title="Choose a construction phrase">&#9662;</button></div></td>'
      + '<td class="cc-tbl-callout"><button type="button" data-cc-row-callout="' + row.id + '" title="' + (callout ? 'Select existing callout' : 'Place callout') + '">' + (callout ? '&#9679;' : '&#8853;') + '</button></td>'
      + '<td class="cc-tbl-del"><button type="button" data-cc-row-del="' + row.id + '" title="Delete row">&#10005;</button></td>'
      + '</tr>';
  }

  function ccRenderTable() {
    const body = document.getElementById('ccTableBody');
    if (!body) return;
    const active = document.activeElement;
    if (active && body.contains(active)) return;
    body.innerHTML = CC_VIEWS.map(view => {
      const rows = ccRowsForView(view, ccSheet);
      return '<tr class="cc-view-band"><th colspan="6">' + view.toUpperCase() + '</th></tr>'
        + rows.map(ccRowHtml).join('')
        + '<tr class="cc-add-row"><td colspan="6"><button type="button" data-cc-add-row="' + view + '">&#65291; Add ' + view + ' row</button></td></tr>';
    }).join('');
  }

  function ccOpenPhraseMenu(rowId, button) {
    ccPhraseRowId = rowId;
    ccSelectedRowId = rowId;
    const row = ccRowById(rowId);
    if (row) ccActiveView = row.view;
    const menu = document.getElementById('ccPhraseMenu');
    const search = document.getElementById('ccPhraseSearch');
    if (!menu || !search) return;
    search.value = '';
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 390)) + 'px';
    menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 330) + 'px';
    ccRenderPhraseList();
    search.focus();
    renderConstruction();
  }

  function ccClosePhraseMenu() {
    const menu = document.getElementById('ccPhraseMenu');
    if (menu) menu.hidden = true;
    ccPhraseRowId = null;
  }

  function ccRenderPhraseList() {
    const search = document.getElementById('ccPhraseSearch');
    const list = document.getElementById('ccPhraseList');
    if (!list) return;
    const tokens = String((search && search.value) || '').toLowerCase().split(/\s+/).filter(Boolean);
    ccPhraseHits = (tokens.length
      ? CONSTRUCTION_PHRASES.filter(item => tokens.every(token => item.text.toLowerCase().includes(token)))
      : CONSTRUCTION_PHRASES.filter(item => item.favorite)).slice(0, 60);
    list.innerHTML = ccPhraseHits.map((item, index) => '<button type="button" data-cc-phrase="' + index + '">' + escapeHtml(item.text) + '</button>').join('')
      || '<div class="cc-phrase-empty">No matching phrase</div>';
  }

  function ccApplyPhrase(index) {
    const row = ccRowById(ccPhraseRowId);
    const item = ccPhraseHits[index];
    if (!row || !item) return;
    row.detail = item.text;
    ccClosePhraseMenu();
    renderConstruction();
    pushHistoryIfChanged();
  }
