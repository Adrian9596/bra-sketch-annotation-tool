// Export Excel — grading math: the 15-size run (8 alpha + 7 depth columns)
// and the per-POM delta tables that grade a proto's Size L measurement
// across the full run. Source part for app.js. Run `npm run build` after
// editing.
//
// Grading follows `Grading rules.md` (from SC.xlsx, Crossian standard):
// two anchored runs — alpha graded from the proto's Size L via per-size
// Δ-from-L columns, depth graded from Size L2 (explicit pomSpecs sizeL2,
// else L + a per-POM offset) via per-size Δ-from-L2 columns. A TD step
// override in state.gradeRules switches that POM to the constant-step
// model in both tiers (the Size Run dialog's model), so the dialog and
// the export can never disagree about an overridden POM. Held POMs stay
// flat across all 15 columns. NOTHING here touches the rule JSON.
//
// The generic OOXML+ZIP writer lives in the sibling xlsx-writer.js; the
// single-sheet Measurement Spec export lives in export-spec-xlsx.js; the
// 6-sheet tech-pack workbook lives in export-techpack-xlsx.js.

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
