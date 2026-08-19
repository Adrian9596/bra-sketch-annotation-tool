// Shared grade-rule domain model: base sizes, the house default step table,
// and the pure functions that turn a base value + rule into a graded run.
// Used by both size-run-dialog.js (read-only preview) and grading-dialog.js
// (per-size edit). Grade rules live in state.gradeRules (persisted +
// undoable); NOTHING here touches the rule JSON.
// Source part for app.js. Run `npm run build` after editing.

  const GRADE_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  const GRADE_BASE_SIZE = 'L';

  // Crossian house grade rule expressed as ONE constant step per POM, in
  // INCHES, plus which POMs are held constant (straps are adjustable, so they
  // don't grade). A constant step is a deliberate approximation of the
  // standard's taper (e.g. the band actually steps ~0.5 -> 1.0); the TD can
  // edit any step in the dialog. See the bra-grading house standard.
  const HOUSE_GRADE_INCHES = {
    '1':  { step: 0.75,  hold: false }, // 1/2 bottom band - relax (bonded ~0.5->1.0)
    '2':  { step: 1.5,   hold: false }, // 1/2 bottom band - extend (~1.0->2.0)
    '3':  { step: 1.25,  hold: false }, // 1/2 chest - measure straight
    '4':  { step: 1.25,  hold: false }, // 1/2 chest - extend
    '5':  { step: 0.25,  hold: false }, // center front height
    '6':  { step: 0.125, hold: false }, // cradle height at center front
    '7':  { step: 0.25,  hold: false }, // cradle height at bottom cup
    '8':  { step: 0.375, hold: false }, // cup height at center front
    '9':  { step: 0.375, hold: false }, // inner cup height
    '10': { step: 0.5,   hold: false }, // inner cup width
    '11': { step: 0.25,  hold: false }, // side seam length
    '12': { step: 0.25,  hold: false }, // back center length
    '13': { step: 0.25,  hold: false }, // back panel height
    '14': { step: 0,     hold: true  }, // shoulder strap - held (adjustable)
    '15': { step: 0,     hold: true  }, // back strap distances - held
    '16': { step: 0.5,   hold: false }, // front apex distance
  };

  function inchesToUnit(unit) {
    if (unit === 'cm') return 2.54;
    if (unit === 'mm') return 25.4;
    if (unit === 'm') return 0.0254;
    return 1; // inches — the project default unit (and the 'in' case)
  }

  // Effective grade rule for a POM in the project's unit: a TD override in
  // state.gradeRules wins; otherwise the house default converted from inches.
  function getGradeRule(pomKey) {
    const key = String(pomKey);
    const house = HOUSE_GRADE_INCHES[key] || { step: 0, hold: false };
    const houseStepUnit = house.step * inchesToUnit(state.calibration.unit);
    const override = (state.gradeRules && state.gradeRules.steps && state.gradeRules.steps[key]) || null;
    if (!override) return { step: houseStepUnit, hold: !!house.hold, overridden: false };
    return {
      step: override.step != null ? Number(override.step) : houseStepUnit,
      hold: override.hold != null ? !!override.hold : !!house.hold,
      overridden: true,
    };
  }

  // Base value for a POM: explicit Size L wins; else the calibrated measured
  // length of its drawn line; else null (nothing to grade from).
  function gradeBaseValue(pomKey, annByPom) {
    const fromSize = parseSpecNumber(getPomSpec(pomKey).sizeL);
    if (fromSize != null) return { value: fromSize, source: 'Size L' };
    const cal = state.calibration;
    if (cal.unitsPerPx != null) {
      const ann = annByPom.get(String(pomKey));
      if (ann) {
        const px = lineLength(ann);
        if (px > 0) return { value: px * cal.unitsPerPx, source: 'measured' };
      }
    }
    return { value: null, source: null };
  }

  function gradedRunForPom(base, rule) {
    const baseIdx = GRADE_SIZES.indexOf(GRADE_BASE_SIZE);
    return GRADE_SIZES.map((_, i) => (rule.hold ? base : base + (i - baseIdx) * rule.step));
  }
