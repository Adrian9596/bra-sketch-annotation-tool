// US-096 + US-098 / ADR 0060: line looks and layered Line Treatments.
//
// A preset is a NAMED LOOK and nothing else — style, colour, line width, arrow
// type. It carries no geometry, so applying one can never move a line, change
// what it measures, or change which POM it is. The only thing it can change
// about a line's meaning is whether the line is a measurement at all, and that
// falls out of isMeasurementAnnotation (annotation-lookup.js) deriving the role
// from the style it just set.
//
// Storage is deliberately two-tier and offline throughout:
//   - localStorage, keyed per browser, is the TD's own working set;
//   - a copy travels inside the project file so a board opened on another
//     machine can still show — and offer to import — the presets it was drawn
//     with. Opening a project never silently overwrites the local library.
//
// Sibling files: the dropdown UI is src/ui/line-preset-panel.js; the style
// normalizers it builds on are src/manual/style.js.
// Source part for app.js. Run `npm run build` after editing.

  // Functions, not module-scope consts: every part shares one scope, and a
  // `const` read during load would throw a TDZ ReferenceError from any part
  // that happens to run earlier. See CLAUDE.md "Living in one shared scope".
  function linePresetsStorageKey() { return 'bra-line-presets-v1'; }
  function linePresetsFormatVersion() { return 2; }

  function lineTreatmentPatterns() { return ['solid', 'dashed', 'zigzag']; }

  function normalizeLineTreatmentLayer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pattern = lineTreatmentPatterns().includes(raw.pattern) ? raw.pattern : 'solid';
    const offset = clamp(Number.isFinite(Number(raw.offset)) ? Number(raw.offset) : 0, -40, 40);
    const width = clamp(Number.isFinite(Number(raw.width)) ? Number(raw.width) : DEFAULT_LINE_WIDTH, 0.5, 16);
    const spacing = clamp(Number.isFinite(Number(raw.spacing)) ? Number(raw.spacing) : 10, 2, 80);
    const amplitude = clamp(Number.isFinite(Number(raw.amplitude)) ? Number(raw.amplitude) : 4, 1, 40);
    return {
      id: String(raw.id || libraryEntryId('tl')),
      pattern,
      offset,
      width,
      color: normalizeColorKey(raw.color),
      spacing,
      amplitude,
      hidden: !!raw.hidden,
    };
  }

  function normalizeLineTreatmentLayers(list) {
    return (Array.isArray(list) ? list : [])
      .map(normalizeLineTreatmentLayer)
      .filter(Boolean)
      .slice(0, 8);
  }

  function legacyStyleTreatmentLayers(style, color, lineWidth) {
    const normalizedStyle = normalizeLineStyle(style);
    const layerColor = normalizeColorKey(color);
    const width = normalizeLineWidth(lineWidth);
    if (normalizedStyle === 'cover') {
      return [
        normalizeLineTreatmentLayer({ pattern: 'dashed', offset: -4, width: width * 0.65, color: layerColor, spacing: 12 }),
        normalizeLineTreatmentLayer({ pattern: 'dashed', offset: 4, width: width * 0.65, color: layerColor, spacing: 12 }),
      ];
    }
    if (normalizedStyle === 'bartack') {
      return [normalizeLineTreatmentLayer({ pattern: 'zigzag', offset: 0, width: width * 0.6, color: layerColor, spacing: 3, amplitude: 7 })];
    }
    return [normalizeLineTreatmentLayer({
      pattern: normalizedStyle === 'zigzag' ? 'zigzag' : normalizedStyle === 'dashed' ? 'dashed' : 'solid',
      offset: 0,
      width,
      color: layerColor,
      spacing: normalizedStyle === 'zigzag' ? 5 : 10,
      amplitude: normalizedStyle === 'zigzag' ? 5 : 4,
    })];
  }

  function normalizeLineTreatment(raw, fallback) {
    const source = raw && typeof raw === 'object' ? raw : {};
    let layers = normalizeLineTreatmentLayers(source.layers);
    if (!layers.length && fallback) {
      layers = legacyStyleTreatmentLayers(fallback.style, fallback.color, fallback.lineWidth);
    }
    if (!layers.length) return null;
    return {
      name: String(source.name || (fallback && fallback.name) || 'Custom treatment').trim().slice(0, 60),
      layers,
    };
  }

  function hasLineTreatment(ann) {
    return !!(ann && normalizeLineTreatmentLayers(ann.lineTreatment && ann.lineTreatment.layers).length);
  }

  // The set every TD starts with. Ids are stable strings (not the shared
  // idCounter) so an exported file imported on another machine matches by id
  // instead of duplicating the built-ins.
  //
  // The names deliberately do NOT repeat the five style rows this menu already
  // shows above the divider. A preset is a style PLUS a colour, a width and an
  // arrow choice, so each name says what it adds — otherwise the library reads
  // as a second copy of the Stitches list and a TD cannot tell the two apart.
  function builtinLinePresets() {
    return [
      { id: 'builtin-pom', name: 'POM line (red, arrows)', style: 'solid', color: 'red', lineWidth: 2.5, arrowType: 'double', builtin: true },
      { id: 'builtin-extension', name: 'Extension (dashed, one arrow)', style: 'dashed', color: 'red', lineWidth: 2.5, arrowType: 'single', builtin: true },
      { id: 'builtin-zigzag', name: 'Zigzag (blue, no arrow)', style: 'zigzag', color: 'blue', lineWidth: 2.5, arrowType: 'none', builtin: true, kind: 'treatment', treatment: { name: 'Zigzag', layers: legacyStyleTreatmentLayers('zigzag', 'blue', 2.5) } },
      { id: 'builtin-cover', name: 'Cover stitch (blue, no arrow)', style: 'cover', color: 'blue', lineWidth: 2.5, arrowType: 'none', builtin: true, kind: 'treatment', treatment: { name: 'Cover stitch', layers: legacyStyleTreatmentLayers('cover', 'blue', 2.5) } },
      { id: 'builtin-bartack', name: 'Bartack (black, no arrow)', style: 'bartack', color: 'black', lineWidth: 2.5, arrowType: 'none', builtin: true, kind: 'treatment', treatment: { name: 'Bartack', layers: legacyStyleTreatmentLayers('bartack', 'black', 2.5) } },
      { id: 'builtin-binding', name: 'Binding', style: 'solid', color: 'black', lineWidth: 2, arrowType: 'none', builtin: true, kind: 'treatment', treatment: { name: 'Binding', layers: [
        normalizeLineTreatmentLayer({ pattern: 'solid', offset: -4, width: 1.8, color: 'black' }),
        normalizeLineTreatmentLayer({ pattern: 'solid', offset: 4, width: 1.8, color: 'black' }),
        normalizeLineTreatmentLayer({ pattern: 'dashed', offset: 0, width: 1.2, color: 'blue', spacing: 10 }),
      ] } },
    ];
  }

  function normalizeLinePresetArrowType(value) {
    return ['single', 'double', 'none'].includes(value) ? value : 'none';
  }

  function normalizeLinePreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name) return null;
    const kind = raw.kind === 'treatment' || raw.treatment || raw.layers || isStitchStyle(raw.style)
      ? 'treatment' : 'look';
    const treatment = kind === 'treatment'
      ? normalizeLineTreatment(raw.treatment || { layers: raw.layers }, raw)
      : null;
    return {
      id: String(raw.id || libraryEntryId('lp')),
      name: name.slice(0, 60),
      style: normalizeLineStyle(raw.style),
      color: normalizeColorKey(raw.color),
      lineWidth: normalizeLineWidth(raw.lineWidth),
      arrowType: normalizeLinePresetArrowType(raw.arrowType),
      builtin: !!raw.builtin,
      kind,
      treatment,
    };
  }

  function normalizeLinePresetList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(list) ? list : [])) {
      const preset = normalizeLinePreset(raw);
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      out.push(preset);
    }
    return out;
  }

  // Lazily-read cache of the stored library. Module scope, like lineClipboard:
  // deliberately NOT part of state, so it is absent from history snapshots and
  // an Undo cannot roll the library back.
  let linePresetStore = null;

  function getLinePresets() {
    if (linePresetStore) return linePresetStore;
    // US-097: the policy — corrupt-payload fallback, and the `seeded` marker
    // that keeps an emptied library empty — now lives in library-store.js and
    // is shared with the shape-stamp library, so the two cannot drift.
    const read = readLibraryStore(linePresetsStorageKey(), 'presets', normalizeLinePresetList);
    if (read.version > 0 && read.version < linePresetsFormatVersion()) {
      // v2 introduces true layered Treatments and the bundled Binding recipe.
      // Merge them once even when a v1 profile deliberately stored an empty
      // preset list; after this write the v2 seeded-empty contract is respected
      // again, so deleting every Treatment still sticks across reload.
      linePresetStore = libraryImportMerge(builtinLinePresets(), read.list);
      saveLinePresets();
    } else {
      linePresetStore = (read.list.length || read.seeded) ? read.list : builtinLinePresets();
    }
    return linePresetStore;
  }

  function saveLinePresets() {
    return writeLibraryStore(linePresetsStorageKey(), 'presets',
      linePresetsFormatVersion(), getLinePresets());
  }

  // Whether the LAST commit reached durable storage. Read by the panel so each
  // action can word its own toast — one message, correct for that action, and
  // last on screen.
  let lastLinePresetWritePersisted = true;

  function linePresetsPersisted() {
    return lastLinePresetWritePersisted;
  }

  function getLinePresetById(id) {
    return getLinePresets().find(preset => preset.id === id) || null;
  }

  function commitLinePresets(list) {
    linePresetStore = normalizeLinePresetList(list);
    lastLinePresetWritePersisted = saveLinePresets();
    if (typeof updateUI === 'function') updateUI();
    return lastLinePresetWritePersisted;
  }

  // ---- Mutations -----------------------------------------------------------

  // The look of the primary selected line, or the current draw defaults when
  // nothing is selected — the same fallback the toolbar chips use, so "Save as
  // preset" always has something honest to save.
  function currentLineLook() {
    const ann = (typeof getSelectedAnnotation === 'function') ? getSelectedAnnotation() : null;
    if (ann) {
      return {
        style: getLineStyle(ann),
        color: normalizeColorKey(ann.color),
        lineWidth: getLineWidth(ann),
        arrowType: getArrowType(ann),
        treatment: hasLineTreatment(ann) ? normalizeLineTreatment(ann.lineTreatment) : null,
      };
    }
    return {
      style: normalizeLineStyle(state.drawStyle),
      color: normalizeColorKey(state.drawColor),
      lineWidth: normalizeLineWidth(state.lineWidth),
      arrowType: normalizeLinePresetArrowType(state.arrowType),
      treatment: null,
    };
  }

  function addLinePreset(name) {
    const preset = normalizeLinePreset({ ...currentLineLook(), name });
    if (!preset) return null;
    commitLinePresets([...getLinePresets(), preset]);
    return preset;
  }

  function currentLineTreatment() {
    const ann = (typeof getSelectedAnnotation === 'function') ? getSelectedAnnotation() : null;
    if (ann && hasLineTreatment(ann)) return normalizeLineTreatment(ann.lineTreatment);
    const look = currentLineLook();
    return normalizeLineTreatment(null, { ...look, name: 'Custom treatment' });
  }

  function addLineTreatment(name, recipe) {
    const treatment = normalizeLineTreatment(recipe || currentLineTreatment(), { ...currentLineLook(), name });
    if (!treatment) return null;
    treatment.name = String(name || treatment.name || 'Custom treatment').trim().slice(0, 60);
    const first = treatment.layers[0];
    const preset = normalizeLinePreset({
      id: libraryEntryId('lt'), name: treatment.name, kind: 'treatment', treatment,
      style: 'solid', color: first.color, lineWidth: first.width, arrowType: 'none',
    });
    if (!preset) return null;
    commitLinePresets([...getLinePresets(), preset]);
    return preset;
  }

  function updateLineTreatment(id, recipe, name) {
    const current = getLinePresetById(id);
    if (!current) return false;
    const treatment = normalizeLineTreatment(recipe, current);
    if (!treatment) return false;
    treatment.name = String(name || current.name || treatment.name).trim().slice(0, 60);
    const first = treatment.layers[0];
    commitLinePresets(getLinePresets().map(preset => preset.id === id ? {
      ...preset,
      name: treatment.name,
      kind: 'treatment',
      treatment,
      style: 'solid',
      color: first.color,
      lineWidth: first.width,
      arrowType: 'none',
    } : preset));
    return true;
  }

  function applyTreatmentRecipeToAnnotations(recipe, annotations, legacyLook) {
    const treatment = normalizeLineTreatment(recipe);
    const anns = Array.isArray(annotations) ? annotations.filter(Boolean) : [];
    if (!treatment || !anns.length) return 0;
    const before = snapshotFingerprint(makeSnapshot());
    for (const ann of anns) {
      ann.lineTreatment = clone(treatment);
      if (legacyLook && typeof legacyLook === 'object') {
        ann.style = normalizeLineStyle(legacyLook.style);
        ann.color = normalizeColorKey(legacyLook.color);
        ann.lineWidth = normalizeLineWidth(legacyLook.lineWidth);
        ann.arrowType = normalizeLinePresetArrowType(legacyLook.arrowType);
      } else {
        ann.arrowType = 'none';
      }
    }
    if (before !== snapshotFingerprint(makeSnapshot())) pushHistoryIfChanged();
    updateUI();
    requestRender();
    return anns.length;
  }

  function customizeSelectedLineTreatment(recipe) {
    const ann = (typeof getSelectedAnnotation === 'function') ? getSelectedAnnotation() : null;
    return applyTreatmentRecipeToAnnotations(recipe, ann ? [ann] : []);
  }

  function renameLinePreset(id, name) {
    const trimmed = String(name == null ? '' : name).trim();
    if (!trimmed) return false;
    const list = getLinePresets().map(preset => (preset.id === id
      ? { ...preset, name: trimmed.slice(0, 60) } : preset));
    commitLinePresets(list);
    return true;
  }

  function deleteLinePreset(id) {
    const list = getLinePresets().filter(preset => preset.id !== id);
    if (list.length === getLinePresets().length) return false;
    commitLinePresets(list);
    return true;
  }

  // Move one preset up (-1) or down (+1). Clamped rather than wrapping: a TD
  // holding the button expects the row to stop at the end, not jump to the
  // other one.
  function moveLinePreset(id, delta) {
    const list = libraryMoveEntry(getLinePresets(), id, delta);
    if (!list) return false;
    commitLinePresets(list);
    return true;
  }

  // The menu presents Treatments and saved Looks as separate subgroups. Move
  // within that visible subgroup so an enabled arrow always produces a visible
  // result instead of silently crossing the subgroup boundary.
  function moveLinePresetWithinKind(id, delta) {
    const list = getLinePresets();
    const index = list.findIndex(preset => preset.id === id);
    if (index < 0) return false;
    const kind = list[index].kind === 'treatment' ? 'treatment' : 'look';
    const siblingIndices = list
      .map((preset, presetIndex) => ({ preset, presetIndex }))
      .filter(entry => (entry.preset.kind === 'treatment' ? 'treatment' : 'look') === kind)
      .map(entry => entry.presetIndex);
    const position = siblingIndices.indexOf(index);
    const targetPosition = clamp(position + Math.sign(Number(delta) || 0), 0, siblingIndices.length - 1);
    if (targetPosition === position) return false;
    const targetIndex = siblingIndices[targetPosition];
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    commitLinePresets(list);
    return true;
  }

  function resetLinePresetsToBuiltins() {
    commitLinePresets(builtinLinePresets());
  }

  // ---- Applying ------------------------------------------------------------

  // Apply to every selected line; with nothing selected, set the defaults the
  // next drawn line is born with. Mirrors setLineStyle's split exactly — and
  // like it, applying to a selection never changes the board's POM/Stitch mode
  // (ADR 0055).
  function applyLinePreset(id) {
    const preset = getLinePresetById(id);
    if (!preset) return false;
    const settings = {
      style: preset.style,
      color: preset.color,
      lineWidth: preset.lineWidth,
      arrowType: preset.arrowType,
    };
    const selected = (typeof getSelectedAnnotationsForEdit === 'function')
      ? getSelectedAnnotationsForEdit() : [];
    if (selected.length) {
      if (preset.kind === 'treatment' && preset.treatment) {
        applyTreatmentRecipeToAnnotations(preset.treatment, selected, preset);
      } else {
        applyToSelectedAnnotations({ ...settings, lineTreatment: null });
      }
      showToast(selected.length > 1
        ? `${preset.name} applied to ${selected.length} lines.`
        : `${preset.name} applied.`);
      return true;
    }
    if (preset.kind === 'treatment') {
      showToast('Select a straight or curved line, then apply the treatment.');
      return false;
    }
    state.drawColor = settings.color;
    state.lineWidth = settings.lineWidth;
    state.arrowType = settings.arrowType;
    // Last, and through the shared setter, so the board-mode switch and its
    // toast stay in exactly one place.
    setDefaultLineStyle(settings.style);
    showToast(`${preset.name} is now the default for new lines.`);
    return true;
  }

  // ---- Portability ---------------------------------------------------------

  function linePresetsEnvelope() {
    return { format: 'bra-line-presets', version: linePresetsFormatVersion(), presets: getLinePresets() };
  }

  function exportLinePresetsFile() {
    const blob = new Blob([JSON.stringify(linePresetsEnvelope(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'line-presets.json');
  }

  // Import is additive by id: a preset whose id already exists is replaced, a
  // new one is appended. Merging rather than replacing means a TD who imports a
  // colleague's set does not lose their own.
  function importLinePresets(list) {
    const incoming = normalizeLinePresetList(list);
    if (!incoming.length) return 0;
    commitLinePresets(libraryImportMerge(getLinePresets(), incoming));
    return incoming.length;
  }

  function importLinePresetsFromJson(text) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { return 0; }
    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.presets);
    return importLinePresets(list);
  }

  // ---- Project embedding ---------------------------------------------------

  // What buildProjectSnapshot writes. Additive and optional: a file saved
  // before US-096 simply has no key.
  function serializeLinePresetsForProject() {
    return clone(getLinePresets());
  }

  // What project-load hands back. Deliberately NOT applied automatically —
  // the local library is the TD's own tooling and a project must not rewrite
  // it. Returns the presets in the file that the local library does not
  // already have, for the caller to offer.
  function unknownLinePresetsFromProject(list) {
    return libraryUnknownEntries(getLinePresets(), normalizeLinePresetList(list));
  }

  // The load-time half of the two-store contract. Never writes the library —
  // it records what the file offers and tells the TD, who imports from the
  // Presets menu if they want them. Silence when the file adds nothing new:
  // most projects will carry the same built-ins the TD already has.
  let pendingProjectLinePresets = [];

  function offerLinePresetsFromProject(list) {
    pendingProjectLinePresets = unknownLinePresetsFromProject(list);
    if (!pendingProjectLinePresets.length) return 0;
    const count = pendingProjectLinePresets.length;
    showToast(`This project uses ${count} line preset${count > 1 ? 's' : ''} you don't have — Presets ▸ Import from project.`);
    return count;
  }

  function getPendingProjectLinePresets() {
    return pendingProjectLinePresets;
  }

  function importPendingProjectLinePresets() {
    const added = importLinePresets(pendingProjectLinePresets);
    pendingProjectLinePresets = [];
    return added;
  }
