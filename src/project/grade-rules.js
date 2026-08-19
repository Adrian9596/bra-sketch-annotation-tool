// Grade-rules v2 data model + custom-POM registry lookup.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Grade rules v2 container (US-011) ----------------------------------
  // One persisted object holds every TD grading override:
  //   steps        — v1 constant-step overrides { [pom]: {step, hold} }
  //                  (step in the project unit, as the Size Run dialog wrote)
  //   alpha, depth — per-POM per-size delta overrides { [pom]: {[size]: Δ} },
  //                  stored in INCHES (unit-independent, converted at use like
  //                  the built-ins). Written by the Grading dialog (S3).
  //   depthOffsets — the former state.depthRules { [pom]: {offset} } (project
  //                  unit), absorbed here so one field persists all grading.
  function makeEmptyGradeRulesV2() {
    return { version: 2, steps: {}, alpha: {}, depth: {}, depthOffsets: {} };
  }

  // Lossless upgrade of persisted grading state to the v2 container.
  // Accepts: a v2 container (returned normalized), a v1 map of
  // { [pom]: {step, hold} } entries, or null/garbage (fresh container).
  // legacyDepthRules is the old separate state.depthRules field from
  // pre-US-011 files; it folds into depthOffsets.
  function migrateGradeRulesV2(raw, legacyDepthRules) {
    const out = makeEmptyGradeRulesV2();
    if (raw && typeof raw === 'object') {
      if (raw.version === 2) {
        for (const k of ['steps', 'alpha', 'depth', 'depthOffsets']) {
          if (raw[k] && typeof raw[k] === 'object') out[k] = JSON.parse(JSON.stringify(raw[k]));
        }
      } else {
        // v1: version-less map of per-POM {step, hold} overrides.
        for (const key of Object.keys(raw)) {
          const e = raw[key];
          if (e && typeof e === 'object' && ('step' in e || 'hold' in e)) {
            out.steps[key] = { ...e };
          }
        }
      }
    }
    if (legacyDepthRules && typeof legacyDepthRules === 'object') {
      for (const key of Object.keys(legacyDepthRules)) {
        const e = legacyDepthRules[key];
        if (e && typeof e === 'object' && e.offset != null && out.depthOffsets[key] == null) {
          out.depthOffsets[key] = { ...e };
        }
      }
    }
    return out;
  }

  // Custom POM registry lookup (US-011 S4). Custom POMs (17+) live in
  // state.customPoms — never in the 18-POM rule JSON (ADR 0018).
  function customPomEntry(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key) return null;
    return (state.customPoms || []).find(p => String(p.pom) === key) || null;
  }

  // Next free custom POM number: one past the highest of 16 and any
  // existing custom or annotation label number.
  function nextCustomPomNumber() {
    // Core template now reserves 1..18 (US-037: neckline 17, armhole 18);
    // custom POMs start at 19. See ADR 0032.
    let max = 18;
    for (const p of state.customPoms || []) {
      const n = Number(p.pom);
      if (Number.isFinite(n) && n > max) max = n;
    }
    for (const ann of state.annotations || []) {
      const n = Number(ann.text != null ? ann.text : NaN);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }
