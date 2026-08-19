// POM-meaning catalog and style-scoped confirmation store. Source part
// for app.js. Run `npm run build` after editing.
//
// The meaning store is keyed by style id (per-project Style code). POMs
// 1/3/5 are fixed and resolve via POM_FIXED_MEANINGS; POMs 6+ resolve via
// each style bucket. The ranking heuristics and the manual-line-to-meaning
// commit workflow (including evaluateManualPomSample, the single funnel
// between manual labelling and the meaning popover) live in the sibling
// src/auto/learning/meaning-commit.js, which loads after this file.
// resetPomMeanings lives here (not in calibration-store.js) because it
// only touches this file's own meaningStore/getStyleBucket/clearMeaningStore
// state.

  // ---- Phase 3: meaning catalog + confirmation store -----------------

  const MEANINGS_KEY = 'bra.pomMeanings.v1';

  // Built-in catalog. Each measurement maps a {start, end} anchor pair
  // to a human label. Seeded from the original POM_ENDPOINT_ANCHORS map
  // — these are the only meanings present on first launch. POMs 1/3/5
  // pin to entries here; POMs 6+ pick at confirmation time.
  const BUILTIN_MEANINGS = [
    { id: 'band-width',        label: 'Band width',          start: 'band-left',       end: 'band-right' },
    { id: 'chest-width',       label: 'Chest width',         start: 'chest-left',      end: 'chest-right' },
    { id: 'cf-height',         label: 'Center-front height', start: 'cf-top',          end: 'cf-bottom' },
    { id: 'cup-height',        label: 'Cup height',          start: 'inner-cup-top',   end: 'inner-cup-bottom' },
    { id: 'cup-width',         label: 'Cup width',           start: 'inner-cup-left',  end: 'inner-cup-right' },
    { id: 'cradle-height-bottom-cup', label: 'Cradle height at center bottom cup', start: 'cradle-cup-top', end: 'cradle-cup-bottom' },
    { id: 'side-height',       label: 'Side height',         start: 'side-top',        end: 'side-bottom' },
    { id: 'back-height',       label: 'Back height',         start: 'back-top',        end: 'back-bottom' },
    { id: 'back-panel-height', label: 'Back panel height',   start: 'back-panel-top',  end: 'back-panel-bottom' },
    { id: 'strap-length',      label: 'Strap length',        start: 'strap-top',       end: 'strap-bottom' },
    { id: 'back-strap-width',  label: 'Back strap width',    start: 'back-strap-left', end: 'back-strap-right' },
    { id: 'apex-width',        label: 'Apex width',          start: 'apex-left',       end: 'apex-right' },
  ];

  // POMs whose meaning never varies across styles. POM 2 and 4 are
  // omitted on purpose: their end points are derived (extension lines),
  // not anchors. evaluateManualPomSample() short-circuits both.
  const POM_FIXED_MEANINGS = {
    '1': 'band-width',
    '3': 'chest-width',
    '5': 'cf-height',
    '7': 'cradle-height-bottom-cup',
  };

  // localStorage shape (style-scoped, Phase 3.5):
  //   styles: {
  //     [styleId]:      { pomMeanings: { [pomNumber]: meaningId } },
  //     '__default__':  { pomMeanings: {...} }   // empty styleId falls here
  //   }
  //   customMeanings:   { [id]: { id, label, start, end } }   // shared
  //   usage:            { [meaningId]: { count, lastUsedAt } } // shared
  //
  // POM 9 = cup-height in Style A and POM 9 = side-height in Style B
  // never collide — each lives in its own style bucket.
  const DEFAULT_STYLE_ID = '__default__';

  let meaningStore = { styles: {}, customMeanings: {}, usage: {} };
  (function loadMeaningStore() {
    try {
      const raw = localStorage.getItem(MEANINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const styles = (parsed.styles && typeof parsed.styles === 'object') ? parsed.styles : {};
      // Migrate Phase 3.0 flat shape — { pomMeanings: {...} } at top
      // level — into the '__default__' style bucket so existing
      // confirmations on this machine survive the upgrade.
      if (parsed.pomMeanings && typeof parsed.pomMeanings === 'object' && !styles[DEFAULT_STYLE_ID]) {
        styles[DEFAULT_STYLE_ID] = { pomMeanings: parsed.pomMeanings };
      }
      meaningStore = {
        styles,
        customMeanings: parsed.customMeanings || {},
        usage:          parsed.usage          || {},
      };
    } catch (_) {}
  })();

  function saveMeaningStore() {
    try { localStorage.setItem(MEANINGS_KEY, JSON.stringify(meaningStore)); }
    catch (_) {}
  }

  function currentStyleId() {
    const id = (state && state.styleId && String(state.styleId).trim()) || '';
    return id || DEFAULT_STYLE_ID;
  }

  function getStyleBucket(styleId, createIfMissing) {
    let bucket = meaningStore.styles[styleId];
    if (!bucket && createIfMissing) {
      bucket = { pomMeanings: {} };
      meaningStore.styles[styleId] = bucket;
    }
    return bucket || null;
  }

  function getCatalogEntry(meaningId) {
    if (!meaningId) return null;
    const builtin = BUILTIN_MEANINGS.find(m => m.id === meaningId);
    return builtin || meaningStore.customMeanings[meaningId] || null;
  }

  function getAllCatalogMeanings() {
    const out = [];
    const seen = new Set();
    for (const m of BUILTIN_MEANINGS) { seen.add(m.id); out.push(m); }
    for (const id in meaningStore.customMeanings) {
      if (!seen.has(id)) out.push(meaningStore.customMeanings[id]);
    }
    return out;
  }

  function resolvePomMeaning(pom) {
    if (POM_FIXED_MEANINGS[pom]) return getCatalogEntry(POM_FIXED_MEANINGS[pom]);
    const bucket = getStyleBucket(currentStyleId(), false);
    const id = bucket ? bucket.pomMeanings[pom] : null;
    return id ? getCatalogEntry(id) : null;
  }

  function confirmPomMeaning(pom, meaningId) {
    const bucket = getStyleBucket(currentStyleId(), true);
    bucket.pomMeanings[pom] = meaningId;
    saveMeaningStore();
  }

  // Drop a single (style, pom) binding. Next POM N commit in that
  // style will re-open the meaning popover. Returns true if a binding
  // was actually removed.
  function forgetPomMeaning(pom, styleId) {
    const bucket = getStyleBucket(styleId || currentStyleId(), false);
    if (!bucket || !bucket.pomMeanings[pom]) return false;
    delete bucket.pomMeanings[pom];
    saveMeaningStore();
    return true;
  }

  // Sorted snapshot of confirmed bindings for one style. Used by the
  // Manage Meanings UI to list and edit prior confirmations.
  function listConfirmedMeanings(styleId) {
    const bucket = getStyleBucket(styleId || currentStyleId(), false);
    if (!bucket) return [];
    const rows = [];
    for (const pom of Object.keys(bucket.pomMeanings)) {
      const meaning = getCatalogEntry(bucket.pomMeanings[pom]);
      if (meaning) rows.push({ pom, meaning });
    }
    rows.sort((a, b) => Number(a.pom) - Number(b.pom));
    return rows;
  }

  function listKnownStyleIds() {
    return Object.keys(meaningStore.styles);
  }

  function addCustomMeaning(label, startAnchor, endAnchor) {
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) return null;
    const slug = cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meaning';
    const id = 'custom-' + slug + '-' + Date.now().toString(36);
    const entry = { id, label: cleanLabel, start: startAnchor, end: endAnchor };
    meaningStore.customMeanings[id] = entry;
    saveMeaningStore();
    return entry;
  }

  // Clear meanings only. Accepts 'current' (current style only) or
  // 'all' (every style + every custom meaning + usage stats).
  function clearMeaningStore(scope) {
    if (scope === 'all') {
      meaningStore = { styles: {}, customMeanings: {}, usage: {} };
    } else {
      const styleId = currentStyleId();
      if (meaningStore.styles[styleId]) {
        meaningStore.styles[styleId] = { pomMeanings: {} };
      }
    }
    saveMeaningStore();
  }

  // Reset POM meanings only. 'current' wipes the current style bucket
  // ({styleId} or default), 'all' wipes every style + custom meanings.
  // Calibration residuals are untouched.
  function resetPomMeanings(scope) {
    const styleId = currentStyleId();
    if (scope === 'all') {
      let total = 0;
      for (const sid in meaningStore.styles) {
        total += Object.keys(meaningStore.styles[sid].pomMeanings || {}).length;
      }
      const customCount = Object.keys(meaningStore.customMeanings || {}).length;
      if (total === 0 && customCount === 0) {
        showToast('No POM meanings confirmed yet.');
        return;
      }
      if (!window.confirm('Forget every confirmed POM meaning across every style code, plus ' + customCount + ' custom measurement(s)? This cannot be undone.')) return;
      clearMeaningStore('all');
      showToast('All POM meanings forgotten.');
    } else {
      const bucket = getStyleBucket(styleId, false);
      const count = bucket ? Object.keys(bucket.pomMeanings).length : 0;
      if (count === 0) {
        showToast(styleId === DEFAULT_STYLE_ID
          ? 'No POM meanings confirmed for the default bucket yet.'
          : 'No POM meanings confirmed for style "' + styleId + '" yet.');
        return;
      }
      const label = styleId === DEFAULT_STYLE_ID ? 'the default bucket' : 'style "' + styleId + '"';
      if (!window.confirm('Forget ' + count + ' confirmed POM meaning(s) for ' + label + '?')) return;
      clearMeaningStore('current');
      showToast('POM meanings forgotten for ' + label + '.');
    }
    updateUI();
  }

  // Transparent Learning panel feed. Collapses the style-scoped meaning
  // store into a shape the Learning Data modal can render directly.
  // Fixed POMs (1/3/5) are always included so the panel shows the full
  // resolved catalog instead of just style-confirmed POMs.
  function summarizeMeaningStore() {
    const styleId = currentStyleId();
    const currentRows = [];
    const fixedCatalog = {};
    for (const pom of Object.keys(POM_FIXED_MEANINGS)) {
      fixedCatalog[pom] = getCatalogEntry(POM_FIXED_MEANINGS[pom]);
    }
    for (const pom of Object.keys(POM_FIXED_MEANINGS)) {
      const meaning = fixedCatalog[pom];
      if (!meaning) continue;
      currentRows.push({ pom, meaning, source: 'fixed' });
    }
    for (const row of listConfirmedMeanings(styleId)) {
      currentRows.push({ pom: row.pom, meaning: row.meaning, source: 'confirmed' });
    }
    currentRows.sort((a, b) => Number(a.pom) - Number(b.pom));

    const styles = [];
    let totalConfirmed = 0;
    for (const sid of Object.keys(meaningStore.styles)) {
      const count = Object.keys(meaningStore.styles[sid].pomMeanings || {}).length;
      totalConfirmed += count;
      styles.push({ styleId: sid, confirmedCount: count });
    }
    styles.sort((a, b) => {
      if (a.styleId === DEFAULT_STYLE_ID) return -1;
      if (b.styleId === DEFAULT_STYLE_ID) return 1;
      return a.styleId < b.styleId ? -1 : (a.styleId > b.styleId ? 1 : 0);
    });

    return {
      currentStyleId: styleId,
      currentStyleIsDefault: styleId === DEFAULT_STYLE_ID,
      defaultStyleId: DEFAULT_STYLE_ID,
      fixedPomCount: Object.keys(POM_FIXED_MEANINGS).length,
      confirmedForCurrent: listConfirmedMeanings(styleId).length,
      totalConfirmed,
      customCount: Object.keys(meaningStore.customMeanings || {}).length,
      knownStyles: styles,
      currentRows,
    };
  }
