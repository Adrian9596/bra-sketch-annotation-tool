// BOM page — factory-format table + print-sheet rendering, including the
// bilingual header, the material-key SVG markup and bmPrintSheetHtml, which
// the tech-pack workbook export reads directly (US-072/US-073/US-079, ADR
// 0041). Source part for app.js. Run `npm run build` after editing. Loads
// after bom-state.js, bom-images.js, bom-materials.js and bom-canvas.js —
// renderBom here drives bmRenderTable, bmDrawCanvas, bmRenderCalloutSidePanel
// and bmSyncToolUi.
//
// Colorway columns finally consume state.mainPage.colorways — ADR 0037
// named this "knowingly inert" pending exactly this feature.

  function bmSyncVariantTabs() {
    document.querySelectorAll('[data-bom-variant]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.bomVariant === bmVariant));
    });
  }

  function bmSyncSelectedRowClass() {
    document.querySelectorAll('#bomSections tr[data-bom-row]').forEach(tr => {
      tr.classList.toggle('bm-row-selected', String(bmSelectedRowId) === tr.dataset.bomRow);
    });
  }

  /* ---- Rendering ----------------------------------------------------------- */

  function renderBom() {
    if (!state.bom) return;
    if (bmTool === 'leader' && !bmSelectedCallout()) bmTool = 'select';
    bmRenderTable();
    bmDrawCanvas();
    bmRenderCalloutSidePanel();
    bmSyncToolUi();
  }

  // One factory-style table per sheet — section band rows (MAIN BODY
  // FABRICS / TRIMS / COMPONENTS) with the header row repeated under each
  // band and an add-row line per section, matching the reference sheet's
  // renderTable() structure. Numbering runs continuously across sections.
  // Bilingual header row shared by the screen table and the print sheets —
  // EN label + the reference's verbatim 中文 string in a .bm-cn span (a
  // sibling of the text, mirroring the reference's <span class='cn'>).
  function bmHeaderRowHtml(colorways, withActCol) {
    return '<tr class="bm-hdr"><th class="bm-num">#</th>'
      + BM_CELL_FIELDS.map(f => '<th>' + escapeHtml(BM_CELL_LABELS[f])
        + '<span class="bm-cn">' + BM_CELL_LABELS_CN[f] + '</span></th>').join('')
      + '<th>' + BM_PHOTO_LABEL + '<span class="bm-cn">' + BM_PHOTO_LABEL_CN + '</span></th>'
      + colorways.map(c => '<th>' + escapeHtml(c.col) + '</th>').join('')
      + (withActCol ? '<th class="act">&middot;</th>' : '')
      + '</tr>';
  }

  function bmColgroupHtml(colorways, withActCol) {
    return '<colgroup>'
      + '<col class="bm-col-num">'
      + '<col class="bm-col-description"><col class="bm-col-composition">'
      + '<col class="bm-col-supplier"><col class="bm-col-article">'
      + '<col class="bm-col-width"><col class="bm-col-size">'
      + '<col class="bm-col-area"><col class="bm-col-photo">'
      + colorways.map(() => '<col class="bm-col-colorway">').join('')
      + (withActCol ? '<col class="bm-col-actions">' : '')
      + '</colgroup>';
  }

  // Reference .sheethead: a style meta line (.shl) + the sheet name (.shm),
  // composed live from MAIN PAGE fields — Range Name, Style No, tech-pack
  // creation date — skipping blanks and TBC placeholders.
  // The style meta line as plain text — shared by the HTML sheet head and
  // the tech-pack Excel meta row (US-079), so both always agree.
  function bmSheetMetaText() {
    const fields = (state.mainPage && state.mainPage.fields) || [];
    const val = re => {
      const hit = fields.find(f => re.test(String((f && f.label) || '')));
      const v = hit ? String(hit.value || '').trim() : '';
      return /^TBC$/i.test(v) ? '' : v;
    };
    const styleNo = val(/^Style No\s*-/i);
    return [
      val(/^Range Name\b/i),
      styleNo ? 'Style # ' + styleNo : '',
      val(/Tech Pack Creation date/i),
    ].filter(Boolean).join(' · ');
  }

  function bmSheetHeadHtml(variant) {
    return '<div class="bm-sheet-head"><div class="bm-shl">'
      + escapeHtml(bmSheetMetaText()) + '</div><div class="bm-shm">BOM-'
      + String(variant).toUpperCase() + '</div></div>';
  }

  function bmRenderTable() {
    const host = document.getElementById('bomSections');
    if (!host) return;
    const sheetHead = document.getElementById('bomSheetHead');
    if (sheetHead) sheetHead.innerHTML = bmSheetHeadHtml(bmVariant);
    const colorways = (state.mainPage && state.mainPage.colorways) || [];
    const span = 1 + BM_CELL_FIELDS.length + 1 + colorways.length + 1;
    const hdr = bmHeaderRowHtml(colorways, true);
    const numbered = bmNumberedRows(bmVariant);
    let html = '';
    BM_SECTIONS.forEach(section => {
      html += '<tr><td class="bm-secband" colspan="' + span + '">'
        + escapeHtml(BM_SECTION_BANDS[section]) + '</td></tr>' + hdr;
      html += numbered.filter(x => x.row.section === section)
        .map(x => bmRenderRow(x.row, x.seq, colorways)).join('');
      html += '<tr class="bm-addrow-tr"><td colspan="' + span + '">'
        + '<button type="button" class="bm-addrow" data-bom-add="' + section + '">&#65291; Dòng '
        + escapeHtml(section) + '</button></td></tr>';
    });
    host.innerHTML = '<div class="bm-band">Bill of Materials Sheet</div>'
      + '<table class="bm-table">' + bmColgroupHtml(colorways, true)
      + '<tbody>' + html + '</tbody></table>';
    bmRenderPrintSheets();
  }

  // Print parity (US-073): the reference prints BOM-SOLID then BOM-LACE as
  // two factory sheets regardless of which tab is open on screen. Rendered
  // into a print-only container (#bomPrintSheets, shown by the @media print
  // rules) so the interactive screen table — and every #bomSections-scoped
  // selector bom-check relies on — stays untouched. No editor affordances
  // here: no ▾, no action column, no add-row line, plain text cells.
  function bmRenderPrintSheets() {
    const host = document.getElementById('bomPrintSheets');
    if (!host) return;
    host.innerHTML = ['solid', 'lace'].map(variant =>
      '<section class="bm-print-sheet">' + bmPrintSheetHtml(variant) + '</section>').join('');
  }

  // One variant's full factory sheet (head + material key + table) as plain
  // non-interactive HTML. Extracted from bmRenderPrintSheets (US-079) so the
  // Preview & Export page shows the exact same sheet the print path produces.
  function bmPrintSheetHtml(variant) {
    const colorways = (state.mainPage && state.mainPage.colorways) || [];
    const span = 1 + BM_CELL_FIELDS.length + 1 + colorways.length;
    const hdr = bmHeaderRowHtml(colorways, false);
    const numbered = bmNumberedRows(variant);
    let html = '';
    BM_SECTIONS.forEach(section => {
      html += '<tr><td class="bm-secband" colspan="' + span + '">'
        + escapeHtml(BM_SECTION_BANDS[section]) + '</td></tr>' + hdr;
      html += numbered.filter(x => x.row.section === section)
        .map(x => bmRenderPrintRow(x.row, x.seq, colorways)).join('');
    });
    return '<div class="bm-sheet">' + bmSheetHeadHtml(variant)
      + '<div class="bm-band bm-band-big">Fabric and Trim Requirement</div>'
      + bmPrintMaterialKeyHtml(variant)
      + '<div class="bm-band">Bill of Materials Sheet</div>'
      + '<table class="bm-table">' + bmColgroupHtml(colorways, false)
      + '<tbody>' + html + '</tbody></table></div>';
  }

  function bmPrintMaterialKeyHtml(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return '<div class="bm-print-matkey bm-print-matkey-empty"></div>';
    const W = 1900, H = 820, pad = 55;
    const bounds = bmImageBounds(variant);
    const scale = Math.min((W - pad * 2) / bounds.width, (H - pad * 2) / bounds.height);
    const offX = (W - bounds.width * scale) / 2 - bounds.x * scale;
    const offY = (H - bounds.height * scale) / 2 - bounds.y * scale;
    const project = pt => ({ x: pt.x * scale + offX, y: pt.y * scale + offY });
    const imageHtml = images.map(image => {
      const dataURL = bmImageDataById.get(image.id);
      if (!dataURL) return '';
      const p = project({ x: image.x, y: image.y });
      return '<img src="' + dataURL + '" alt="" style="left:' + (p.x / W * 100)
        + '%;top:' + (p.y / H * 100) + '%;width:' + (image.width * scale / W * 100)
        + '%;height:' + (image.height * scale / H * 100) + '%">';
    }).join('');
    let svg = '';
    let labels = '';
    const callouts = ((state.bom && state.bom.callouts) || [])
      .filter(callout => bmVariantKey(callout.variant) === bmVariantKey(variant));
    callouts.forEach(callout => {
      const image = bmImageById(callout.imageId, variant);
      if (!image) return;
      const label = project(bmWorldOf(image, callout.textPos));
      const text = bmCalloutLabelTextForVariant(callout, variant);
      const labelBox = { x: label.x - 4, y: label.y - 9, width: Math.max(20, text.length * 6.5 + 8), height: 18 };
      (callout.targets || []).forEach(target => {
        const pin = project(bmWorldOf(image, target));
        const edge = bmEdgeToward(labelBox, pin.x, pin.y) || label;
        svg += '<line x1="' + edge.x + '" y1="' + edge.y + '" x2="' + pin.x + '" y2="' + pin.y + '"></line>'
          + '<circle cx="' + pin.x + '" cy="' + pin.y + '" r="7"></circle>';
      });
      labels += '<div class="bm-print-label" style="left:' + (label.x / W * 100)
        + '%;top:' + (label.y / H * 100) + '%">' + escapeHtml(text) + '</div>';
    });
    return '<div class="bm-print-matkey">' + imageHtml
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + svg + '</svg>'
      + labels + '</div>';
  }

  function bmCalloutLabelTextForVariant(callout, variant) {
    const row = bmRowById(callout.rowId);
    if (!row) return '? deleted BOM row';
    const base = bmRowBase(callout.rowId, variant);
    return (base || '?') + '. ' + (bmShortLabel(row.cells.description) || '(empty)');
  }

  function bmRenderPrintRow(row, seq, colorways) {
    const cells = BM_CELL_FIELDS.map(f => '<td>' + escapeHtml(row.cells[f] || '') + '</td>').join('');
    const photo = '<td class="bm-photo-cell">'
      + (row.photo && row.photo.dataURL ? '<img src="' + row.photo.dataURL + '" alt="">' : '')
      + '</td>';
    const cw = colorways.map(c => '<td>' + escapeHtml(bmCwValue(row, c)) + '</td>').join('');
    return '<tr><td class="bm-num">' + seq + '</td>' + cells + photo + cw + '</tr>';
  }

  function bmRenderRow(row, seq, colorways) {
    // Editable content lives in an inner span (reference structure): the ▾
    // suggestion button is a plain sibling of the span, so it can never be
    // typed over or swallowed into the cell's textContent.
    const cells = BM_CELL_FIELDS.map(f => {
      const suggestable = BM_SUGGESTABLE_FIELDS.indexOf(f) !== -1;
      return '<td' + (suggestable ? ' class="bm-sugg"' : '') + '>'
        + '<span contenteditable spellcheck="false" data-row="' + row.id + '" data-cell="' + f + '">'
        + escapeHtml(row.cells[f] || '') + '</span>'
        + (suggestable
          ? '<button type="button" class="bm-dd" data-bom-dd="' + row.id + '|' + f
            + '" title="Suggestions from the material library — pick by hand, never auto-filled"></button>'
          : '')
        + '</td>';
    }).join('');
    const photoCell = '<td class="bm-photo-cell"><button type="button" class="bm-photo-trigger" data-bom-photo="'
      + row.id + '" title="Material photo — upload or paste an image">'
      + (row.photo && row.photo.dataURL ? '<img src="' + row.photo.dataURL + '" alt="">' : '+')
      + '</button></td>';
    const cw = colorways.map(c =>
      '<td contenteditable spellcheck="false" data-row="' + row.id + '" data-cw="' + escapeHtml(c.col) + '">'
      + escapeHtml(bmCwValue(row, c)) + '</td>').join('');
    const scope = row.scope || 'BOTH';
    const act = '<td class="act">'
      + '<button type="button" data-row="' + row.id + '" data-bom-mk title="Place this row&#39;s numbered callout on the Material Key">&#8853;</button>'
      + '<button type="button" data-row="' + row.id + '" data-bom-split title="Split into a size pair (.1/.2)">&#9112;</button>'
      + '<button type="button" data-row="' + row.id + '" data-bom-rm title="Delete row">&times;</button>'
      + '<select data-row="' + row.id + '" data-scope aria-label="Scope" title="Which sheet prints this row">'
      + ['BOTH', 'SOLID', 'LACE'].map(s =>
        '<option value="' + s + '"' + (scope === s ? ' selected' : '') + '>' + s + '</option>').join('')
      + '</select></td>';
    const selectedCls = row.id === bmSelectedRowId ? ' class="bm-row-selected"' : '';
    return '<tr data-bom-row="' + row.id + '"' + selectedCls + '>'
      + '<td class="bm-num">' + seq + '</td>' + cells + photoCell + cw + act + '</tr>';
  }
