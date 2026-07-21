// POM-meaning catalog, style-scoped confirmation store, manual learning
// dedup hash, and meaning-priority ranking. Source part for app.js.
// Run `npm run build` after editing.
//
// The meaning store is keyed by style id (per-project Style code). POMs
// 1/3/5 are fixed and resolve via POM_FIXED_MEANINGS; POMs 6+ resolve via
// each style bucket. evaluateManualPomSample is the single funnel between
// manual labelling and the meaning popover.

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

  // Recency-decayed usage weight. A meaning confirmed yesterday should
  // outrank one that was confirmed 200 times two years ago but never
  // since — TDs change templates, and stale usage stats mislead the
  // top-3. Half-life of ~21d (exp(-21/30) ≈ 0.5) decays old confirmations
  // smoothly without ever zeroing them out completely.
  function meaningUsagePriority(meaningId) {
    const u = meaningStore.usage[meaningId];
    if (!u || !u.count) return 0;
    const ageMs = Math.max(0, Date.now() - (u.lastUsedAt || 0));
    const ageDays = ageMs / 86400000;
    return u.count * Math.exp(-ageDays / 30);
  }

  // Rank catalog entries by anchor-pair distance to the manual line.
  // Stroke direction is arbitrary, so we compare both orderings. Distance
  // dominates so the geometry of the current sketch always wins; ties
  // break on a recency-weighted usage score so a meaning the TD just
  // confirmed on the last two sketches floats above a stale heavyweight.
  function rankCatalogForLine(image, ann, limit) {
    if (!image || !ann || !ann.start || !ann.end) return [];
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return [];
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const scored = [];
    for (const m of getAllCatalogMeanings()) {
      const a = rawAnchors.find(r => r.kind === m.start);
      const b = rawAnchors.find(r => r.kind === m.end);
      if (!a || !b) continue;
      const direct  = (ms.x - a.x) ** 2 + (ms.y - a.y) ** 2 + (me.x - b.x) ** 2 + (me.y - b.y) ** 2;
      const swapped = (ms.x - b.x) ** 2 + (ms.y - b.y) ** 2 + (me.x - a.x) ** 2 + (me.y - a.y) ** 2;
      scored.push({ meaning: m, d: Math.min(direct, swapped), priority: meaningUsagePriority(m.id) });
    }
    scored.sort((x, y) => x.d - y.d || y.priority - x.priority);
    return scored.slice(0, limit || 3).map(s => s.meaning);
  }

  // Picks the nearest raw anchor to each manual endpoint independently.
  // Used when the TD names a brand-new measurement so we can register
  // its anchor pair without asking them to pick anchors.
  function detectAnchorPairForLine(image, ann) {
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors || rawAnchors.length < 2) return null;
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const d2 = (p, a) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    let bestStart = null, bestStartD = Infinity;
    let bestEnd   = null, bestEndD   = Infinity;
    for (const a of rawAnchors) {
      const ds = d2(ms, a);
      if (ds < bestStartD) { bestStartD = ds; bestStart = a; }
      const de = d2(me, a);
      if (de < bestEndD)   { bestEndD   = de; bestEnd   = a; }
    }
    if (!bestStart || !bestEnd || bestStart.kind === bestEnd.kind) return null;
    return { start: bestStart.kind, end: bestEnd.kind };
  }

  // Endpoint coord hash for de-dup. Re-commit with no movement → same
  // hash → skip. Move an endpoint → new hash → new sample.
  function makeLearnSampleHash(pom, ann) {
    return pom + '|'
      + ann.start.x.toFixed(2) + ',' + ann.start.y.toFixed(2) + '|'
      + ann.end.x.toFixed(2)   + ',' + ann.end.y.toFixed(2);
  }

  // True when a re-evaluation of the same annotation should be skipped.
  // The endpoint-coord hash alone is not enough: if the TD reconfirms POM
  // N as a *different* meaning (e.g. POM 9 was cup-height, now side-height),
  // the residual lives in a different anchor bucket and must be re-recorded.
  // So we treat (hash, meaningId) as the dedup key.
  function isSameLearnSample(ann, hash, meaningId) {
    if (!ann || ann.learnSampleHash !== hash) return false;
    if (meaningId && ann.learnMeaningId && ann.learnMeaningId !== meaningId) return false;
    return true;
  }

  // Returns one of:
  //   { status: 'recorded',          pom }
  //   { status: 'skipped' }                              — no learning happens
  //   { status: 'needsConfirmation', pom, ann, image, hash, suggestions }
  //     — caller should open the meaning picker. After the TD picks,
  //       call commitMeaningChoice() / commitMeaningChoiceCustom() with
  //       the original eval result.
  function evaluateManualPomSample(ann, options = {}) {
    if (!ann || !ann.start || !ann.end) return { status: 'skipped' };
    if (!isLearningEnabled())            return { status: 'skipped' };
    if (ann.auto === true && !options.allowAuto) return { status: 'skipped' };

    const explicitText = ann.text != null && String(ann.text).trim() !== ''
      ? ann.text
      : null;
    const labelText = explicitText != null
      ? explicitText
      : (options.allowAuto ? getLabelText(ann) : null);
    const pom = parsePomNumberFromLabel(labelText);
    if (!pom) return { status: 'skipped' };

    // POMs 2 and 4: derived endpoints (extension lines). Skip silently.
    const pomNum = Number(pom);
    if (pomNum === 2 || pomNum === 4) return { status: 'skipped' };

    const image = pickImageForAnnotation(ann);
    if (!image) return { status: 'skipped' };

    const hash = makeLearnSampleHash(pom, ann);
    const meaning = resolvePomMeaning(pom);
    if (meaning) {
      // Skip only when the same hash AND meaning were already recorded on
      // this annotation; a meaning change still re-records so the new
      // anchor bucket gets the sample.
      if (isSameLearnSample(ann, hash, meaning.id)) return { status: 'skipped' };
      const ok = applyMeaningSample(ann, image, pom, meaning, hash);
      return { status: ok ? 'recorded' : 'skipped', pom };
    }

    // POM 6+ with no confirmed meaning — surface to the UI. No meaning is
    // known yet, so dedup falls back to the endpoint hash alone.
    if (ann.learnSampleHash === hash) return { status: 'skipped' };
    const suggestions = rankCatalogForLine(image, ann, 3);
    return { status: 'needsConfirmation', pom, ann, image, hash, suggestions };
  }

  // Records the residual for a (line, meaning) pair through the Phase 1
  // store. Returns true if the sample was actually committed.
  function applyMeaningSample(ann, image, pom, meaning, hash) {
    if (!meaning) return false;
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return false;
    const startAnchor = rawAnchors.find(a => a.kind === meaning.start);
    const endAnchor   = rawAnchors.find(a => a.kind === meaning.end);
    if (!startAnchor || !endAnchor) return false;

    const manualStart = worldToAnchorSpace(image, ann.start);
    const manualEnd   = worldToAnchorSpace(image, ann.end);

    // Stroke orientation is arbitrary — pair endpoints by min total distance.
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    const direct  = d2(manualStart, startAnchor) + d2(manualEnd, endAnchor);
    const swapped = d2(manualStart, endAnchor)   + d2(manualEnd, startAnchor);
    const pairs = direct <= swapped
      ? [[startAnchor, manualStart], [endAnchor, manualEnd]]
      : [[startAnchor, manualEnd],   [endAnchor, manualStart]];

    // Label-collision guardrail: a manual line more than half the image
    // away from the predicted anchor is almost certainly mislabeled.
    const maxResidual = 0.50;
    for (const [anchor, manual] of pairs) {
      if (Math.abs(manual.x - anchor.x) > maxResidual) return false;
      if (Math.abs(manual.y - anchor.y) > maxResidual) return false;
    }

    for (const [anchor, manual] of pairs) {
      recordAnchorResidual(anchor.kind, manual.x - anchor.x, manual.y - anchor.y, anchor);
    }

    ann.learnSampleHash = hash;
    ann.learnSamplePom  = pom;
    ann.learnMeaningId  = meaning.id;

    if (meaning.id) {
      const u = meaningStore.usage[meaning.id] || { count: 0, lastUsedAt: 0 };
      u.count += 1;
      u.lastUsedAt = Date.now();
      meaningStore.usage[meaning.id] = u;
      saveMeaningStore();
    }
    return true;
  }

  // TD picked an existing catalog entry from the popover.
  function commitMeaningChoice(evalResult, meaningId) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const meaning = getCatalogEntry(meaningId);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaningId);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
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

  // TD typed a brand-new measurement name. We auto-detect the anchor
  // pair from the manual line itself, register it as a custom meaning,
  // pin POM N to it, then record the sample.
  function commitMeaningChoiceCustom(evalResult, label) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const pair = detectAnchorPairForLine(evalResult.image, evalResult.ann);
    if (!pair) return false;
    const meaning = addCustomMeaning(label, pair.start, pair.end);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaning.id);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
  }
