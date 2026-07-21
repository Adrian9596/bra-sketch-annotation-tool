// Loads TD-editable Auto Mode rules from auto_mode_rules/*.json.
// This runs before state.js so POM_TEMPLATE/ANCHOR_SCHEMA stay synchronous.

  function loadAutoModeRules() {
    if (window.BraMeasurementRules) return window.BraMeasurementRules;

    const basePath = 'auto_mode_rules/';
    let version;
    let pomTemplate;
    let anchorSchema;
    try {
      version = loadRuleJson(basePath + 'version.json');
      pomTemplate = loadRuleJson(basePath + 'pom-template.json');
      anchorSchema = loadRuleJson(basePath + 'anchor-schema.json');
    } catch (error) {
      const builtInRules = getBuiltInRuleJson();
      if (!builtInRules) throw error;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Auto Mode] Using built-in rule JSON fallback:', error.message);
      }
      version = builtInRules.version;
      pomTemplate = builtInRules.pomTemplate;
      anchorSchema = builtInRules.anchorSchema;
    }
    // Size-L suggestions are an optional Tier-0 enhancement (the library-value
    // measurement layer) — a missing/broken file must never break core rule
    // loading, so it falls back to the inlined copy, then to none.
    let sizeLSuggestions = null;
    try {
      sizeLSuggestions = loadRuleJson(basePath + 'sizeL-suggestions.json');
    } catch (error) {
      const builtInRules = getBuiltInRuleJson();
      sizeLSuggestions = builtInRules ? builtInRules.sizeLSuggestions || null : null;
    }
    const rules = normalizeAutoModeRules(version, pomTemplate, anchorSchema, sizeLSuggestions);
    window.BraMeasurementRules = rules;
    return rules;
  }

  function getBuiltInRuleJson() {
    if (typeof BUILTIN_AUTO_MODE_RULE_JSON === 'undefined') return null;
    return BUILTIN_AUTO_MODE_RULE_JSON;
  }

  function loadRuleJson(path) {
    if (typeof XMLHttpRequest !== 'function') {
      throw new Error('Cannot load Auto Mode JSON rules without XMLHttpRequest: ' + path);
    }

    const request = new XMLHttpRequest();
    request.open('GET', path, false);
    request.overrideMimeType('application/json');
    request.send(null);

    const ok = (request.status >= 200 && request.status < 300)
      || (request.status === 0 && request.responseText);
    if (!ok) {
      throw new Error('Unable to load Auto Mode JSON rule file: ' + path + ' (' + request.status + ')');
    }

    try {
      return JSON.parse(request.responseText);
    } catch (error) {
      throw new Error('Invalid Auto Mode JSON rule file: ' + path + ' - ' + error.message);
    }
  }

  function normalizeAutoModeRules(version, pomTemplate, anchorSchema, sizeLSuggestions) {
    const rows = Array.isArray(pomTemplate && pomTemplate.rows) ? pomTemplate.rows : [];
    const anchors = Array.isArray(anchorSchema && anchorSchema.anchors) ? anchorSchema.anchors : [];
    if (!rows.length) throw new Error('Auto Mode POM template JSON has no rows.');
    if (!anchors.length) throw new Error('Auto Mode anchor schema JSON has no anchors.');
    assertAutoModeRuleContract(rows, anchors);

    const POM_TEMPLATE = {};
    const POM_PAIR_PRIMARIES = {};
    const POM_SUGGESTIONS = {};

    for (const row of rows) {
      if (!row || row.id == null) throw new Error('Auto Mode POM row is missing id.');
      const id = String(row.id);
      if (!row.name) throw new Error('Auto Mode POM ' + id + ' is missing name.');
      if (!row.view) throw new Error('Auto Mode POM ' + id + ' is missing view.');
      if (!Array.isArray(row.requiredAnchors)) {
        throw new Error('Auto Mode POM ' + id + ' is missing requiredAnchors.');
      }

      const entry = {
        desc: row.name,
        refL: row.refL == null ? null : row.refL,
        viewRole: row.placementViewRole || row.view,
        measurementView: row.view,
        requiredAnchors: row.requiredAnchors.slice(),
      };
      if (row.placementViewRole) entry.placementViewRole = row.placementViewRole;
      if (Array.isArray(row.optionalAnchors) && row.optionalAnchors.length) {
        entry.optionalAnchors = row.optionalAnchors.slice();
      }
      if (row.zh) entry.zh = String(row.zh);
      if (row.derivation != null) entry.derivation = row.derivation;
      if (row.pairing != null) entry.pairing = row.pairing;
      if (row.expected_confidence_tier) {
        entry.expected_confidence_tier = row.expected_confidence_tier;
      }

      POM_TEMPLATE[id] = entry;

      if (row.pairing && row.pairing.role === 'primary') {
        POM_PAIR_PRIMARIES[id] = {
          partner: String(row.pairing.partner),
          desc: row.pairing.groupName || row.name,
          primaryLabel: row.pairing.primaryLabel || 'Primary',
          secondaryLabel: row.pairing.secondaryLabel || 'Secondary',
        };
      }
    }

    // Attach the derived library-value suggestion for each POM (Tier-0
    // measurement layer). Keyed by the same POM id; only kept for POMs the
    // template actually defines. A POM with no corpus data (n === 0) still gets
    // an entry so the panel can show a "no library data" badge.
    const suggestionPoms = sizeLSuggestions && sizeLSuggestions.poms;
    if (suggestionPoms && typeof suggestionPoms === 'object') {
      for (const id of Object.keys(POM_TEMPLATE)) {
        const s = suggestionPoms[id];
        if (s && typeof s === 'object') POM_SUGGESTIONS[id] = Object.assign({}, s);
      }
    }

    return Object.freeze({
      POM_UNIT: version.pom_unit || 'in',
      POM_TEMPLATE,
      POM_PAIR_PRIMARIES,
      POM_SUGGESTIONS,
      ANCHOR_SCHEMA: anchors.map(anchor => Object.assign({}, anchor)),
      AUTO_TEMPLATE_VERSION: version.template_version || 'unknown-template',
      AUTO_RULE_VERSION: version.rule_version || 'unknown-rules',
      AUTO_ANCHOR_VERSION: version.anchor_version || 'unknown-anchors',
      AUTO_SUGGESTIONS_VERSION: (sizeLSuggestions && sizeLSuggestions.suggestions_version)
        || version.suggestions_version || 'none',
    });
  }

  function assertAutoModeRuleContract(rows, anchors) {
    const validViews = new Set(['front_outer', 'front_inner', 'back', 'front_to_back']);
    const validPlacementRoles = new Set(['front_outer', 'front_inner', 'back']);
    const anchorKinds = new Set();
    for (const anchor of anchors) {
      if (!anchor || !anchor.kind) throw new Error('Auto Mode anchor schema row is missing kind.');
      const kind = String(anchor.kind);
      if (anchorKinds.has(kind)) throw new Error('Auto Mode anchor schema has duplicate kind "' + kind + '".');
      anchorKinds.add(kind);
    }

    if (rows.length !== 18) {
      throw new Error('Auto Mode POM template must define exactly 18 rows; found ' + rows.length + '.');
    }

    const ids = new Set();
    for (const row of rows) {
      const id = String(row && row.id);
      if (!/^(?:[1-9]|1[0-8])$/.test(id)) {
        throw new Error('Auto Mode POM row has invalid id "' + id + '" (expected 1..18).');
      }
      if (ids.has(id)) throw new Error('Auto Mode POM template has duplicate id "' + id + '".');
      ids.add(id);

      if (!validViews.has(row.view)) {
        throw new Error('Auto Mode POM ' + id + ' has invalid view "' + row.view + '".');
      }
      if (row.placementViewRole != null && !validPlacementRoles.has(row.placementViewRole)) {
        throw new Error('Auto Mode POM ' + id + ' has invalid placementViewRole "' + row.placementViewRole + '".');
      }
      if (row.view === 'front_to_back' && !row.placementViewRole) {
        throw new Error('Auto Mode POM ' + id + ' front_to_back rows must declare placementViewRole.');
      }
      if (!Array.isArray(row.requiredAnchors)) {
        throw new Error('Auto Mode POM ' + id + ' is missing requiredAnchors.');
      }
      assertAnchorListExists(id, 'requiredAnchors', row.requiredAnchors, anchorKinds);
      if (row.optionalAnchors != null) {
        if (!Array.isArray(row.optionalAnchors)) {
          throw new Error('Auto Mode POM ' + id + ' optionalAnchors must be an array.');
        }
        assertAnchorListExists(id, 'optionalAnchors', row.optionalAnchors, anchorKinds);
      }
    }

    for (let n = 1; n <= 16; n += 1) {
      if (!ids.has(String(n))) throw new Error('Auto Mode POM template is missing id "' + n + '".');
    }
  }

  function assertAnchorListExists(pomId, field, list, anchorKinds) {
    for (const rawKind of list) {
      const kind = String(rawKind);
      if (!anchorKinds.has(kind)) {
        throw new Error('Auto Mode POM ' + pomId + ' ' + field + ' references unknown anchor "' + kind + '".');
      }
    }
  }
