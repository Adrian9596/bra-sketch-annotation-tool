// Export Excel — the 6-sheet tech-pack workbook (US-079, ADR 0046): one
// worksheet per enabled Preview & Export sheet, in the preview's fixed
// order. MAIN PAGE and the two BOM sheets are real cells; the two
// Construction sheets and every board/photo/material-key image are
// embedded PNGs. The POM sheet reuses buildSpecSheetRows (defined in the
// sibling export-spec-xlsx.js, which loads before this file) — the exact
// grid the Board "Export Excel" button writes, which stays untouched.
// Source part for app.js. Run `npm run build` after editing.
//
// Grading math lives in export-xlsx-grading.js; the generic OOXML+ZIP
// toolkit lives in xlsx-writer.js — both load before this file, as does
// export-spec-xlsx.js.

  // ---- Tech-pack multi-sheet workbook (US-079, ADR 0046) ----
  //
  // One workbook, one worksheet per ENABLED Preview & Export sheet, in the
  // preview's fixed order. MAIN PAGE and the two BOM sheets are real cells;
  // the two Construction sheets and every board/photo/material-key image are
  // embedded PNGs. The POM sheet reuses buildSpecSheetRows — the exact grid
  // the Board "Export Excel" button writes, which stays untouched.

  const TECHPACK_SHEET_NAMES = {
    'mainpage': 'MAIN PAGE',
    'construction-solid': 'CONSTRUCTION-SOLID',
    'construction-lace': 'CONSTRUCTION-LACE',
    'bom-solid': 'BOM-SOLID',
    'bom-lace': 'BOM-LACE',
    'pom': 'Measurement Spec',
  };

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(result => {
        if (!result) { reject(new Error('canvas.toBlob produced no data')); return; }
        result.arrayBuffer().then(buffer => resolve({
          bytes: new Uint8Array(buffer), width: canvas.width, height: canvas.height,
        }), reject);
      }, 'image/png');
    });
  }

  // Row-photo dataURLs can be any raster type the TD pasted; re-encode to
  // PNG (capped) so the workbook only ever embeds one image format and one
  // [Content_Types] default covers all media parts.
  async function pngBytesFromDataURL(dataURL, maxDim) {
    const img = await loadImageFromDataURL(dataURL);
    const natW = img.naturalWidth || img.width || 1;
    const natH = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, (maxDim || 800) / Math.max(natW, natH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(natW * scale));
    canvas.height = Math.max(1, Math.round(natH * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasToPngBytes(canvas);
  }

  // Generic worksheet XML: optional per-column widths, sparse rows allowed,
  // no merges. The POM sheet keeps using buildSpecSheetXml (its merges and
  // column grid are part of the byte-stable single-sheet contract).
  function buildTechPackSheetXml(rowsData, colWidths, hasDrawing) {
    const lastRow = rowsData.length ? rowsData[rowsData.length - 1].r : 1;
    const lastCol = specColLetter(Math.max(0, (colWidths ? colWidths.length : 1) - 1));
    const cols = colWidths && colWidths.length
      ? '<cols>' + colWidths.map((w, i) =>
        '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>'
      : '';
    const rows = rowsData.map(row =>
      '<row r="' + row.r + '"' + (row.ht ? ' ht="' + row.ht + '" customHeight="1"' : '') + '>'
      + row.cells.join('') + '</row>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<dimension ref="A1:' + lastCol + lastRow + '"/>'
      + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      + cols
      + '<sheetData>' + rows + '</sheetData>'
      + (hasDrawing ? '<drawing r:id="rId1"/>' : '')
      + '</worksheet>';
  }

  // One drawing part per sheet, any number of oneCellAnchor images. Image k
  // binds to the drawing rels' rId(k+1); explicit EMU extents keep aspect
  // ratios identical across viewers (same rationale as buildSpecDrawingXml).
  function buildTechPackDrawingXml(images) {
    const anchors = images.map((image, i) => {
      const cx = Math.round(image.displayWidth * 9525);
      const cy = Math.round(image.displayHeight * 9525);
      return '<xdr:oneCellAnchor>'
        + '<xdr:from><xdr:col>' + (image.anchorCol || 0) + '</xdr:col><xdr:colOff>0</xdr:colOff>'
        + '<xdr:row>' + (image.anchorRow || 0) + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
        + '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>'
        + '<xdr:pic>'
        + '<xdr:nvPicPr><xdr:cNvPr id="' + (i + 2) + '" name="Image ' + (i + 1) + '"/>'
        + '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        + '<xdr:blipFill><a:blip r:embed="rId' + (i + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
        + '</xdr:pic>'
        + '<xdr:clientData/>'
        + '</xdr:oneCellAnchor>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'
      + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + anchors + '</xdr:wsDr>';
  }

  async function buildMainPageSheetPart(now) {
    const mp = state.mainPage || {};
    const rowsData = [];
    const images = [];
    const band = (r, styleId, text) => ({
      r, ht: r === 1 ? 26 : 18,
      cells: [specInlineStrCell('A' + r, styleId, text), specBlankCell('B' + r, styleId)],
    });
    rowsData.push(band(1, SPEC_XF.title, 'MAIN PAGE'));
    rowsData.push(band(2, SPEC_XF.styleRow,
      ((state.styleId || '').trim() || 'Untitled') + ' - ' + formatSpecDate(now)));
    let r = 3;
    (mp.fields || []).forEach(f => {
      /* US-080: a worksheet has no room for a three-cell sub-grid, so the
         breakdown's parts each get their own labelled row — the captions the
         factory reads are the sheet's own, never invented at export time. */
      if (f.parts && /Style No Breakdown/i.test(f.label || '')) {
        rowsData.push({ r, cells: [
          specInlineStrCell('A' + r, SPEC_XF.headLabel, f.label || ''),
          specInlineStrCell('B' + r, SPEC_XF.text, f.value || ''),
        ] });
        r += 1;
        MP_BREAKDOWN_PARTS.forEach(p => {
          rowsData.push({ r, cells: [
            specInlineStrCell('A' + r, SPEC_XF.text, '    ' + p.head),
            specInlineStrCell('B' + r, SPEC_XF.text, String(f.parts[p.key] || '')),
          ] });
          r += 1;
        });
        return;
      }
      rowsData.push({ r, cells: [
        specInlineStrCell('A' + r, SPEC_XF.headLabel, f.label || ''),
        specInlineStrCell('B' + r, SPEC_XF.text, f.value || ''),
      ] });
      r += 1;
    });
    r += 1;
    rowsData.push(band(r, SPEC_XF.styleRow, 'COLORWAYS'));
    r += 1;
    (mp.colorways || []).forEach((c, i) => {
      rowsData.push({ r, cells: [
        specInlineStrCell('A' + r, SPEC_XF.headLabel, c.col || ('COL ' + (i + 1))),
        specInlineStrCell('B' + r, SPEC_XF.text, c.value || ''),
      ] });
      r += 1;
    });
    /* Version sketches (US-080). A worksheet cannot put the two panels beside
       the field column the way the page does, so each version becomes its own
       band with its flats anchored under it; blank rows are reserved beneath
       the anchors (default row ≈ 20px) so nothing runs under an image. */
    for (const variant of MP_SKETCH_VARIANTS) {
      const present = MP_SKETCH_SLOTS
        .map((slot, i) => ({ slot, dataURL: mpSketchDataURL(variant, i) }))
        .filter(entry => entry.dataURL);
      if (!present.length) continue;
      r += 1;
      rowsData.push(band(r, SPEC_XF.styleRow, variant.toUpperCase() + ' VERSION'));
      r += 1;
      let blockRows = 0;
      let anchorCol = 0;
      for (const entry of present) {
        const png = await pngBytesFromDataURL(entry.dataURL, 1200);
        const displayWidth = 320;
        const displayHeight = Math.round(png.height * (displayWidth / png.width));
        rowsData.push({ r, cells: [
          specInlineStrCell(specColLetter(anchorCol) + r, SPEC_XF.headLabel, entry.slot.label),
        ] });
        images.push({ bytes: png.bytes, anchorCol, anchorRow: r, displayWidth, displayHeight });
        blockRows = Math.max(blockRows, Math.ceil(displayHeight / 20) + 1);
        anchorCol += 3;   // FRONT in A, BACK clear of it in D
      }
      r += blockRows;
    }
    if (String(mp.provenance || '').trim()) {
      r += 1;
      rowsData.push(band(r, SPEC_XF.styleRow, 'Provenance'));
      r += 1;
      rowsData.push({ r, cells: [
        specInlineStrCell('A' + r, SPEC_XF.text, mp.provenance),
        specBlankCell('B' + r, SPEC_XF.text),
      ] });
    }
    return {
      name: TECHPACK_SHEET_NAMES['mainpage'],
      sheetXml: buildTechPackSheetXml(rowsData, [34, 58, 12, 34, 24, 12], images.length > 0),
      images,
    };
  }

  async function buildConstructionSheetPart(key) {
    const variant = key.slice('construction-'.length);
    const image = await canvasToPngBytes(ccRenderSheetToCanvas(variant, 1440, 900, 2));
    const rowsData = [{ r: 1, ht: 26, cells: [specInlineStrCell(
      'A1', SPEC_XF.title, 'CONSTRUCTION - ' + variant.toUpperCase() + ' - WORKING BOARD')] }];
    const displayWidth = 1160;
    return {
      name: TECHPACK_SHEET_NAMES[key],
      sheetXml: buildTechPackSheetXml(rowsData, [150], true),
      images: [{
        bytes: image.bytes, anchorCol: 0, anchorRow: 2, displayWidth,
        displayHeight: Math.round(image.height * (displayWidth / image.width)),
      }],
    };
  }

  async function buildBomSheetPart(key, now) {
    const variant = key.slice('bom-'.length);
    const colorways = (state.mainPage && state.mainPage.colorways) || [];
    const colCount = 1 + BM_CELL_FIELDS.length + 1 + colorways.length;
    const photoColIdx = 1 + BM_CELL_FIELDS.length;
    const rowsData = [];
    const band = (r, styleId, text) => ({
      r, ht: r === 1 ? 26 : 18,
      cells: [specInlineStrCell('A' + r, styleId, text)].concat(
        Array.from({ length: colCount - 1 }, (_, i) => specBlankCell(specColLetter(i + 1) + r, styleId))),
    });
    rowsData.push(band(1, SPEC_XF.title, 'BOM-' + variant.toUpperCase() + ' - Fabric and Trim Requirement'));
    rowsData.push(band(2, SPEC_XF.styleRow, bmSheetMetaText() || formatSpecDate(now)));
    const headerCells = (r) => {
      const cells = [specInlineStrCell('A' + r, SPEC_XF.headLabel, '#')];
      BM_CELL_FIELDS.forEach((f, i) => cells.push(specInlineStrCell(
        specColLetter(1 + i) + r, SPEC_XF.headLabel, BM_CELL_LABELS[f] + '\n' + BM_CELL_LABELS_CN[f])));
      cells.push(specInlineStrCell(
        specColLetter(photoColIdx) + r, SPEC_XF.headLabel, BM_PHOTO_LABEL + '\n' + BM_PHOTO_LABEL_CN));
      colorways.forEach((c, i) => cells.push(specInlineStrCell(
        specColLetter(photoColIdx + 1 + i) + r, SPEC_XF.headAlpha, c.col || '')));
      return cells;
    };
    const images = [];
    const numbered = bmNumberedRows(variant);
    let r = 3;
    // Material Key sits ABOVE the table — same order as the BOM page and its
    // preview sheet (the factory reads the annotated key first). Blank rows
    // are reserved under the anchor (default row ≈ 20px) so the table never
    // runs beneath the image.
    if (bmVariantImages(variant).length) {
      rowsData.push(band(r, SPEC_XF.styleRow, 'MATERIAL KEY'));
      const matkey = await canvasToPngBytes(bmRenderMatkeyToCanvas(variant, 1400, 620, 2));
      const displayWidth = 1000;
      const displayHeight = Math.round(matkey.height * (displayWidth / matkey.width));
      images.push({ bytes: matkey.bytes, anchorCol: 0, anchorRow: r, displayWidth, displayHeight });
      r += 1 + Math.ceil(displayHeight / 20) + 1;
    }
    for (const section of BM_SECTIONS) {
      rowsData.push(band(r, SPEC_XF.styleRow, BM_SECTION_BANDS[section]));
      r += 1;
      rowsData.push({ r, ht: 28, cells: headerCells(r) });
      r += 1;
      for (const x of numbered.filter(n => n.row.section === section)) {
        const row = x.row;
        const cells = [specInlineStrCell('A' + r, SPEC_XF.textCenter, x.seq)];
        BM_CELL_FIELDS.forEach((f, i) => cells.push(specInlineStrCell(
          specColLetter(1 + i) + r, SPEC_XF.text, row.cells[f] || '')));
        cells.push(specBlankCell(specColLetter(photoColIdx) + r, SPEC_XF.text));
        colorways.forEach((c, i) => cells.push(specInlineStrCell(
          specColLetter(photoColIdx + 1 + i) + r, SPEC_XF.textCenter, bmCwValue(row, c))));
        const hasPhoto = !!(row.photo && row.photo.dataURL);
        rowsData.push(hasPhoto ? { r, ht: 58, cells } : { r, cells });
        if (hasPhoto) {
          const photo = await pngBytesFromDataURL(row.photo.dataURL, 400);
          const displayHeight = 72; // fits the 58pt (~77px) photo row
          images.push({
            bytes: photo.bytes, anchorCol: photoColIdx, anchorRow: r - 1,
            displayWidth: Math.max(1, Math.round(photo.width * (displayHeight / photo.height))),
            displayHeight,
          });
        }
        r += 1;
      }
    }
    const widths = [6, 26, 20, 18, 20, 12, 16, 22, 30].concat(colorways.map(() => 16));
    return {
      name: TECHPACK_SHEET_NAMES[key],
      sheetXml: buildTechPackSheetXml(rowsData, widths, images.length > 0),
      images,
    };
  }

  async function buildPomSheetPart(now) {
    const { rowsData, colCount, pomKeys } = buildSpecSheetRows(now);
    const image = await specBoardPngBytes();
    const hasImage = !!(image && image.bytes && image.bytes.length);
    const images = [];
    if (hasImage) {
      const displayWidth = Math.min(image.width, 1100);
      images.push({
        bytes: image.bytes, anchorCol: 0, anchorRow: 3 + pomKeys.length + 2,
        displayWidth,
        displayHeight: Math.round(image.height * (displayWidth / image.width)),
      });
    }
    return {
      name: TECHPACK_SHEET_NAMES['pom'],
      sheetXml: buildSpecSheetXml(rowsData, hasImage, colCount),
      images,
    };
  }

  function assembleTechPackZip(parts, now) {
    const encoder = new TextEncoder();
    const hasAnyImage = parts.some(p => p.images.length > 0);
    const wsType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + (hasAnyImage ? '<Default Extension="png" ContentType="image/png"/>' : '')
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + parts.map((p, i) =>
        '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="' + wsType + '"/>').join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + parts.map((p, i) => p.images.length
        ? '<Override PartName="/xl/drawings/drawing' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
        : '').join('')
      + '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';

    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>' + parts.map((p, i) =>
        '<sheet name="' + xmlEscape(p.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')
      + '</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + parts.map((p, i) =>
        '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')
      + '<Relationship Id="rId' + (parts.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes) },
      { name: '_rels/.rels', bytes: encoder.encode(rootRels) },
      { name: 'xl/workbook.xml', bytes: encoder.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(workbookRels) },
      { name: 'xl/styles.xml', bytes: encoder.encode(buildSpecStylesXml()) },
    ];

    let mediaIndex = 0;
    parts.forEach((p, i) => {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', bytes: encoder.encode(p.sheetXml) });
      if (!p.images.length) return;
      const sheetRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing' + (i + 1) + '.xml"/>'
        + '</Relationships>';
      const mediaNames = p.images.map(() => { mediaIndex += 1; return 'image' + mediaIndex + '.png'; });
      const drawingRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + p.images.map((img, k) =>
          '<Relationship Id="rId' + (k + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/' + mediaNames[k] + '"/>').join('')
        + '</Relationships>';
      files.push(
        { name: 'xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', bytes: encoder.encode(sheetRels) },
        { name: 'xl/drawings/drawing' + (i + 1) + '.xml', bytes: encoder.encode(buildTechPackDrawingXml(p.images)) },
        { name: 'xl/drawings/_rels/drawing' + (i + 1) + '.xml.rels', bytes: encoder.encode(drawingRels) }
      );
      p.images.forEach((img, k) => files.push({ name: 'xl/media/' + mediaNames[k], bytes: img.bytes }));
    });

    return zipStore(files, now);
  }

  // Enabled preview sheets → workbook bytes; null when nothing is ticked.
  async function buildTechPackXlsxBytes(now) {
    if (typeof ensureMainPage === 'function') ensureMainPage();
    if (typeof ensureConstruction === 'function') ensureConstruction();
    if (typeof ensureBom === 'function') ensureBom();
    const enabled = pvEnabledSheets();
    if (!enabled.length) return null;
    const parts = [];
    for (const sheet of enabled) {
      if (sheet.key === 'mainpage') parts.push(await buildMainPageSheetPart(now));
      else if (sheet.key.indexOf('construction-') === 0) parts.push(await buildConstructionSheetPart(sheet.key));
      else if (sheet.key.indexOf('bom-') === 0) parts.push(await buildBomSheetPart(sheet.key, now));
      else if (sheet.key === 'pom') parts.push(await buildPomSheetPart(now));
    }
    return assembleTechPackZip(parts, now);
  }

  function makeTechPackFileName(now) {
    const pad = (v) => String(v).padStart(2, '0');
    const styleSlug = ((state.styleId || '').trim() || 'untitled').replace(/[^\w\-]+/g, '_');
    return 'tech-pack-' + styleSlug + '-'
      + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.xlsx';
  }

  async function exportTechPackXlsx() {
    try {
      const now = new Date();
      const zipBytes = await buildTechPackXlsxBytes(now);
      if (!zipBytes) {
        showToast('No sheets selected — tick at least one page in the preview first.');
        return;
      }
      downloadBlob(new Blob([zipBytes], { type: SPEC_XLSX_MIME }), makeTechPackFileName(now));
      showToast('Tech pack exported — ' + pvEnabledSheets().length + ' of '
        + PV_SHEETS.length + ' sheets in one workbook.');
    } catch (error) {
      console.error('[Export Tech Pack] failed:', error);
      showToast('Tech pack export failed. Please try again after reducing image size.', 4200);
    }
  }

  // Test hooks for scripts/export-xlsx-tests.mjs: build the workbook with a
  // frozen date (determinism) and hand the bytes back as base64 — headless
  // Chrome can't observe a real download. Attached here (this part loads
  // after debug-api.js) so the export surface stays in one file.
  if (typeof window !== 'undefined' && window.__braAutoModeDebug) {
    window.__braAutoModeDebug.exportSpecXlsxBase64 = async (isoDate, options) => {
      const now = isoDate ? new Date(isoDate) : new Date();
      const withImage = !options || options.image !== false;
      const image = withImage ? await specBoardPngBytes() : null;
      // options.sizeSelection lets the suite exercise subset layouts without
      // driving the picker dialog; restored so tests stay order-independent.
      const hadSelection = state.sizeSelection;
      if (options && 'sizeSelection' in options) state.sizeSelection = options.sizeSelection;
      try {
        return bytesToBase64(buildSpecWorkbookXlsx(now, image));
      } finally {
        if (options && 'sizeSelection' in options) state.sizeSelection = hadSelection;
      }
    };
    // US-079: tech-pack workbook with a frozen date; options.enabledPages
    // lets the suite exercise sheet subsets without driving the checkboxes.
    window.__braAutoModeDebug.exportTechPackXlsxBase64 = async (isoDate, options) => {
      const now = isoDate ? new Date(isoDate) : new Date();
      const pv = ensurePreviewPage();
      const hadPages = clone(pv.enabledPages);
      if (options && options.enabledPages) Object.assign(pv.enabledPages, options.enabledPages);
      try {
        const bytes = await buildTechPackXlsxBytes(now);
        return bytes ? bytesToBase64(bytes) : null;
      } finally {
        pv.enabledPages = hadPages;
      }
    };
    window.__braAutoModeDebug.buildFullSizeRun = (pomKey) => {
      const annByPom = new Map();
      for (const ann of state.annotations) annByPom.set(getLabelText(ann), ann);
      // Preserve the numeric-array contract: the descriptors are an internal
      // detail of the formula writer; callers still get the graded values.
      return buildFullSizeRun(pomKey, annByPom).map(c => c.value);
    };
  }
