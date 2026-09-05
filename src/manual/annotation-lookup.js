// Manual mode POM/annotation lookup & predicate helpers, plus small pure
// state utilities (clone, inferNextIdCounter): annotationCrossesViews,
// getLabelText, lineLength, getPomInfo, getAnnotationById, isAutoDraft,
// isReviewOnlyDraft, createUniqueAnnotationId, getImageById. Sibling files:
// the big UI status updater lives in src/manual/ui-status.js; paste /
// drag-drop image import lives in src/manual/image-import.js.
// Source part for app.js. Run `npm run build` after editing.

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function inferNextIdCounter() {
    let max = 0;
    for (const ann of state.annotations) max = Math.max(max, Number(ann.id) || 0);
    for (const image of state.images) max = Math.max(max, Number(image.id) || 0);
    for (const draft of state.autoMode.draftAnnotations) max = Math.max(max, Number(draft.id) || 0);
    // US-092: notes draw from the same id counter, so a file with no idCounter
    // would otherwise re-issue their ids and break getNoteById lookups.
    for (const note of state.notes || []) max = Math.max(max, Number(note.id) || 0);
    // BOM rows/callouts/groupIds draw from the same counter (and since
    // US-074 every project has seeded rows) — skipping them here would let a
    // project file with a missing idCounter re-issue their ids to new
    // rows/images and corrupt id-keyed lookups like bmRowById.
    if (state.bom) {
      for (const row of state.bom.rows || []) {
        max = Math.max(max, Number(row.id) || 0, Number(row.groupId) || 0);
      }
      for (const c of state.bom.callouts || []) max = Math.max(max, Number(c.id) || 0);
      const bomImages = state.bom.images || {};
      for (const image of [...(bomImages.solid || []), ...(bomImages.lace || [])]) {
        max = Math.max(max, Number(image.id) || 0);
      }
    }
    return max + 1;
  }

  // True when start/end land in different detected view boxes (front vs back).
  // POM 16 (apex distance) can span the gap between sketches; rendering those
  // cross-view lines dashed prevents misreading them as measurements inside a
  // single view.
  function annotationCrossesViews(ann) {
    if (!ann || !ann.sourceImageId || !ann.start || !ann.end) return false;
    const det = state.autoMode && state.autoMode.detection;
    if (!det || det.sourceImageId !== ann.sourceImageId) return false;
    const boxes = det.viewBoxes;
    if (!Array.isArray(boxes) || boxes.length < 2) return false;
    const image = getImageById(ann.sourceImageId);
    if (!image || !image.width || !image.height) return false;
    const findViewIdx = (p) => {
      const nx = (p.x - image.x) / image.width;
      const ny = (p.y - image.y) / image.height;
      let best = -1;
      let bestArea = Infinity;
      for (let i = 0; i < boxes.length; i += 1) {
        const b = boxes[i];
        if (b == null) continue;
        if (nx >= b.x && nx <= b.x + b.width && ny >= b.y && ny <= b.y + b.height) {
          const area = b.width * b.height;
          if (area < bestArea) { bestArea = area; best = i; }
        }
      }
      return best;
    };
    const a = findViewIdx(ann.start);
    const b = findViewIdx(ann.end);
    if (a < 0 || b < 0) return false;
    return a !== b;
  }

  function getLabelText(ann) {
    if (hasManualPomLabel(ann)) return String(ann.text);
    return String(ann.seq);
  }

  // US-096 / ADR 0055 -------------------------------------------------------
  //
  // A line the TD typed a POM number onto, as opposed to one merely wearing the
  // sequence number it was born with. getLabelText falls back to `seq` so every
  // line has SOMETHING to draw, but that fallback is a drawing artefact, not a
  // statement of intent — only `text` is the TD saying "this line is POM 8".
  // The distinction is what makes isMeasurementAnnotation safe to derive.
  function hasManualPomLabel(ann) {
    return !!(ann && ann.text != null && String(ann.text).trim() !== '');
  }

  // Is this line part of the MEASUREMENT set — the collection the spec panel,
  // both Excel exports, the Preview page, grading and learning evidence all
  // derive their rows from?
  //
  // Plain and Dashed always are. Zigzag / Cover / Bartack are construction
  // marks: they say how a seam is sewn, not how long it is, so they are drawn
  // on the board and in every visual export but produce no measurement row and
  // no POM callout number.
  //
  // The one exception is deliberate: a stitch line the TD explicitly labelled
  // keeps measuring. Dropping it would empty a POM cell in a workbook the
  // factory may already be holding, which is a worse failure than one stray
  // row. ADR 0055 records why.
  //
  // Role is DERIVED, never stored. That is the point: no schema change, no
  // file migration, and converting a line back to Plain restores it as a
  // measurement automatically, which is exactly how a TD expects the Stitches
  // menu to behave.
  function isMeasurementAnnotation(ann) {
    if (!ann) return false;
    // US-098 / ADR 0058: geometry inserted from a Template is sketch
    // structure, never a measurement merely because its visible spine is
    // plain. A later Convert-to-POM command will remove this purpose
    // explicitly; style alone cannot promote it.
    if (ann.purpose === 'sketch-element') return false;
    if (!isStitchStyle(ann.style) && !hasLineTreatment(ann)) return true;
    return hasManualPomLabel(ann);
  }

  // The single shared accessor for "the measurement set". Every consumer that
  // means measurements calls this; every consumer that means "everything drawn
  // on the board" (rendering, hit-testing, selection, drag, history, autosave,
  // visual export) keeps reading state.annotations directly. Keeping the two
  // readings textually distinct is what makes a future omission greppable.
  function measurementAnnotations() {
    return (state.annotations || []).filter(isMeasurementAnnotation);
  }

  // Whether THIS line paints its callout number. The global gate (labelsVisible)
  // still applies — Stitch mode and the Hide Numbers toggle hide everything —
  // and on top of it a construction line never numbers itself even while the
  // board is in POM mode showing numbers for every real measurement.
  // US-102: Sketch Focus also suppresses callouts, but ONLY here — this
  // function's three callers (render-annotations.js live canvas,
  // hit-testing.js live interaction, label-editor.js) are all live-canvas
  // concerns; labelsVisible() itself stays untouched by Sketch Focus because
  // it also gates exports (see the note on labelsVisible in style.js).
  function annotationShowsCallout(ann) {
    return labelsVisible() && isMeasurementAnnotation(ann) && !state.sketchMode;
  }

  // The MEASURED length, which is not the drawn length once the sketch has been
  // resized (US-091). Resizing a photo on the board scales the lines drawn on it
  // so they stay on the garment, and stamps the factor into ann.measureScale;
  // dividing it back out here keeps every measured value exactly what it was
  // before the resize. Every caller of lineLength is a measurement — the spec
  // panel, the tolerance check, the Set Scale dialog, the grading model and the
  // on-canvas label — so this is the one place it belongs. Drawing and
  // hit-testing use the raw geometry and never come through here.
  function lineLength(ann) {
    const drawn = ann.type === 'straight'
      ? distance(ann.start, ann.end)
      : polylineLength(getAnnotationPolyline(ann, BEZIER_SAMPLES * 2));
    const scale = ann.measureScale;
    return (Number.isFinite(scale) && scale > 0) ? drawn / scale : drawn;
  }

  // Map a callout label ("8", "1,2") to POM standard info. Joins descriptions for
  // multi-POM labels; returns a reference value only when a single POM is matched.
  function getPomInfo(labelText) {
    const text = String(labelText == null ? '' : labelText).trim();
    if (!text) return { desc: '', refL: null, zh: '' };
    const nums = text.split(/[,\s]+/).filter(Boolean);
    // Custom POMs (17+, US-011) resolve from the project registry with the
    // same shape as template entries; refL stays null (no standard value).
    const infoFor = (n) => {
      if (POM_TEMPLATE[n]) return POM_TEMPLATE[n];
      const custom = customPomEntry(n);
      return custom ? { desc: custom.en || '', zh: custom.zh || '', refL: null } : null;
    };
    const descs = [];
    const zhs = [];
    for (const n of nums) {
      const info = infoFor(n);
      if (info) {
        descs.push(info.desc);
        if (info.zh) zhs.push(info.zh);
      }
    }
    const single = nums.length === 1 ? infoFor(nums[0]) : null;
    return {
      desc: descs.join('; '),
      refL: single ? single.refL : null,
      zh: zhs.join('；'),
    };
  }

  function getAnnotationById(id) {
    const hit = state.annotations.find(a => a.id === id);
    if (hit) return hit;
    // Draft annotations live outside state.annotations but share the same id
    // space, so drag/handle interaction handlers can look them up too.
    const draft = state.autoMode.draftAnnotations.find(a => a.id === id);
    return draft || null;
  }

  function isAutoDraft(ann) {
    return !!(ann && ann.auto === true && ann.sourceMode === 'auto-mode' && ann.autoRunId);
  }

  // A draft the TD is expected to review before it counts as their own
  // geometry — editing one stamps `tdEdited` (markDraftTouchedByTD). Auto Mode
  // POM drafts are the only producer since Auto Detect Seam was removed
  // (ADR 0101); kept as its own predicate because every call site means "a
  // draft under review", not "an Auto Mode draft".
  function isTDReviewDraft(ann) {
    return isAutoDraft(ann);
  }

  function isReviewOnlyDraft(ann) {
    return !!(ann && ann.drawability === 'REVIEW_ONLY');
  }

  function createUniqueAnnotationId() {
    return state.idCounter++;
  }

  function getImageById(id) {
    return state.images.find(image => image.id === id) || null;
  }
