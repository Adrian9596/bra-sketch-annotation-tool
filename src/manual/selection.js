// Manual-mode selection model: what is currently picked on the board.
// Source part for app.js. Run `npm run build` after editing.
//
// setSelection is the single funnel for switching what is selected
// (annotation, image, or nothing) so the spec panel, tool defaults, and
// label editor stay in sync. The image and annotation multi-selection
// helpers (Cmd/Ctrl+click, Shift+click, marquee rect hit-testing,
// Cmd/Ctrl+A) derive their sets through the current primary selection.
// Pointer dispatch lives in pointer-events.js; keyboard routing in
// keyboard-shortcuts.js.

function setSelection(kind, id) {
    const nextAnn = kind === 'annotation' && id != null ? getAnnotationById(id) : null;
    const nextGroupId = nextAnn && nextAnn.templateGroupId ? nextAnn.templateGroupId : null;
    if (!nextGroupId || (state.templateGroupEditId && state.templateGroupEditId !== nextGroupId)) {
      state.templateGroupEditId = null;
    }
    state.selection = kind && id != null ? { kind, id } : { kind: null, id: null };
    // Keep the image + annotation multi-selections in lockstep: selecting one
    // (or anything else, or nothing) collapses the set. Shift+click / marquee
    // widen the annotation set through the helpers below.
    state.selectedImageIds = kind === 'image' && id != null ? [id] : [];
    state.selectedAnnotationIds = kind === 'annotation' && id != null
      ? (nextGroupId && state.templateGroupEditId !== nextGroupId
        ? state.annotations.filter(ann => ann.templateGroupId === nextGroupId).map(ann => ann.id)
        : [id])
      : [];
    if (kind !== 'graphic') state.graphicEdit = null;
    if (kind === 'annotation') {
      const ann = getAnnotationById(id);
      if (ann) {
        adoptDrawStyleFrom(ann);
        state.drawColor = normalizeColorKey(ann.color);
        state.arrowType = getArrowType(ann);
      }
    }
    // US-092: a selected note adopts the colour swatch the same way, so the
    // toolbar shows the note's own colour and a click on another swatch
    // retints THAT note instead of silently changing the draw default.
    // Style / arrow / width have no meaning for a note and stay untouched.
    if (kind === 'note') {
      const note = getNoteById(id);
      if (note) state.drawColor = normalizeColorKey(note.color);
    }
    if (kind === 'graphic') {
      const graphic = getBoardGraphicById(id);
      if (graphic) state.drawColor = normalizeColorKey(graphic.color);
    }
    updateUI();
    requestRender();
  }

  function enterTemplateGroupForAnnotation(id) {
    const ann = getAnnotationById(id);
    if (!ann || !ann.templateGroupId) return false;
    state.templateGroupEditId = ann.templateGroupId;
    setSelection('annotation', id);
    showToast('Editing Template member. Click outside the group to exit.');
    return true;
  }

  // The set of currently-selected image ids. Derived from state so a direct
  // `state.selection = {...}` assignment elsewhere (which bypasses
  // setSelection) can't leave a stale multi-selection: if the primary is not
  // an image the set is empty. A real multi-selection is ALWAYS built around
  // the current primary (setSelection / toggleImageInSelection keep it in the
  // set), so if the raw set does not contain the primary it is stale — a new
  // primary was assigned directly, e.g. when adding a photo — and we return
  // just the primary rather than silently widening the group to the
  // previously-selected photo (which made a plain drag move both). Only ids of
  // images that still exist are returned.
  function getSelectedImageIds() {
    if (state.selection.kind !== 'image' || state.selection.id == null) return [];
    const raw = Array.isArray(state.selectedImageIds) ? state.selectedImageIds : [];
    if (!raw.includes(state.selection.id)) {
      return getImageById(state.selection.id) ? [state.selection.id] : [];
    }
    return raw.filter((id) => !!getImageById(id));
  }

  function getSelectedImages() {
    return getSelectedImageIds().map((id) => getImageById(id)).filter(Boolean);
  }

  function isImageInSelection(id) {
    return getSelectedImageIds().includes(id);
  }

  // Cmd/Ctrl+click: add the image to the multi-selection, or remove it if it
  // was already selected. Manages state.selection + state.selectedImageIds
  // directly (NOT via setSelection, which would collapse the set to one).
  function toggleImageInSelection(id) {
    if (!getImageById(id)) return;
    const current = getSelectedImageIds();
    const had = current.includes(id);
    const next = had ? current.filter((x) => x !== id) : current.concat([id]);
    if (next.length === 0) {
      state.selectedImageIds = [];
      state.selection = { kind: null, id: null };
    } else {
      // Primary anchor: the just-clicked image when adding; when removing the
      // primary, fall back to the last still-selected image.
      const primary = had ? next[next.length - 1] : id;
      state.selectedImageIds = next;
      state.selection = { kind: 'image', id: primary };
    }
    if (state.autoMode) state.autoMode.anchorSelectedId = null;
    updateUI();
    requestRender();
  }

  // ---- Annotation (POM line) multi-selection: Shift+click + marquee ----
  // Same derive-through-primary contract as the image helpers: the set is empty
  // unless the primary selection is an annotation, and the primary is always
  // included; only ids of lines that still exist (and aren't hidden) count.
  function getSelectedAnnotationIds() {
    if (state.selection.kind !== 'annotation' || state.selection.id == null) return [];
    const raw = Array.isArray(state.selectedAnnotationIds) ? state.selectedAnnotationIds : [];
    // Same stale-set guard as getSelectedImageIds: a multi-selection only
    // counts when its raw set was built around the current primary. A direct
    // `state.selection = {...}` assignment (e.g. selecting a freshly drawn
    // line) leaves the previous set behind — ignore it instead of merging the
    // new primary into a group it never belonged to.
    if (!raw.includes(state.selection.id)) {
      return (getAnnotationById(state.selection.id) && !isAnnHidden(state.selection.id))
        ? [state.selection.id] : [];
    }
    return raw.filter((id) => !!getAnnotationById(id) && !isAnnHidden(id));
  }

  function getSelectedAnnotations() {
    return getSelectedAnnotationIds().map((id) => getAnnotationById(id)).filter(Boolean);
  }

  function isAnnInSelection(id) {
    return getSelectedAnnotationIds().includes(id);
  }

  // Adopt an annotation as the primary selection AND keep its draw defaults in
  // sync, mirroring setSelection('annotation', …) without collapsing the set.
  function setPrimaryAnnotation(id) {
    state.selection = { kind: 'annotation', id };
    const ann = getAnnotationById(id);
    if (ann) {
      adoptDrawStyleFrom(ann);
      state.drawColor = normalizeColorKey(ann.color);
      state.arrowType = getArrowType(ann);
    }
  }

  // US-096 / ADR 0055: selecting a line still hands its look to the draw
  // defaults, EXCEPT for the three stitch styles.
  //
  // state.drawStyle is what isStitchMode() reads, so adopting 'zigzag' from a
  // clicked line put the whole board into Stitch mode and blanked every callout
  // number — a board-wide change caused by nothing but a selection click. The
  // toolbar still shows the selected line's real style: updateUI reads it from
  // the annotation, not from this default (ui-status.js).
  function adoptDrawStyleFrom(ann) {
    if (!ann || !ann.style) return;
    if (isStitchStyle(ann.style)) return;
    state.drawStyle = ann.style;
  }

  // Shift+click: add the line to the multi-selection, or remove it if already in.
  function toggleAnnInSelection(id) {
    if (!getAnnotationById(id) || isAnnHidden(id)) return;
    const current = getSelectedAnnotationIds();
    const had = current.includes(id);
    const next = had ? current.filter((x) => x !== id) : current.concat([id]);
    if (next.length === 0) {
      state.selectedAnnotationIds = [];
      state.selection = { kind: null, id: null };
    } else {
      state.selectedAnnotationIds = next;
      setPrimaryAnnotation(had ? next[next.length - 1] : id);
    }
    updateUI();
    requestRender();
  }

  // Does a segment a→b touch the axis-aligned rect? Liang–Barsky clip: true iff
  // any part of the segment (incl. an endpoint inside) lies within the rect.
  function segmentTouchesRect(a, b, minX, minY, maxX, maxY) {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - minX, maxX - a.x, a.y - minY, maxY - a.y];
    for (let i = 0; i < 4; i += 1) {
      if (p[i] === 0) { if (q[i] < 0) return false; }
      else {
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
    }
    return t0 <= t1;
  }

  // A line is in the marquee only if its ACTUAL geometry passes through the box
  // — test the drawn polyline (curves sampled), NOT the padded export bbox, so a
  // small box over 3 lines doesn't grab every densely-packed POM around it.
  function annotationTouchesRect(ann, minX, minY, maxX, maxY) {
    const pts = getAnnotationPolyline(ann, BEZIER_SAMPLES);
    for (let i = 0; i < pts.length - 1; i += 1) {
      if (segmentTouchesRect(pts[i], pts[i + 1], minX, minY, maxX, maxY)) return true;
    }
    // A zero-length / single-point line still counts if that point is inside.
    if (pts.length === 1) {
      const p = pts[0];
      return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    }
    return false;
  }

  // Replace/extend the line selection with everything a marquee rectangle
  // touched. `additive` (Shift held) merges with the existing selection.
  // `keepSelection` (US-086) means the caller already adopted a selection when
  // the marquee started — a photo taken by its first press — so an empty result
  // must leave that alone instead of clearing it.
  function selectAnnotationsInRect(x1, y1, x2, y2, additive, keepSelection) {
    const loX = Math.min(x1, x2), hiX = Math.max(x1, x2);
    const loY = Math.min(y1, y2), hiY = Math.max(y1, y2);
    const hits = [];
    for (const ann of state.annotations) {
      if (isAnnHidden(ann.id)) continue;
      if (annotationTouchesRect(ann, loX, loY, hiX, hiY)) hits.push(ann.id);
    }
    let ids = hits;
    if (additive) ids = Array.from(new Set(getSelectedAnnotationIds().concat(hits)));
    if (!ids.length) {
      if (!additive && !keepSelection) {
        state.selection = { kind: null, id: null };
        state.selectedAnnotationIds = [];
      }
    } else {
      state.selectedAnnotationIds = ids;
      setPrimaryAnnotation(ids[ids.length - 1]);
    }
    updateUI();
    requestRender();
  }

  // Cmd/Ctrl+A — select everything on the board. The selection model is
  // single-kind (photos OR lines), so "all" resolves to the kind that acts on
  // the whole board: all PHOTOS by default — dragging any selected photo moves
  // the group WITH the POM lines sitting on each photo — or all LINES when a
  // line is already the primary selection (so line group ops: copy, reflect,
  // delete, nudge). Hidden lines and Auto Mode line ops stay excluded.
  function selectAllOnBoard() {
    const selectAllLines = () => {
      const ids = state.annotations.filter(a => !isAnnHidden(a.id)).map(a => a.id);
      if (!ids.length) return false;
      state.selectedAnnotationIds = ids;
      setPrimaryAnnotation(ids[ids.length - 1]);
      updateUI();
      requestRender();
      showToast(ids.length > 1 ? ids.length + ' lines selected.' : '1 line selected.');
      return true;
    };
    if (state.appMode !== 'auto' && state.selection.kind === 'annotation' && selectAllLines()) return;
    const imgIds = state.images.map(im => im.id);
    if (imgIds.length) {
      state.selectedImageIds = imgIds;
      state.selection = { kind: 'image', id: imgIds[imgIds.length - 1] };
      if (state.autoMode) state.autoMode.anchorSelectedId = null;
      updateUI();
      requestRender();
      showToast(imgIds.length > 1
        ? imgIds.length + ' photos selected — drag one to move all; lines move with their photo.'
        : '1 photo selected — drag to move it; its lines move with it.');
      return;
    }
    if (state.appMode !== 'auto') selectAllLines();
  }

  function clearSelection() {
    setSelection(null, null);
  }

  function getSelectedAnnotation() {
    return state.selection.kind === 'annotation'
      ? state.annotations.find(a => a.id === state.selection.id) || null
      : null;
  }

  // The set a style / preset / colour edit should act on.
  //
  // US-096 / ADR 0055 code review, 2026-08-23: getSelectedAnnotations() filters
  // hidden lines and getSelectedAnnotation() does not, and US-096 made the
  // PLURAL one the arbiter of "is anything selected?". A hidden line can still
  // be the primary selection — clicking a hidden POM's spec row calls
  // setSelection (spec-row-builders.js) — so the toolbar showed that line's
  // style as active while setLineStyle saw an empty selection and fell through
  // to setDefaultLineStyle, flipping the WHOLE board into Stitch mode and
  // blanking every callout number. Exactly the coupling ADR 0055 rule 4 forbids.
  //
  // Falling back to the primary keeps the toolbar's reading and the action's
  // target the same object, whatever its visibility.
  function getSelectedAnnotationsForEdit() {
    const many = getSelectedAnnotations();
    if (many.length) return many;
    const primary = getSelectedAnnotation();
    return primary ? [primary] : [];
  }

  // US-092. Notes have no multi-selection in v1 (the marquee stays lines-only),
  // so unlike images and annotations there is no id-set helper beside this one.
  function getSelectedNote() {
    return state.selection.kind === 'note' ? getNoteById(state.selection.id) : null;
  }

  function getSelectedImage() {
    return state.selection.kind === 'image'
      ? state.images.find(image => image.id === state.selection.id) || null
      : null;
  }

  function toggleSelectedImageLock() {
    const image = getSelectedImage();
    if (!image) {
      showToast('Select an image first.');
      return;
    }
    image.locked = !image.locked;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(image.locked
      ? 'Image locked. Lines and annotations are unaffected.'
      : 'Image unlocked.');
  }

  // If any image is unlocked, lock all; otherwise unlock all. Bound to the L
  // key for a single-tap lock/unlock of every photo on the board.
  function toggleAllImagesLock() {
    if (!state.images.length) {
      showToast('No images on the board.');
      return;
    }
    const anyUnlocked = state.images.some(img => !img.locked);
    state.images.forEach(img => { img.locked = anyUnlocked; });
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(anyUnlocked
      ? `Locked all ${state.images.length} image${state.images.length === 1 ? '' : 's'}.`
      : `Unlocked all ${state.images.length} image${state.images.length === 1 ? '' : 's'}.`);
  }
