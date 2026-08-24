// Export Excel — the single-sheet 'Measurement Spec' export: title band,
// styleId + date, one row per visible POM (EN + 中文 + TOL; lines hidden
// via the review × toggle are omitted entirely), the full 15-column graded
// size run (alpha S–5XL from base L, depth M2–5XL2 from base L2), and the
// annotated board embedded as a PNG below the table. No library, no
// template, no network (offline invariant). Source part for app.js. Run
// `npm run build` after editing.
//
// buildSpecSheetRows is deliberately the single shared source of truth
// between this export and buildPomSheetPart in the sibling
// export-techpack-xlsx.js (US-079: "one builder, two entry points, so the
// two exports can never disagree"). It is defined exactly once, here, and
// called from export-techpack-xlsx.js, which loads after this file.
//
// Grading math lives in export-xlsx-grading.js; the generic OOXML+ZIP
// toolkit lives in xlsx-writer.js — both load before this file.

  // The POM keys the spec actually emits, in row order. Extracted from
  // buildSpecWorkbookXlsx (US-079) so the Preview & Export page's spec-table
  // replica and the tech-pack workbook share the exact same visibility rules.
  function specVisiblePomKeys(annByPom) {
    // Standard 16 + registered custom POMs (US-011 S4). Customs sort after 16
    // by construction (numbering starts at 19) and get identical treatment:
    // spec row, grading (flat until the TD grades them), live formulas.
    const allPomKeys = Object.keys(POM_TEMPLATE)
      .concat((state.customPoms || []).map(p => String(p.pom)))
      .sort((a, b) => Number(a) - Number(b));

    // A POM line the TD hid via the review × toggle (state.hiddenAnnIds) is
    // omitted from the exported spec entirely — its row and every measurement
    // for it. Paired POMs (1/2, 3/4) share one drawn line, so hiding it drops
    // both halves of the pair. Hidden state is session-only (not persisted),
    // so the export mirrors the current review view, just like the board.
    const hiddenPomKeys = new Set();
    // US-096: a construction line owns no POM key, so it can neither hide a
    // POM row nor claim one. Scanning the whole board here would let an
    // unlabelled stitch mark sitting on sequence number 5 hide POM 5.
    for (const ann of measurementAnnotations()) {
      if (isAnnHidden(ann.id)) hiddenPomKeys.add(String(getLabelText(ann)));
    }
    // US-047: a POM whose drawn line was DELETED is excluded from the spec just
    // like a hidden line (TD: "delete = hide") — UNLESS a line with that label
    // has since been redrawn, in which case the live line is authoritative.
    for (const key of (state.deletedPomKeys || [])) {
      if (!annByPom.has(String(key))) hiddenPomKeys.add(String(key));
    }
    for (const key of Array.from(hiddenPomKeys)) {
      const pairing = POM_TEMPLATE[key] && POM_TEMPLATE[key].pairing;
      const partner = pairing && (pairing.partner || pairing.primary);
      if (partner != null) hiddenPomKeys.add(String(partner));
    }
    return allPomKeys.filter(key => !hiddenPomKeys.has(String(key)));
  }

  // The Measurement Spec row grid — shared by the single-sheet Board export
  // and the tech-pack workbook's POM sheet (US-079: one builder, two entry
  // points, so the two exports can never disagree about the spec).
  function buildSpecSheetRows(now) {
    const annByPom = new Map();
    // US-096: the measurement set only. An unlabelled zigzag/cover/bartack
    // line is a construction mark and owns no POM row.
    for (const ann of measurementAnnotations()) annByPom.set(getLabelText(ann), ann);
    const pomKeys = specVisiblePomKeys(annByPom);

    // US-011: the sheet emits only the SELECTED size columns. The grade math
    // always runs over the full 15-cell run (positional delta lookups assume
    // it); columns are filtered at emission time only.
    const layout = selectedSizeRun();
    const colCount = 4 + layout.length;
    const fullIndexByLabel = new Map(SPEC_SIZE_RUN.map((c, i) => [c.label, i]));

    const styleLabel = (state.styleId || '').trim() || 'Untitled';
    const rowsData = [];
    // Merged band rows: the anchor cell carries the text; the remaining
    // columns still need styled blanks (in column order) so the band's
    // fill + border span the full merge in every viewer.
    const bandRow = (r, styleId, text) => ({
      r,
      ht: r === 1 ? 26 : 18,
      cells: [specInlineStrCell('A' + r, styleId, text)].concat(
        Array.from({ length: colCount - 1 }, (_, i) => specBlankCell(specColLetter(1 + i) + r, styleId))
      ),
    });
    rowsData.push(bandRow(1, SPEC_XF.title, 'Measurement Spec'));
    rowsData.push(bandRow(2, SPEC_XF.styleRow, styleLabel + ' - ' + formatSpecDate(now)));

    // Depth header fills index against the FULL depth list so each size keeps
    // its own color even when earlier depth columns are deselected.
    const depthLabels = SPEC_SIZE_RUN.filter(c => c.tier === 2).map(c => c.label);
    const headCells = [
      specInlineStrCell('A3', SPEC_XF.headLabel, 'POM'),
      specInlineStrCell('B3', SPEC_XF.headLabel, 'Description - English'),
      specInlineStrCell('C3', SPEC_XF.headLabel, 'Description - Chinese'),
      specInlineStrCell('D3', SPEC_XF.headTol, 'TOL'),
    ];
    layout.forEach((col, i) => {
      const styleId = col.tier === 1 ? SPEC_XF.headAlpha : SPEC_XF.headDepth0 + depthLabels.indexOf(col.label);
      headCells.push(specInlineStrCell(specColLetter(4 + i) + '3', styleId, col.label));
    });
    rowsData.push({ r: 3, ht: 20, cells: headCells });

    // Base column letters for the live grade formulas, derived from the
    // SELECTED layout ('G'/'N' only in the all-sizes default). When a base
    // size is deselected its dependents fall back to static cached values —
    // a formula must never point at a column that is not in the sheet.
    const lIdx = layout.findIndex(c => c.label === 'L');
    const l2Idx = layout.findIndex(c => c.label === 'L2');
    const lCol = lIdx >= 0 ? specColLetter(4 + lIdx) : null;
    const l2Col = l2Idx >= 0 ? specColLetter(4 + l2Idx) : null;

    for (let i = 0; i < pomKeys.length; i += 1) {
      const key = pomKeys[i];
      const r = 4 + i;
      const spec = getPomSpec(key);
      const run = buildFullSizeRun(key, annByPom);
      const cells = [
        specNumberCell('A' + r, SPEC_XF.pom, Number(key)),
        specInlineStrCell('B' + r, SPEC_XF.text, spec.en),
        specInlineStrCell('C' + r, SPEC_XF.text, spec.zh),
        // TOL is written VERBATIM as an inline string — never coerced to a
        // number/date. So any fraction family (halves, quarters, eighths,
        // incl. ¾ = "3/4") round-trips to Excel exactly as authored, with no
        // conversion; fractionToNumber (src/ui/spec-panel.js) parses it back.
        // US-048: TOL exports as an imperial fraction in inch mode (0.375 →
        // 3/8) to match the fraction-formatted size values; cm stays decimal.
        // Still written verbatim as text — no coercion to number/date.
        spec.tol ? specInlineStrCell('D' + r, SPEC_XF.textCenter, inchesToFractionOrDecimal(spec.tol)) : specBlankCell('D' + r, SPEC_XF.textCenter),
      ];
      layout.forEach((col, c) => {
        const cell = run[fullIndexByLabel.get(col.label)];
        const ref = specColLetter(4 + c) + r;
        const baseCol = cell.base === 'L' ? lCol : (cell.base === 'L2' ? l2Col : null);
        if (cell.value == null) {
          cells.push(specBlankCell(ref, SPEC_XF.number));
        } else if (cell.base == null || baseCol == null) {
          // Static editable base (Size L, or an explicit Size L2) — or a
          // graded cell whose base column is not in this export's layout:
          // emit the cached value as a plain number. The fraction numFmt
          // renders it as e.g. 3 3/4 while <v> stays decimal.
          cells.push(specNumberCell(ref, SPEC_XF.numberFrac, cell.value));
        } else {
          const d = cell.delta;
          const formula = baseCol + r
            + (d === 0 ? '' : (d < 0 ? '-' + specNumberText(-d) : '+' + specNumberText(d)));
          // Fraction numFmt on the formula cell too — the cached <v> is the
          // decimal result, so Req-3 recalculation is unaffected.
          cells.push(specFormulaCell(ref, SPEC_XF.numberFrac, formula, cell.value));
        }
      });
      rowsData.push({ r, cells });
    }
    return { rowsData, colCount, pomKeys };
  }

  function buildSpecWorkbookXlsx(now, image) {
    const encoder = new TextEncoder();
    const { rowsData, colCount, pomKeys } = buildSpecSheetRows(now);
    const hasImage = !!(image && image.bytes && image.bytes.length);
    const sheetXml = buildSpecSheetXml(rowsData, hasImage, colCount);

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + (hasImage ? '<Default Extension="png" ContentType="image/png"/>' : '')
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + (hasImage ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '')
      + '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';

    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Measurement Spec" sheetId="1" r:id="rId1"/></sheets>'
      + '</workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', bytes: encoder.encode(contentTypes) },
      { name: '_rels/.rels', bytes: encoder.encode(rootRels) },
      { name: 'xl/workbook.xml', bytes: encoder.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(workbookRels) },
      { name: 'xl/styles.xml', bytes: encoder.encode(buildSpecStylesXml()) },
      { name: 'xl/worksheets/sheet1.xml', bytes: encoder.encode(sheetXml) },
    ];

    if (hasImage) {
      // Display the sketch at a readable width (~the table's width) while
      // keeping the full-resolution PNG bytes; anchored two rows below the
      // last POM row (rows are 0-based in drawingml).
      const displayWidth = Math.min(image.width, 1100);
      const displayHeight = Math.round(image.height * (displayWidth / image.width));
      const anchorRow = 3 + pomKeys.length + 2;
      const sheetRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>'
        + '</Relationships>';
      const drawingRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
        + '</Relationships>';
      files.push(
        { name: 'xl/worksheets/_rels/sheet1.xml.rels', bytes: encoder.encode(sheetRels) },
        { name: 'xl/drawings/drawing1.xml', bytes: encoder.encode(buildSpecDrawingXml(anchorRow, displayWidth, displayHeight)) },
        { name: 'xl/drawings/_rels/drawing1.xml.rels', bytes: encoder.encode(drawingRels) },
        { name: 'xl/media/image1.png', bytes: image.bytes },
      );
    }

    return zipStore(files, now);
  }

  function makeSpecXlsxFileName(now) {
    const pad = (v) => String(v).padStart(2, '0');
    const styleSlug = ((state.styleId || '').trim() || 'untitled').replace(/[^\w\-]+/g, '_');
    return 'measurement-spec-' + styleSlug + '-'
      + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.xlsx';
  }

  async function specBoardPngBytes() {
    const bounds = getContentBounds();
    if (!bounds) return null;
    const canvas = renderBoardRegionToCanvas(bounds);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob produced no data'))),
        'image/png'
      );
    });
    const buffer = await blob.arrayBuffer();
    return { bytes: new Uint8Array(buffer), width: canvas.width, height: canvas.height };
  }

  async function exportSpecXlsx() {
    const bounds = getContentBounds();
    if (!bounds) {
      showToast('Nothing to export yet. Paste an image or draw annotations first.');
      return;
    }
    // US-011: pick the size columns first; the choice persists per project.
    openExportSizeDialog(() => { void runSpecXlsxExport(); });
  }

  async function runSpecXlsxExport() {
    try {
      const now = new Date();
      const image = await specBoardPngBytes();
      const zipBytes = buildSpecWorkbookXlsx(now, image);
      downloadBlob(new Blob([zipBytes], { type: SPEC_XLSX_MIME }), makeSpecXlsxFileName(now));
      const sizeCount = selectedSizeRun().length;
      showToast('Excel spec exported — ' + sizeCount + ' of ' + SPEC_SIZE_RUN.length
        + ' size columns, sketch embedded.');
    } catch (error) {
      console.error('[Export Excel] failed:', error);
      showToast('Excel export failed. Please try again after reducing image size.', 4200);
    }
  }
