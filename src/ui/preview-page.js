// Preview & Export page (US-079, ADR 0046). Source part for app.js.
// Run `npm run build` after editing.
//
// Fifth tech-pack tab: the whole tech pack as A4 sheets stacked vertically
// in the fixed contract order — MAIN PAGE (portrait), CONSTRUCTION SOLID and
// LACE (landscape), BOM-SOLID and BOM-LACE (portrait), POM / How to Measure
// (landscape). Each sheet has an include checkbox persisted in the project
// (state.preview.enabledPages); "Export Tech Pack (.xlsx)" writes only the
// enabled sheets as one multi-sheet workbook (see export-xlsx.js).
//
// Preview fidelity is CONTENT on paper, not an Excel-pixel simulation
// (ADR 0046 §4): cell-based sheets render as paper-styled DOM of the same
// live state the workbook reads; the two Construction sheets are drawn by
// ccRenderSheetToCanvas — the same function whose output the workbook embeds.

  const PV_SHEETS = [
    { key: 'mainpage', label: 'MAIN PAGE', orient: 'portrait' },
    { key: 'construction-solid', label: 'CONSTRUCTION - SOLID', orient: 'landscape' },
    { key: 'construction-lace', label: 'CONSTRUCTION - LACE', orient: 'landscape' },
    { key: 'bom-solid', label: 'BOM-SOLID', orient: 'portrait' },
    { key: 'bom-lace', label: 'BOM-LACE', orient: 'portrait' },
    { key: 'pom', label: 'POM / HOW TO MEASURE', orient: 'landscape' },
  ];

  // A4 at 96 dpi; .pv-paper uses these as CSS width/min-height.
  const PV_PAPER = { portrait: { w: 794, h: 1123 }, landscape: { w: 1123, h: 794 } };
  const PV_PAPER_PAD = 28;

  // Natural content widths wider than the paper: the fit transform in
  // pvFitPaper scales these down so the sheet is always fully visible.
  // BOM sheets keep the reference sheet's 1450px+ factory table; the MAIN
  // PAGE three-column layout is authored around ~1140px.
  const PV_NATURAL_WIDTH = { 'mainpage': 1140, 'bom-solid': 1502, 'bom-lace': 1502 };

  function ensurePreviewPage() {
    const pv = state.preview && typeof state.preview === 'object'
      ? state.preview
      : (state.preview = {});
    if (!pv.enabledPages || typeof pv.enabledPages !== 'object' || Array.isArray(pv.enabledPages)) {
      pv.enabledPages = {};
    }
    // Missing keys default to enabled — a legacy project (or a new sheet key
    // added later) previews complete rather than silently dropping pages.
    PV_SHEETS.forEach(sheet => {
      if (typeof pv.enabledPages[sheet.key] !== 'boolean') pv.enabledPages[sheet.key] = true;
    });
    return pv;
  }

  function pvEnabledSheets() {
    const pv = ensurePreviewPage();
    return PV_SHEETS.filter(sheet => pv.enabledPages[sheet.key]);
  }

  /* ---- Per-sheet content builders ---------------------------------------- */

  function pvMainPageHtml() {
    const mp = state.mainPage || {};
    const fields = mp.fields || [];
    const kvRows = fields.map(f => {
      const isBrand = /^\s*Brand\b/i.test(f.label || '');
      /* US-080: the breakdown row prints as its three captioned sub-cells,
         the same shape the page shows — the composite `value` is for readers
         that have no room for a sub-grid (the worksheet has its own rows). */
      if (f.parts && /Style No Breakdown/i.test(f.label || '')) {
        return '<tr class="mp-bd-headrow"><th class="mp-bd-blank"></th><td class="mp-bdhead">'
          + MP_BREAKDOWN_PARTS.map(p => '<span>' + escapeHtml(p.head) + '</span>').join('')
          + '</td></tr>'
          + '<tr><th>' + escapeHtml(f.label || '') + '</th><td class="mp-bdcell">'
          + MP_BREAKDOWN_PARTS.map(p => '<span class="mp-bd-sub">'
            + escapeHtml(String(f.parts[p.key] || '')) + '</span>').join('')
          + '</td></tr>';
      }
      const value = isBrand
        ? '<strong>' + escapeHtml(f.value || '') + '</strong>'
        : escapeHtml(f.value || '');
      return '<tr><th>' + escapeHtml(f.label || '') + '</th><td>' + value + '</td></tr>';
    }).join('');
    const cwRows = (mp.colorways || []).map((c, i) =>
      '<tr><th>' + escapeHtml(c.col || ('COL ' + (i + 1))) + '</th><td>'
      + escapeHtml(c.value || '') + '</td></tr>').join('');
    const versionPanel = (title, variant) =>
      '<div class="mp-vpanel"><div class="mp-vhead">' + title + '</div>'
      + '<div class="mp-sketchrow">' + mpSketchRowHtml(variant, false) + '</div>'
      + '<table class="mp-cwx"><tbody>' + cwRows + '</tbody></table></div>';
    return '<div class="mp-sheet pv-mp-sheet">'
      + '<div class="mp-sheethead"><div class="mp-shl">Bra Auto Measure</div>'
      + '<div class="mp-shm">MAIN PAGE</div>'
      + '<div class="mp-shr"><span class="mp-draft">DRAFT &middot; all measurements TBC</span></div></div>'
      + '<div class="mp-cols">'
      + '<div class="mp-col mp-col-fields"><table class="mp-kv"><tbody>' + kvRows + '</tbody></table>'
      + (String(mp.provenance || '').trim()
        ? '<div class="mp-note-label" style="margin-top:10px;">Provenance</div>'
          + '<div class="mp-note">' + escapeHtml(mp.provenance) + '</div>'
        : '')
      + '</div>'
      + '<div class="mp-col mp-col-version">' + versionPanel('Lace Version', 'lace') + '</div>'
      + '<div class="mp-col mp-col-version">' + versionPanel('Solid Version', 'solid') + '</div>'
      + '</div></div>';
  }

  function pvSpecTableHtml() {
    const annByPom = new Map();
    // US-096: the measurement set only. An unlabelled zigzag/cover/bartack
    // line is a construction mark and owns no POM row.
    for (const ann of measurementAnnotations()) annByPom.set(getLabelText(ann), ann);
    const pomKeys = specVisiblePomKeys(annByPom);
    const layout = selectedSizeRun();
    const fullIndexByLabel = new Map(SPEC_SIZE_RUN.map((c, i) => [c.label, i]));
    const head = '<tr><th>POM</th><th>Description - English</th>'
      + '<th>Description - Chinese</th><th>TOL</th>'
      + layout.map(col => '<th>' + escapeHtml(col.label) + '</th>').join('') + '</tr>';
    const rows = pomKeys.map(key => {
      const spec = getPomSpec(key);
      const run = buildFullSizeRun(key, annByPom);
      return '<tr><td class="pv-num">' + escapeHtml(key) + '</td>'
        + '<td>' + escapeHtml(spec.en) + '</td>'
        + '<td>' + escapeHtml(spec.zh) + '</td>'
        + '<td class="pv-num">'
        + (spec.tol ? escapeHtml(inchesToFractionOrDecimal(spec.tol)) : '') + '</td>'
        + layout.map(col => {
          const cell = run[fullIndexByLabel.get(col.label)];
          return '<td class="pv-num">'
            + (cell && cell.value != null ? escapeHtml(specNumberText(cell.value)) : '')
            + '</td>';
        }).join('') + '</tr>';
    }).join('');
    return '<table class="pv-spec"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
  }

  function pvPomSheetInto(inner) {
    const styleLabel = (state.styleId || '').trim() || 'Untitled';
    inner.innerHTML = '<div class="bm-band bm-band-big">Measurement Spec &middot; '
      + escapeHtml(styleLabel) + '</div>';
    const bounds = getContentBounds();
    if (bounds) {
      const canvas = renderBoardRegionToCanvas(bounds);
      canvas.className = 'pv-board';
      inner.appendChild(canvas);
    } else {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = 'Board is empty — add a sketch and apply POM lines first.';
      inner.appendChild(empty);
    }
    const table = document.createElement('div');
    table.innerHTML = pvSpecTableHtml();
    inner.appendChild(table.firstElementChild);
  }

  function pvFillPaper(sheet) {
    const paper = document.querySelector('[data-pv-paper="' + sheet.key + '"]');
    if (!paper) return;
    const inner = document.createElement('div');
    inner.className = 'pv-inner';
    paper.textContent = '';
    paper.appendChild(inner);
    if (sheet.key === 'mainpage') {
      inner.innerHTML = pvMainPageHtml();
    } else if (sheet.key === 'construction-solid' || sheet.key === 'construction-lace') {
      const variant = sheet.key.slice('construction-'.length);
      inner.innerHTML = '<div class="bm-band bm-band-big">Construction &middot; '
        + variant.toUpperCase() + ' &middot; Working Board</div>';
      const size = PV_PAPER.landscape;
      const canvas = ccRenderSheetToCanvas(
        variant, size.w - PV_PAPER_PAD * 2, size.h - PV_PAPER_PAD * 2 - 38, 2);
      canvas.className = 'pv-canvas';
      inner.appendChild(canvas);
    } else if (sheet.key === 'bom-solid' || sheet.key === 'bom-lace') {
      inner.innerHTML = bmPrintSheetHtml(sheet.key.slice('bom-'.length));
    } else if (sheet.key === 'pom') {
      pvPomSheetInto(inner);
    }
    pvFitPaper(paper, sheet);
  }

  // Content wider than the paper (BOM's 1450px factory table, the MAIN PAGE
  // three-column layout) is scaled down to fit the page width. transform
  // does not affect layout height, so the paper gets an explicit height to
  // avoid clipping tall scaled content while keeping the A4 minimum.
  function pvFitPaper(paper, sheet) {
    const inner = paper.firstElementChild;
    if (!inner) return;
    const size = PV_PAPER[sheet.orient];
    const avail = size.w - PV_PAPER_PAD * 2;
    const natural = PV_NATURAL_WIDTH[sheet.key] || 0;
    if (natural) inner.style.width = natural + 'px';
    const contentW = Math.max(inner.scrollWidth, natural);
    if (contentW > avail) {
      const scale = avail / contentW;
      if (!natural) inner.style.width = contentW + 'px';
      inner.style.transformOrigin = 'top left';
      inner.style.transform = 'scale(' + scale + ')';
      paper.style.height = Math.max(size.h, Math.ceil(inner.offsetHeight * scale) + PV_PAPER_PAD * 2) + 'px';
    } else {
      paper.style.height = Math.max(size.h, inner.offsetHeight + PV_PAPER_PAD * 2) + 'px';
    }
  }

  /* ---- Page rendering ----------------------------------------------------- */

  function pvSyncExportButton() {
    const btn = document.getElementById('pvExportXlsxBtn');
    if (!btn) return;
    const count = pvEnabledSheets().length;
    btn.disabled = count === 0;
    btn.textContent = '⬇ Export Tech Pack (.xlsx) — ' + count + '/' + PV_SHEETS.length + ' sheets';
  }

  function renderPreviewPage() {
    const host = document.getElementById('pvSheets');
    if (!host) return;
    const pv = ensurePreviewPage();
    if (typeof ensureMainPage === 'function') ensureMainPage();
    if (typeof ensureConstruction === 'function') ensureConstruction();
    if (typeof ensureBom === 'function') ensureBom();
    host.innerHTML = PV_SHEETS.map(sheet => {
      const on = !!pv.enabledPages[sheet.key];
      return '<section class="pv-sheet' + (on ? '' : ' pv-off') + '" data-pv-sheet="' + sheet.key + '">'
        + '<label class="pv-sheet-head">'
        + '<input type="checkbox" data-pv-toggle="' + sheet.key + '"' + (on ? ' checked' : '') + '>'
        + '<span class="pv-sheet-name">' + escapeHtml(sheet.label) + '</span>'
        + '<span class="pv-orient">A4 ' + sheet.orient + '</span></label>'
        + '<div class="pv-paper pv-' + sheet.orient + '" data-pv-paper="' + sheet.key + '"></div>'
        + '</section>';
    }).join('');
    PV_SHEETS.forEach(sheet => pvFillPaper(sheet));
    pvSyncExportButton();
  }

  function initPreviewPage() {
    // Materialize state.preview before seedHistory (same ordering contract
    // as initMainPage): the first history fingerprint must already contain
    // the default enabledPages, or the first tab visit would fabricate a
    // spurious undo step.
    ensurePreviewPage();
    const page = document.getElementById('previewPage');
    if (!page) return;
    page.addEventListener('change', (e) => {
      const box = e.target.closest('[data-pv-toggle]');
      if (!box) return;
      const pv = ensurePreviewPage();
      pv.enabledPages[box.dataset.pvToggle] = box.checked;
      const section = page.querySelector('[data-pv-sheet="' + box.dataset.pvToggle + '"]');
      if (section) section.classList.toggle('pv-off', !box.checked);
      pvSyncExportButton();
      pushHistoryIfChanged();
    });
    const btn = document.getElementById('pvExportXlsxBtn');
    if (btn) btn.addEventListener('click', () => { void exportTechPackXlsx(); });
  }
