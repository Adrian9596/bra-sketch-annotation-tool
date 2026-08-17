// Export Excel: write the Measurement Spec as a single offline .xlsx —
// title band, styleId + date, one row per visible POM (EN + 中文 + TOL;
// lines hidden via the review × toggle are omitted entirely), the full
// 15-column graded size run (alpha S–5XL from base L, depth M2–5XL2 from
// base L2), and the annotated board embedded as a PNG below the table.
// No library, no template, no network (offline invariant). The ZIP writer
// is the write-side mirror of the reader in src/import/pptx.js.
// Source part for app.js. Run `npm run build` after editing.
//
// Grading follows `Grading rules.md` (from SC.xlsx, Crossian standard):
// two anchored runs — alpha graded from the proto's Size L via per-size
// Δ-from-L columns, depth graded from Size L2 (explicit pomSpecs sizeL2,
// else L + a per-POM offset) via per-size Δ-from-L2 columns. A TD step
// override in state.gradeRules switches that POM to the constant-step
// model in both tiers (the Size Run dialog's model), so the dialog and
// the export can never disagree about an overridden POM. Held POMs stay
// flat across all 15 columns. NOTHING here touches the rule JSON.

  // The 15-size run from the export mock: 8 alpha + 7 depth columns. Kept as
  // data so switching a style to another membership (e.g. the 18-size run, or
  // 4XL2 instead of XL2) is a one-line reviewable edit. `base` is the alpha
  // size a tier-2 column grades around when the constant-step override is on.
  const SPEC_SIZE_RUN = [
    { label: 'S',    base: 'S',   tier: 1 }, { label: 'M',    base: 'M',   tier: 1 },
    { label: 'L',    base: 'L',   tier: 1 }, { label: 'XL',   base: 'XL',  tier: 1 },
    { label: '2XL',  base: '2XL', tier: 1 }, { label: '3XL',  base: '3XL', tier: 1 },
    { label: '4XL',  base: '4XL', tier: 1 }, { label: '5XL',  base: '5XL', tier: 1 },
    { label: 'M2',   base: 'M',   tier: 2 }, { label: 'L2',   base: 'L',   tier: 2 },
    { label: 'XL2',  base: 'XL',  tier: 2 }, { label: '2XL2', base: '2XL', tier: 2 },
    { label: '3XL2', base: '3XL', tier: 2 }, { label: '4XL2', base: '4XL', tier: 2 },
    { label: '5XL2', base: '5XL', tier: 2 },
  ];

  // SC-derived alpha deltas from base L, in INCHES, one entry per GRADE_SIZES
  // column (S M L XL 2XL 3XL 4XL 5XL). See Grading rules.md §4. Held POMs
  // (6, 14, 15) are all-zero here and additionally forced flat by their
  // house `hold` flag, so a TD un-holding one starts from a sane rule.
  const SPEC_ALPHA_DELTA_L_IN = {
    '1':  [-1.75, -1.0,  0, 1.0,  2.0,  3.25, 4.25,  5.25],
    '2':  [-2.25, -1.0,  0, 2.0,  3.0,  5.25, 6.25,  8.25],
    '3':  [-2.5,  -1.25, 0, 1.25, 2.5,  3.75, 5.0,   6.25],
    '4':  [-2.5,  -1.25, 0, 1.25, 2.5,  3.75, 5.0,   6.25],
    '5':  [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 0.875, 1.0],
    '6':  [0, 0, 0, 0, 0, 0, 0, 0],
    '7':  [-0.25, -0.125, 0, 0.125, 0.25, 0.375, 0.4375, 0.5],
    '8':  [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 0.875, 1.0],
    '9':  [-0.75, -0.375, 0, 0.375, 0.75, 1.375, 1.75, 2.125],
    '10': [-1.0,  -0.5,  0, 0.5,  1.0,  2.0,  2.5,   3.0],
    '11': [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 0.875, 1.0],
    '12': [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 0.875, 1.0],
    '13': [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 0.875, 1.0],
    '14': [0, 0, 0, 0, 0, 0, 0, 0],
    '15': [0, 0, 0, 0, 0, 0, 0, 0],
    '16': [-0.5,  -0.25, 0, 0.25, 0.5,  0.75, 1.0,   1.25],
  };

  // Depth run: L2 = L + offset (inches; 0 for band and held POMs), then the
  // per-size deltas from L2 for M2 L2 XL2 2XL2 3XL2 4XL2 5XL2. Grading rules.md
  // §2.1 — explicit values, NOT a copied alpha column (the two runs taper at
  // different absolute sizes near the top).
  const SPEC_DEPTH_OFFSET_IN = {
    '1': 0, '2': 0, '3': 1.25, '4': 1.25, '5': 0.25, '6': 0, '7': 0.125,
    '8': 0.25, '9': 0.375, '10': 0.5, '11': 0.25, '12': 0.25, '13': 0.25,
    '14': 0, '15': 0, '16': 0.25,
  };
  const SPEC_DEPTH_DELTA_L2_IN = {
    '1':  [-1.0,   0, 1.0,   2.0, 3.25,  4.25, 5.25],
    '2':  [-1.0,   0, 2.0,   3.0, 5.25,  6.25, 7.25],
    '3':  [-1.25,  0, 1.25,  2.5, 3.75,  5.25, 6.25],
    '4':  [-1.25,  0, 1.25,  2.5, 3.75,  5.25, 6.25],
    '5':  [-0.25,  0, 0.25,  0.5, 0.625, 0.75, 0.75],
    '6':  [0, 0, 0, 0, 0, 0, 0],
    '7':  [-0.125, 0, 0.125, 0.25, 0.375, 0.4375, 0.5], // 4XL2 interpolated (no SC row); TD to confirm
    '8':  [-0.25,  0, 0.25,  0.5, 0.625, 0.75, 0.75],
    '9':  [-0.375, 0, 0.375, 1.0, 1.375, 1.75, 2.125],
    '10': [-0.5,   0, 0.5,   1.5, 2.0,   2.5, 3.0],
    '11': [-0.25,  0, 0.25,  0.5, 0.625, 0.75, 0.875],
    '12': [-0.25,  0, 0.25,  0.5, 0.625, 0.75, 0.875],
    '13': [-0.25,  0, 0.25,  0.5, 0.625, 0.75, 0.875],
    '14': [0, 0, 0, 0, 0, 0, 0],
    '15': [0, 0, 0, 0, 0, 0, 0],
    '16': [-0.25,  0, 0.25,  0.5, 0.75,  1.0, 1.25],
  };

  // Effective depth rule for a POM in the project's unit: a TD override in
  // state.gradeRules.depthOffsets (per-POM L2−L offset — the former separate
  // state.depthRules field, absorbed into the v2 container by US-011) wins;
  // otherwise the SC default converted from inches. Mirrors getGradeRule.
  function getDepthRule(pomKey) {
    const key = String(pomKey);
    const unitScale = inchesToUnit(state.calibration.unit);
    const houseOffset = (SPEC_DEPTH_OFFSET_IN[key] || 0) * unitScale;
    const offsets = (state.gradeRules && state.gradeRules.depthOffsets) || null;
    const override = (offsets && offsets[key]) || null;
    if (!override || override.offset == null) return { offset: houseOffset, overridden: false };
    return { offset: Number(override.offset), overridden: true };
  }

  // Delta rounding for formula strings: same 4-dp quantization as
  // specNumberText, so the `=G{r}±Δ` / `=N{r}±Δ` text is deterministic
  // (the byte-identical-export invariant covers formulas, not just values).
  function roundSpecDelta(value) {
    return Math.round(value * 10000) / 10000;
  }

  // US-011 S3: per-POM per-size delta override from the Grading dialog,
  // stored in INCHES in gradeRules v2 (alpha keyed by alpha label, depth by
  // depth label). Returns null when the TD has not overridden that cell.
  // Precedence (highest first): per-size override → constant-step override
  // (Size Run dialog) → built-in SPEC_* tables. A per-size override also
  // beats the `hold` flag — an explicit cell edit is explicit TD intent.
  function getPerSizeGradeDelta(tier, pomKey, sizeLabel) {
    const gr = state.gradeRules;
    const bucket = gr && gr.version === 2 ? (tier === 1 ? gr.alpha : gr.depth) : null;
    const entry = bucket && bucket[String(pomKey)];
    const v = entry ? entry[sizeLabel] : null;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  // The 15 graded cells for one POM, in the project's unit, aligned with
  // SPEC_SIZE_RUN. Each entry is a descriptor `{ value, base, delta }`:
  //   base === null → static (the editable Size-L cell, an explicit Size-L2
  //                   cell, or a blank when value === null);
  //   base === 'L'  → formula anchored on the Size-L cell (=G{r}+Δ);
  //   base === 'L2' → formula anchored on the L2 cell (=N{r}+Δ).
  // `value` is the cached numeric result (unchanged grade math), so the
  // Excel `<v>` and every value-based test stay identical. Returns
  // all-null/base-null descriptors when the POM has no base (no Size L and
  // no measured line) — the writer leaves those cells blank.
  function buildFullSizeRun(pomKey, annByPom) {
    const key = String(pomKey);
    const baseInfo = gradeBaseValue(key, annByPom);
    if (baseInfo.value == null) return SPEC_SIZE_RUN.map(() => ({ value: null, base: null, delta: 0 }));
    const protoL = baseInfo.value;
    const rule = getGradeRule(key);
    const unitScale = inchesToUnit(state.calibration.unit);
    const alphaDeltas = SPEC_ALPHA_DELTA_L_IN[key] || null;
    const baseIdx = GRADE_SIZES.indexOf(GRADE_BASE_SIZE);

    const alphaValue = (sizeLabel) => {
      const perSize = getPerSizeGradeDelta(1, key, sizeLabel);
      if (perSize != null) return protoL + perSize * unitScale;
      if (rule.hold) return protoL;
      const i = GRADE_SIZES.indexOf(sizeLabel);
      if (rule.overridden || !alphaDeltas) return protoL + (i - baseIdx) * rule.step;
      return protoL + alphaDeltas[i] * unitScale;
    };

    // L2 anchor: an explicit Size L2 wins; else derive from L. Under a TD
    // constant-step override the derivation is "one step up" (the standard's
    // offset = the L→XL step); otherwise the SC per-POM offset.
    const explicitL2 = parseSpecNumber(getPomSpec(key).sizeL2);
    const depthRule = getDepthRule(key);
    const derivedOffset = rule.hold ? 0
      : (rule.overridden && !depthRule.overridden ? rule.step : depthRule.offset);
    const protoL2 = explicitL2 != null ? explicitL2 : protoL + derivedOffset;
    const depthDeltas = SPEC_DEPTH_DELTA_L2_IN[key] || null;
    const depthLabels = SPEC_SIZE_RUN.filter(c => c.tier === 2).map(c => c.label);

    const depthValue = (col) => {
      const perSize = getPerSizeGradeDelta(2, key, col.label);
      if (perSize != null) return protoL2 + perSize * unitScale;
      if (rule.hold) return protoL;
      if (rule.overridden || !depthDeltas) {
        return protoL2 + (GRADE_SIZES.indexOf(col.base) - baseIdx) * rule.step;
      }
      return protoL2 + depthDeltas[depthLabels.indexOf(col.label)] * unitScale;
    };

    return SPEC_SIZE_RUN.map(col => {
      if (col.tier === 1) {
        const value = alphaValue(col.label);
        // The Size-L cell is the static, editable base of the alpha run.
        if (col.label === GRADE_BASE_SIZE) return { value, base: null, delta: 0 };
        return { value, base: 'L', delta: roundSpecDelta(value - protoL) };
      }
      const value = depthValue(col);
      if (col.label === 'L2') {
        // Explicit Size L2 → static editable base; else derived from Size L.
        if (explicitL2 != null) return { value, base: null, delta: 0 };
        return { value, base: 'L', delta: roundSpecDelta(derivedOffset) };
      }
      // Held POMs stay flat off the Size-L cell (=G{r}); the depth run for a
      // held POM never taints an L2 base that equals Size L anyway.
      if (rule.hold) return { value, base: 'L', delta: roundSpecDelta(value - protoL) };
      return { value, base: 'L2', delta: roundSpecDelta(value - protoL2) };
    });
  }

  // ---- Offline .xlsx writer (ZIP, method 0 = STORE) ----

  const SPEC_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

  // Assemble every workbook part and ZIP them. `image` is optional
  // ({ bytes, width, height }); without it the sheet is table-only.
  // `now` feeds the header date and the ZIP timestamps — pass a fixed date
  // to get byte-identical output (determinism tests).
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
    for (const ann of state.annotations) {
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
    for (const ann of state.annotations) annByPom.set(getLabelText(ann), ann);
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
