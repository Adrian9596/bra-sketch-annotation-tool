// Export Excel — generic OOXML/SpreadsheetML + ZIP toolkit: a hand-written
// offline ZIP (STORE method) writer and the low-level cell/style/sheet XML
// builders shared by every .xlsx export in this app. Source part for
// app.js. Run `npm run build` after editing. The ZIP writer is the
// write-side mirror of the reader in src/import/pptx.js.
//
// None of this knows about POMs, grading, or bra-specific sheets — the
// grading math lives in the sibling export-xlsx-grading.js (which loads
// before this file); the single-sheet Measurement Spec export lives in
// export-spec-xlsx.js; the 6-sheet tech-pack workbook lives in
// export-techpack-xlsx.js.

  const SPEC_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // ---- Offline .xlsx writer (ZIP, method 0 = STORE) ----

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Build a STORE-method ZIP from [{ name, bytes }]. `stamp` (a Date) feeds
  // every DOS timestamp so the same inputs yield byte-identical archives —
  // the export determinism the test suite asserts.
  function zipStore(files, stamp) {
    const encoder = new TextEncoder();
    const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | Math.floor(stamp.getSeconds() / 2);
    const dosDate = (Math.max(0, stamp.getFullYear() - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.bytes;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0, true);           // flags
      lv.setUint16(8, 0, true);           // method 0 = STORE
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // compressed size
      lv.setUint32(22, data.length, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);          // extra length
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      locals.push(local);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);          // method
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);     // local header offset
      central.set(nameBytes, 46);
      centrals.push(central);

      offset += local.length;
    }

    const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const chunk of locals.concat(centrals, [eocd])) {
      out.set(chunk, p);
      p += chunk.length;
    }
    return out;
  }

  function xmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // Column letters for the export grid: 4 label columns + one per SELECTED
  // size (US-011: the sheet emits only the sizes chosen in the export
  // picker; the full 19-column grid is the all-sizes default).
  const SPEC_XLSX_COLS = 4 + SPEC_SIZE_RUN.length;
  function specColLetter(index) {
    let s = '';
    let n = index;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  // Graded values as clean decimals (no float noise), written as numeric
  // cells so Excel treats them as numbers. TOL stays text — Excel would
  // coerce "1/2" to a date (known standard pitfall).
  function specNumberText(value) {
    return String(Math.round(value * 10000) / 10000);
  }

  function formatSpecDate(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dd = String(date.getDate()).padStart(2, '0');
    return dd + '.' + months[date.getMonth()] + '.' + String(date.getFullYear() % 100).padStart(2, '0');
  }

  // Header fills from the export mock. Order defines fill ids 2.. in
  // styles.xml (0 = none, 1 = gray125 are mandatory).
  const SPEC_XLSX_FILLS = [
    'DCE6F1', // 2 title band — light blue
    'E4DFEC', // 3 style/date row — light purple
    'D9D9D9', // 4 label headers (POM / EN / 中文) — gray
    'B8CCE4', // 5 TOL header — blue
    'FCD5B4', // 6 alpha size headers S–5XL — peach
    'C4D79B', // 7 M2 — green
    'FABF8F', // 8 L2 — orange
    'B7DEE8', // 9 XL2 — cyan
    'CCC0DA', // 10 2XL2 — violet
    'FFFF99', // 11 3XL2 — yellow
    'E6B8B7', // 12 4XL2 — light rose
    '92CDDC', // 13 5XL2 — teal
  ];

  // cellXfs indexes (see buildSpecStylesXml): 0 default · 1 title · 2 style
  // row · 3 label header · 4 TOL header · 5 alpha header · 6..12 depth
  // headers (M2..5XL2) · 13 text cell · 14 centered text cell · 15 number
  // cell · 16 centered number cell (POM column) · 17 fraction number cell
  // (mirrors 15 but with the custom # ??/?? numFmt so graded VALUES render as
  // fractions, e.g. 3.75 → 3 3/4; the underlying <v> stays decimal so Req-3
  // formulas still recompute).
  const SPEC_XF = {
    title: 1, styleRow: 2, headLabel: 3, headTol: 4, headAlpha: 5, headDepth0: 6,
    text: 13, textCenter: 14, number: 15, pom: 16, numberFrac: 17,
  };

  function buildSpecStylesXml() {
    const fills = ['<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>']
      .concat(SPEC_XLSX_FILLS.map(rgb =>
        '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'));
    const headerXf = (fillId) =>
      '<xf numFmtId="0" fontId="1" fillId="' + fillId + '" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
      + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>';
    const cellXfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      // 1 title band
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="center" vertical="center"/></xf>',
      // 2 style/date row
      '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="center" vertical="center"/></xf>',
      headerXf(4), headerXf(5), headerXf(6),
      headerXf(7), headerXf(8), headerXf(9), headerXf(10), headerXf(11), headerXf(12), headerXf(13),
      // 12 text cell
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
        + '<alignment vertical="center" wrapText="1"/></xf>',
      // 13 centered text cell (TOL)
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="center" vertical="center"/></xf>',
      // 14 number cell
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="right" vertical="center"/></xf>',
      // 15 POM number cell
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="center" vertical="center"/></xf>',
      // 16 fraction number cell — mirrors 14 (number cell) but applies the
      // custom # ??/?? fraction format (numFmtId 164). Appended at the END so
      // existing xf indices don't shift. Display-only: <v> stays decimal.
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">'
        + '<alignment horizontal="right" vertical="center"/></xf>',
    ];
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      // Custom fraction format used by the size-value cells. numFmts must come
      // BEFORE <fonts> in an OOXML styleSheet. "# ??/??" is Excel's reduced
      // up-to-two-digit fraction (3.75 → 3 3/4, 8.375 → 8 3/8).
      + '<numFmts count="1"><numFmt numFmtId="164" formatCode="# ??/??"/></numFmts>'
      + '<fonts count="3">'
      + '<font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="14"/><name val="Calibri"/></font>'
      + '</fonts>'
      + '<fills count="' + fills.length + '">' + fills.join('') + '</fills>'
      + '<borders count="2">'
      + '<border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>'
      + '</borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="' + cellXfs.length + '">' + cellXfs.join('') + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }

  function specInlineStrCell(ref, styleId, text) {
    return '<c r="' + ref + '" s="' + styleId + '" t="inlineStr"><is><t xml:space="preserve">'
      + xmlEscape(text) + '</t></is></c>';
  }

  function specNumberCell(ref, styleId, value) {
    return '<c r="' + ref + '" s="' + styleId + '"><v>' + specNumberText(value) + '</v></c>';
  }

  // A graded cell as a live formula (=G{r}±Δ / =N{r}±Δ) with the computed
  // result cached in <v> so viewers that don't recalc — and the test suite's
  // <v> reader — still see the number. Editing the base cell reflows the run.
  function specFormulaCell(ref, styleId, formula, cachedValue) {
    return '<c r="' + ref + '" s="' + styleId + '"><f>' + xmlEscape(formula) + '</f><v>'
      + specNumberText(cachedValue) + '</v></c>';
  }

  function specBlankCell(ref, styleId) {
    return '<c r="' + ref + '" s="' + styleId + '"/>';
  }

  function buildSpecSheetXml(rowsData, hasDrawing, colCount) {
    const totalCols = colCount || SPEC_XLSX_COLS;
    const lastCol = specColLetter(totalCols - 1);
    const cols = '<cols>'
      + '<col min="1" max="1" width="6" customWidth="1"/>'
      + '<col min="2" max="2" width="42" customWidth="1"/>'
      + '<col min="3" max="3" width="28" customWidth="1"/>'
      + '<col min="4" max="4" width="9" customWidth="1"/>'
      + (totalCols > 4
        ? '<col min="5" max="' + totalCols + '" width="7.5" customWidth="1"/>'
        : '')
      + '</cols>';
    const rows = rowsData.map(row =>
      '<row r="' + row.r + '"' + (row.ht ? ' ht="' + row.ht + '" customHeight="1"' : '') + '>'
      + row.cells.join('') + '</row>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<dimension ref="A1:' + lastCol + rowsData[rowsData.length - 1].r + '"/>'
      + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      + cols
      + '<sheetData>' + rows + '</sheetData>'
      + '<mergeCells count="2"><mergeCell ref="A1:' + lastCol + '1"/><mergeCell ref="A2:' + lastCol + '2"/></mergeCells>'
      + (hasDrawing ? '<drawing r:id="rId1"/>' : '')
      + '</worksheet>';
  }

  // oneCellAnchor with an explicit EMU extent keeps the sketch's aspect
  // ratio identical across Excel / Sheets / Numbers (column-width-based
  // twoCellAnchor sizing drifts between viewers). 1 px = 9525 EMU.
  function buildSpecDrawingXml(anchorRow, widthPx, heightPx) {
    const cx = Math.round(widthPx * 9525);
    const cy = Math.round(heightPx * 9525);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'
      + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<xdr:oneCellAnchor>'
      + '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>'
      + '<xdr:row>' + anchorRow + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>'
      + '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>'
      + '<xdr:pic>'
      + '<xdr:nvPicPr><xdr:cNvPr id="2" name="Annotated sketch"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
      + '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
      + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
      + '</xdr:pic>'
      + '<xdr:clientData/>'
      + '</xdr:oneCellAnchor>'
      + '</xdr:wsDr>';
  }
