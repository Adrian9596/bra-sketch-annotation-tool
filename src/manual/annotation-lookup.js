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
    if (ann && ann.text != null && String(ann.text).trim() !== '') return String(ann.text);
    return String(ann.seq);
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

  function isReviewOnlyDraft(ann) {
    return !!(ann && ann.drawability === 'REVIEW_ONLY');
  }

  function createUniqueAnnotationId() {
    return state.idCounter++;
  }

  function getImageById(id) {
    return state.images.find(image => image.id === id) || null;
  }
