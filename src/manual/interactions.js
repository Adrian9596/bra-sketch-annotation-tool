// Mouse/keyboard interactions, selection helpers, draw/drag/erase
// dispatch. Source part for app.js. Run `npm run build` after editing.
//
// onMouseDown/Move/Up own the canvas pointer state, including pan, draw,
// erase, anchor drag, image drag, and label drag. setSelection is the
// single funnel for switching what is selected (annotation, image, or
// nothing) so the spec panel, tool defaults, and label editor stay in
// sync. handleDrawToolClick implements the click-twice-to-draw flow,
// including the extension-line detection that splits a near-collinear
// follow-up click into its own POM annotation.

function setSelection(kind, id) {
    state.selection = kind && id != null ? { kind, id } : { kind: null, id: null };
    // Keep the image + annotation multi-selections in lockstep: selecting one
    // (or anything else, or nothing) collapses the set. Shift+click / marquee
    // widen the annotation set through the helpers below.
    state.selectedImageIds = kind === 'image' && id != null ? [id] : [];
    state.selectedAnnotationIds = kind === 'annotation' && id != null ? [id] : [];
    if (kind === 'annotation') {
      const ann = getAnnotationById(id);
      if (ann) {
        state.drawStyle = ann.style || state.drawStyle;
        state.drawColor = normalizeColorKey(ann.color);
        state.arrowType = getArrowType(ann);
      }
    }
    updateUI();
    requestRender();
  }

  // The set of currently-selected image ids. Derived from state so a direct
  // `state.selection = {...}` assignment elsewhere (which bypasses
  // setSelection) can't leave a stale multi-selection: if the primary is not
  // an image the set is empty, and the primary is always included. Only ids of
  // images that still exist are returned.
  function getSelectedImageIds() {
    if (state.selection.kind !== 'image' || state.selection.id == null) return [];
    const raw = Array.isArray(state.selectedImageIds) ? state.selectedImageIds : [];
    const ids = raw.slice();
    if (!ids.includes(state.selection.id)) ids.push(state.selection.id);
    return ids.filter((id) => !!getImageById(id));
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
    const ids = raw.slice();
    if (!ids.includes(state.selection.id)) ids.push(state.selection.id);
    return ids.filter((id) => !!getAnnotationById(id) && !isAnnHidden(id));
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
      state.drawStyle = ann.style || state.drawStyle;
      state.drawColor = normalizeColorKey(ann.color);
      state.arrowType = getArrowType(ann);
    }
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
  function selectAnnotationsInRect(x1, y1, x2, y2, additive) {
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
      if (!additive) { state.selection = { kind: null, id: null }; state.selectedAnnotationIds = []; }
    } else {
      state.selectedAnnotationIds = ids;
      setPrimaryAnnotation(ids[ids.length - 1]);
    }
    updateUI();
    requestRender();
  }

  function clearSelection() {
    setSelection(null, null);
  }

  function getSelectedAnnotation() {
    return state.selection.kind === 'annotation'
      ? state.annotations.find(a => a.id === state.selection.id) || null
      : null;
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

  function onMouseDown(e) {
    // Commit any pending keyboard nudge burst first, so the drag that starts
    // now takes its before-fingerprint AFTER the nudge is in history.
    flushLineNudgeSession();
    const isPanButton = state.spacePan || e.button === 1 || e.button === 2;
    if (isPanButton) {
      startPanInteraction(e);
      return;
    }
    if (e.button !== 0) return;

    const screen = getMousePos(e);
    const world = screenToWorld(screen.x, screen.y);

    // Auto Mode: only drafts + anchors are interactive. Project annotations
    // are locked, and tool creation / erasing is disabled (see updateUI).
    if (state.appMode === 'auto') {
      // Anchors always win: a TD must be able to grab a wrong anchor even
      // if a draft line crosses through it.
      const anchorHit = hitTestAnchors(world);
      if (anchorHit) {
        state.autoMode.anchorSelectedId = anchorHit.id;
        // Clear any draft selection so the spec panel stops highlighting it.
        if (state.selection.kind === 'draft') {
          state.selection = { kind: null, id: null };
        }
        startAnchorDrag(anchorHit.id, world);
        updateUI();
        requestRender();
        return;
      }

      const selectedDraft = getSelectedDraft();
      const draftHandleHit = selectedDraft && !isReviewOnlyDraft(selectedDraft)
        ? hitTestSelectedHandles(world, selectedDraft) : null;
      if (draftHandleHit) {
        startHandleDrag(selectedDraft.id, draftHandleHit.part, world);
        return;
      }
      const draftHit = hitTestAutoDraftAnnotations(world);
      if (draftHit) {
        setSelection('draft', draftHit.id);
        if (draftHit.part === 'label') {
          startLabelDrag(draftHit.id, world);
        } else {
          startAnnotationDrag(draftHit.id, world);
        }
        return;
      }
      // Images are movable in Auto Mode too. Anchors are normalized to the
      // source image (anchorWorldPos), so a moved or resized photo carries its
      // anchors and drafts with it — nothing desyncs. Anchors + drafts still win
      // the click; only bare image (or its resize corner) starts an image drag.
      const selImageAuto = getSelectedImage();
      // Resize handles are only offered for a single selected image — a group
      // selection is for moving together, not resizing.
      const imageHandleHitAuto = selImageAuto && !selImageAuto.locked && getSelectedImageIds().length <= 1
        ? hitTestSelectedImageHandles(world, selImageAuto) : null;
      if (imageHandleHitAuto) {
        startImageResize(selImageAuto.id, imageHandleHitAuto.corner);
        return;
      }
      const imageHitAuto = hitTestImages(world);
      if (imageHitAuto) {
        state.autoMode.anchorSelectedId = null;
        // Cmd/Ctrl+click toggles this photo in the multi-selection (no drag).
        if (e.metaKey || e.ctrlKey) {
          toggleImageInSelection(imageHitAuto.id);
          return;
        }
        // A plain click on a photo that is already part of a multi-selection
        // keeps the group so the drag moves them all; otherwise it selects
        // just this one.
        if (!(getSelectedImageIds().length > 1 && isImageInSelection(imageHitAuto.id))) {
          setSelection('image', imageHitAuto.id);
        }
        const hitImageAuto = getImageById(imageHitAuto.id);
        if (hitImageAuto && !hitImageAuto.locked) startImageDrag(imageHitAuto.id, world);
        updateUI();
        requestRender();
        return;
      }
      // Empty space — drop any current selection (draft or anchor).
      if (state.selection.kind === 'draft' || state.autoMode.anchorSelectedId != null) {
        state.autoMode.anchorSelectedId = null;
        if (state.selection.kind === 'draft') {
          state.selection = { kind: null, id: null };
        }
        updateUI();
        requestRender();
      }
      return;
    }

    if (state.tool === 'straight' || state.tool === 'curved') {
      handleDrawToolClick(world);
      return;
    }

    if (state.tool === 'eraser') {
      beginEraseStroke(world);
      return;
    }

    const selectedAnnotation = getSelectedAnnotation();
    // Endpoint/handle editing is a single-line action — a multi-selection is
    // for moving/copying the group, so skip handles when more than one is picked.
    const handleHit = selectedAnnotation && getSelectedAnnotationIds().length <= 1
      ? hitTestSelectedHandles(world, selectedAnnotation) : null;
    if (handleHit) {
      startHandleDrag(selectedAnnotation.id, handleHit.part, world);
      return;
    }

    const selectedImage = getSelectedImage();
    const imageHandleHit = selectedImage && !selectedImage.locked && getSelectedImageIds().length <= 1
      ? hitTestSelectedImageHandles(world, selectedImage) : null;
    if (imageHandleHit) {
      startImageResize(selectedImage.id, imageHandleHit.corner);
      return;
    }

    // Cmd/Ctrl+click on a photo toggles it in the multi-selection before the
    // annotation hit-test, so the modifier is dedicated to picking photos.
    if ((e.metaKey || e.ctrlKey)) {
      const modImageHit = hitTestImages(world);
      if (modImageHit) {
        toggleImageInSelection(modImageHit.id);
        return;
      }
    }

    const annotationHit = hitTestAnnotations(world);
    if (annotationHit) {
      // Shift+click toggles the line in the multi-selection (no drag).
      if (e.shiftKey) {
        toggleAnnInSelection(annotationHit.id);
        return;
      }
      // Plain click on a line already part of a multi-selection keeps the group
      // so the drag moves them all; otherwise it selects just this line.
      if (!(getSelectedAnnotationIds().length > 1 && isAnnInSelection(annotationHit.id))) {
        setSelection('annotation', annotationHit.id);
      }
      if (annotationHit.part === 'label') {
        startLabelDrag(annotationHit.id, world);
      } else {
        startAnnotationDrag(annotationHit.id, world);
      }
      return;
    }

    const imageHit = hitTestImages(world);
    if (imageHit) {
      // Keep an existing multi-selection when clicking one of its members so the
      // drag moves the whole group; otherwise select just this photo.
      if (!(getSelectedImageIds().length > 1 && isImageInSelection(imageHit.id))) {
        setSelection('image', imageHit.id);
      }
      const hitImage = getImageById(imageHit.id);
      if (hitImage && !hitImage.locked) {
        startImageDrag(imageHit.id, world);
      }
      return;
    }

    // Empty canvas (select tool): start a marquee to rubber-band select lines.
    // A plain click (no drag past a small threshold) clears the selection on
    // mouseup; Shift adds the marquee's hits to the current selection.
    startMarquee(world, e.shiftKey);
  }

  function onMouseMove(e) {
    const screen = getMousePos(e);
    const world = screenToWorld(screen.x, screen.y);

    if (state.drawSession) {
      state.drawSession.current = world;
      requestRender();
    }

    if (state.eraseSession) {
      appendErasePoint(world);
    }

    const interaction = state.interaction;
    if (!interaction) return;

    if (interaction.type === 'pan') {
      const dx = screen.x - interaction.startScreen.x;
      const dy = screen.y - interaction.startScreen.y;
      state.panX = interaction.startPan.x + dx;
      state.panY = interaction.startPan.y + dy;
      updateUI();
      requestRender();
      return;
    }

    if (interaction.type === 'drag-annotation') {
      const ids = interaction.groupIds || [interaction.id];
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        for (const aid of ids) {
          const a = getAnnotationById(aid);
          if (!a) continue;
          moveAnnotation(a, dx, dy);
          if (isAutoDraft(a)) markDraftTouchedByTD(a);
        }
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'marquee') {
      interaction.currentWorld = { x: world.x, y: world.y };
      const dx = interaction.currentWorld.x - interaction.startWorld.x;
      const dy = interaction.currentWorld.y - interaction.startWorld.y;
      // A tiny wobble is still a click; only past a few screen px is it a drag.
      if (Math.abs(dx) > 3 / state.zoom || Math.abs(dy) > 3 / state.zoom) interaction.moved = true;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-label') {
      const ann = getAnnotationById(interaction.id);
      if (!ann || !ann.label) return;
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        ann.label.x += dx;
        ann.label.y += dy;
        ann.labelManual = true;
        if (isAutoDraft(ann) && state.appMode === 'auto') markDraftTouchedByTD(ann);
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'drag-handle') {
      const ann = getAnnotationById(interaction.id);
      if (!ann) return;
      dragHandle(ann, interaction.part, world, interaction.prevWorld);
      if (isAutoDraft(ann)) markDraftTouchedByTD(ann);
      interaction.changed = true;
      interaction.prevWorld = world;
      refreshMeasuredValueForAnnotation(ann.id); // US-028: live Value cell
      requestRender();
      return;
    }

    if (interaction.type === 'drag-image') {
      const imageIds = interaction.imageIds || [interaction.id];
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        for (const imgId of imageIds) {
          const image = getImageById(imgId);
          if (image) { image.x += dx; image.y += dy; }
        }
        if (interaction.groupedAnnotationIds) {
          for (const annId of interaction.groupedAnnotationIds) {
            const ann = getAnnotationById(annId);
            if (ann) moveAnnotation(ann, dx, dy);
          }
        }
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'drag-image-resize') {
      const image = getImageById(interaction.id);
      if (!image) return;
      resizeImageFromCorner(image, interaction.corner, interaction.anchor, interaction.aspect, world);
      interaction.changed = true;
      interaction.prevWorld = world;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-anchor') {
      const anchor = getAnchorById(interaction.id);
      if (!anchor) return;
      const image = getImageById(anchor.sourceImageId);
      if (!image || !image.width || !image.height) return;
      // Convert world delta into the source image's normalized space; the
      // pin/cascade/draft-sync side effects live in moveAnchorBy, shared
      // with the keyboard nudge and snap-to-ink paths.
      const dx = (world.x - interaction.prevWorld.x) / image.width;
      const dy = (world.y - interaction.prevWorld.y) / image.height;
      if (dx || dy) {
        interaction.prevWorld = world;
        if (moveAnchorBy(anchor, dx, dy)) interaction.changed = true;
      }
    }
  }

  function onMouseUp(e) {
    if (state.eraseSession) {
      commitEraseStroke();
    }

    const interaction = state.interaction;
    if (!interaction) return;

    document.body.classList.remove('grabbing');

    if (interaction.type === 'marquee') {
      if (interaction.moved) {
        selectAnnotationsInRect(
          interaction.startWorld.x, interaction.startWorld.y,
          interaction.currentWorld.x, interaction.currentWorld.y,
          interaction.additive
        );
      } else if (!interaction.additive && state.selection.kind != null) {
        // Plain click on empty canvas = clear selection.
        clearSelection();
      }
      state.interaction = null;
      requestRender();
      return;
    }

    if (interaction.type !== 'pan' && interaction.changed) {
      if (interaction.type === 'drag-anchor') {
        const anchor = getAnchorById(interaction.id);
        // U2: pull the released anchor onto the nearest sketch ink, unless
        // the TD holds ⌥ to place it freely. Snap BEFORE the residual
        // capture below so the learning loop sees the final position.
        if (anchor && !(e && e.altKey)) {
          const snapped = snapAnchorToInk(anchor);
          if (snapped && moveAnchorBy(anchor, snapped.x - anchor.x, snapped.y - anchor.y)) {
            maybeToastSnapHint();
          }
        }
        // Learning-loop capture: log the (origin → final) anchor residual
        // exactly once per drag commit. We do this here, not on every
        // mousemove, so micro-jitter and aborted drags never reach the
        // bucket. recordAnchorResidual self-filters sub-1px deltas.
        // Gated on interaction.changed, NOT on the snapshot fingerprint:
        // anchors are not part of history snapshots, so a pure anchor drag
        // never changes the fingerprint and the old gate silently dropped
        // every residual and anchor_dragged event.
        if (interaction.learnOrigin) {
          if (anchor && anchor.kind === interaction.learnOrigin.kind) {
            recordAnchorResidual(
              anchor.kind,
              anchor.x - interaction.learnOrigin.x,
              anchor.y - interaction.learnOrigin.y,
              anchor
            );
            recordAutoTelemetryEvent('anchor_dragged', {
              sourceImageId: anchor.sourceImageId,
              anchor_id: anchor.id,
              anchor_kind: anchor.kind,
            });
          }
        }
      }
      const before = interaction.beforeFingerprint;
      const after = snapshotFingerprint(makeSnapshot());
      if (before !== after) {
        const changedAnn = interaction.id != null ? getAnnotationById(interaction.id) : null;
        pushHistoryIfChanged();
        if (state.appMode === 'manual'
            && changedAnn
            && isAutoDraft(changedAnn)
            && (interaction.type === 'drag-annotation' || interaction.type === 'drag-handle')) {
          const evalResult = evaluateManualPomSample(changedAnn, { allowAuto: true });
          if (evalResult.status === 'recorded') {
            showToast('POM ' + evalResult.pom + ' learning sample saved from TD edit.');
            updateUI();
          }
        }
      }
    }

    state.interaction = null;
    requestRender(); // drop gesture-scoped visuals (US-029 readout)
  }

// ---- US-036: touch layer -----------------------------------------------
// Touch (and pen) input arrives as pointer events and routes into the SAME
// mouse handlers, so every gesture rule (selection, drag semantics, one
// history commit per gesture) is shared, not duplicated. Mouse pointers are
// filtered out — the existing mouse listeners keep handling them — and
// preventDefault() on pointerdown suppresses the browser's compatibility
// mouse events so nothing double-fires. Two fingers open a pinch session:
// zoom scales with finger distance, pan keeps the world point that was
// under the finger midpoint pinned to it (same math as zoomAtScreenPoint).
const touchPoints = new Map(); // pointerId -> {x, y} client coords
let touchPinch = null;         // { d0, zoom0, world0 }
let touchTapCandidate = null;  // current finger: { t, x, y, moved }
let lastTouchTap = null;       // last COMPLETED clean tap: { t, x, y }

function onTouchPointerDown(e) {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Synthetic PointerEvents (tests) carry no real pointer id to capture.
  try { el.canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  if (touchPoints.size === 2) {
    // Second finger: this is a pinch, never a tap — kill tap tracking so a
    // pinch started near a recent tap can't trigger an accidental fit.
    touchTapCandidate = null;
    lastTouchTap = null;
    // Commit any in-flight one-finger drag first so the pinch never
    // smears into the drag's history entry.
    if (state.interaction || state.eraseSession) onMouseUp(e);
    beginTouchPinch();
    return;
  }
  if (touchPoints.size === 1) {
    touchTapCandidate = { t: performance.now(), x: e.clientX, y: e.clientY, moved: false };
    onMouseDown(e);
  }
}

function onTouchPointerMove(e) {
  if (e.pointerType === 'mouse' || !touchPoints.has(e.pointerId)) return;
  e.preventDefault();
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchPinch) {
    updateTouchPinch();
    return;
  }
  if (touchTapCandidate
      && Math.hypot(e.clientX - touchTapCandidate.x, e.clientY - touchTapCandidate.y) > 8) {
    touchTapCandidate.moved = true; // it's a drag, not a tap
  }
  onMouseMove(e);
}

function onTouchPointerEnd(e) {
  if (e.pointerType === 'mouse' || !touchPoints.has(e.pointerId)) return;
  touchPoints.delete(e.pointerId);
  if (touchPinch) {
    // Pinch over: a remaining finger starts nothing new until lifted —
    // that avoids a surprise drag from wherever the leftover finger sits.
    if (touchPoints.size < 2) touchPinch = null;
    return;
  }
  onMouseUp(e);
  // Double-tap = fit (parity with double-click / F): decided on the UP of a
  // clean tap (quick, unmoved, never joined by a second finger), so pinches
  // and drags can never fire it. touch-action:none means the browser won't
  // synthesize dblclick for us.
  const now = performance.now();
  const tap = touchTapCandidate;
  touchTapCandidate = null;
  if (!tap || tap.moved || now - tap.t > 400) { lastTouchTap = null; return; }
  if (lastTouchTap && now - lastTouchTap.t < 350
      && Math.hypot(tap.x - lastTouchTap.x, tap.y - lastTouchTap.y) < 20
      && state.tool === 'select') {
    lastTouchTap = null;
    onDoubleClick(e);
    return;
  }
  lastTouchTap = { t: now, x: tap.x, y: tap.y };
}

function touchMidAndDist() {
  const rect = el.canvas.getBoundingClientRect();
  const pts = [...touchPoints.values()];
  return {
    mid: {
      x: (pts[0].x + pts[1].x) / 2 - rect.left,
      y: (pts[0].y + pts[1].y) / 2 - rect.top,
    },
    dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
  };
}

function beginTouchPinch() {
  const { mid, dist } = touchMidAndDist();
  touchPinch = {
    d0: Math.max(1, dist),
    zoom0: state.zoom,
    world0: screenToWorld(mid.x, mid.y),
  };
}

function updateTouchPinch() {
  if (touchPoints.size < 2) return;
  const { mid, dist } = touchMidAndDist();
  const nextZoom = clamp(touchPinch.zoom0 * (dist / touchPinch.d0), MIN_ZOOM, MAX_ZOOM);
  state.zoom = nextZoom;
  state.panX = mid.x - touchPinch.world0.x * nextZoom;
  state.panY = mid.y - touchPinch.world0.y * nextZoom;
  updateUI();
  requestRender();
}

function onWheel(e) {
  e.preventDefault();

  if (e.shiftKey) {
    state.panX -= normalizeWheelDelta(e) * 0.45;
    updateUI();
    requestRender();
    return;
  }

  const mouse = getMousePos(e);
  const sensitivity = e.altKey ? PRECISE_ZOOM_SENSITIVITY : ZOOM_SENSITIVITY;
  const factor = Math.exp(-normalizeWheelDelta(e) * sensitivity);
  zoomAtScreenPoint(state.zoom * factor, mouse.x, mouse.y);
}

  function onKeyDown(e) {
    const target = e.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);


    // A modal (Help, Set Scale, PPTX picker) is open — let it own the keyboard.
    if (document.querySelector('.picker-overlay')) {
      return;
    }
    const isMeta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    // Undo / redo work everywhere, INCLUDING while a spec-panel field
    // (Size L / TOL / 中文 / description) is focused. Blur first so any
    // pending edit commits to history, then it is undone as a single step.
    if (isMeta && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      flushLineNudgeSession();
      void undo();
      return;
    }
    if (isMeta && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      flushLineNudgeSession();
      void redo();
      return;
    }

    // Save / Open the project (⌘/Ctrl+S, ⌘/Ctrl+O) — mirror the toolbar
    // buttons; work in both modes and from a focused field (commit it first).
    // preventDefault suppresses the browser's Save-page / Open-file dialogs.
    if (isMeta && key === 's') {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      el.saveProjectBtn.click();
      return;
    }
    if (isMeta && key === 'o') {
      e.preventDefault();
      if (inField && typeof target.blur === 'function') target.blur();
      el.openProjectBtn.click();
      return;
    }

    // Everything below is a canvas-level shortcut — ignore while typing.
    if (inField) return;

    // U1: arrow keys nudge the selected Auto-Mode anchor by one source-image
    // pixel (Shift = 10) — the precise landing tool after a rough drag.
    // Handled before the letter shortcuts so a selected pin owns the arrows;
    // with no pin selected they fall through untouched.
    if (!isMeta && state.appMode === 'auto' && state.autoMode.anchorSelectedId != null
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = e.shiftKey ? 10 : 1;
      const dxPx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dyPx = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudgeSelectedAnchor(dxPx, dyPx)) {
        e.preventDefault();
        return;
      }
    }

    // US-027: in Manual Mode the arrows nudge the selected line — or just its
    // active point (Tab cycles it) — by one source-image pixel (Shift = 10).
    // Moving an endpoint is how a TD changes the measured value precisely.
    if (!isMeta && state.appMode !== 'auto' && state.selection.kind === 'annotation'
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = e.shiftKey ? 10 : 1;
      const dxPx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dyPx = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (nudgeSelectedAnnotation(dxPx, dyPx)) {
        e.preventDefault();
        return;
      }
    }

    // US-027: Tab picks which point the arrows move — whole line → start →
    // (mid point on curves) → end. Shift+Tab cycles backwards. Only fires
    // with a line selected, so field-to-field tabbing keeps working.
    if (!isMeta && e.key === 'Tab' && state.appMode !== 'auto' && state.selection.kind === 'annotation') {
      const ann = getSelectedAnnotation();
      if (ann) {
        e.preventDefault();
        cycleNudgePart(ann, e.shiftKey ? -1 : 1);
        return;
      }
    }

    // Auto-Mode step shortcuts mirror the "1 Detect · 2 Generate · 3 Review"
    // flow chips: 1 = Detect, 2 = Generate Drafts, 3 = Apply Lines. Clicking the
    // button (rather than calling the handler) respects its disabled + hidden
    // (recovery-only) state, so a step can't fire before it's available.
    if (!isMeta && state.appMode === 'auto' && (key === '1' || key === '2' || key === '3')) {
      const btn = key === '1' ? el.autoDetectBtn : key === '2' ? el.autoGenerateBtn : el.autoApplyBtn;
      if (btn && !btn.disabled && btn.offsetParent !== null) {
        e.preventDefault();
        btn.click();
        return;
      }
    }

    if (e.code === 'Space' && !state.spacePan) {
      state.spacePan = true;
      document.body.classList.add('space-pan');
      e.preventDefault();
    }

    // Cmd/Ctrl+Shift+C — copy the whole board as a PNG image. Checked
    // before the plain Cmd/Ctrl+C copy-line branch so the Shift chord never
    // falls through to it. Manual-only, matching the Copy Image button.
    if (isMeta && e.shiftKey && key === 'c' && state.appMode !== 'auto') {
      e.preventDefault();
      void copyBoardImageToClipboard();
      return;
    }

    // Copy/paste/reflect for the selected line. Cmd/Ctrl-V intercept also
    // suppresses the paste event for image data — acceptable since the
    // user just explicitly asked to paste a line.
    if (isMeta && key === 'c' && state.selection.kind === 'annotation' && state.appMode !== 'auto') {
      e.preventDefault();
      copySelectedAnnotation();
      return;
    }
    if (isMeta && key === 'v' && hasLineClipboard() && state.appMode !== 'auto') {
      e.preventDefault();
      pasteLineFromClipboard();
      return;
    }
    if (!isMeta && key === 'm' && state.selection.kind === 'annotation' && state.appMode !== 'auto') {
      e.preventDefault();
      reflectSelectedAnnotation();
      return;
    }

    if ((isMeta && key === '0') || (!isMeta && key === 'f')) {
      e.preventDefault();
      fitSelectionOrAll();
      return;
    }

    if (!isMeta && key === 's') {
      e.preventDefault();
      setTool('select');
      return;
    }

    // H shows/hides the Measurements side panel (same as the toolbar button).
    if (!isMeta && key === 'h') {
      e.preventDefault();
      toggleSpecPanel();
      return;
    }

    // A opens the Add Image file picker (same as the toolbar button).
    if (!isMeta && key === 'a') {
      e.preventDefault();
      el.imageFileInput.click();
      return;
    }

    // G opens the Grading dialog (same as the toolbar button).
    if (!isMeta && key === 'g') {
      e.preventDefault();
      openGradingDialog();
      return;
    }

    // L locks/unlocks every photo at once — works in both modes since
    // locking is purely an image-state concern.
    if (!isMeta && key === 'l') {
      e.preventDefault();
      toggleAllImagesLock();
      return;
    }

    // Board-level clears — both work in Auto Mode (this is an auto-only
    // build) and are one history step, so Undo restores what they remove.
    //   R — reset the whole working board (photo + lines + drafts). Same as
    //       the Reset Board button; it keeps its own confirm dialog.
    //   D — delete every POM line (applied + drafts) but keep the photo, so
    //       the TD can re-Generate on the same sketch.
    if (!isMeta && key === 'r') {
      e.preventDefault();
      resetWorkingBoard();
      return;
    }
    if (!isMeta && key === 'd') {
      e.preventDefault();
      clearAllLinesKeepImage();
      return;
    }

    // In Auto Mode, manual creation/eraser shortcuts must not steal the
    // tool away from select. The project annotations are locked.
    if (state.appMode !== 'auto') {
      if (!isMeta && key === '0') {
        e.preventDefault();
        setTool('straight');
        return;
      }

      if (!isMeta && (key === 'b' || key === 'c')) {
        e.preventDefault();
        setTool('curved');
        return;
      }

      // Eraser moved E → X (TD request 2026-07-10: E now exports Excel).
      if (!isMeta && key === 'x' && state.images.length > 0) {
        e.preventDefault();
        setTool('eraser');
        return;
      }
    }

    // E exports the Excel measurement spec (same as the toolbar button;
    // opens the size picker first). Manual-only, matching the button's
    // manual-only class and the Cmd/Ctrl+Shift+C copy-image precedent.
    if (!isMeta && key === 'e' && state.appMode !== 'auto') {
      e.preventDefault();
      void exportSpecXlsx();
      return;
    }

    // P exports the PDF, I imports a PPTX — mirror the manual-only toolbar
    // buttons (parity with E = Export Excel). Click the button so behavior
    // (dialogs, disabled state) matches exactly.
    if (!isMeta && key === 'p' && state.appMode !== 'auto') {
      e.preventDefault();
      el.exportPdfBtn.click();
      return;
    }
    if (!isMeta && key === 'i' && state.appMode !== 'auto') {
      e.preventDefault();
      el.importPptxBtn.click();
      return;
    }

    if (!isMeta && key === 'n') {
      e.preventDefault();
      toggleLabels();
      return;
    }

    if (!isMeta && state.tool === 'eraser' && (key === '[' || key === ']')) {
      e.preventDefault();
      const factor = key === ']' ? 1.18 : 1 / 1.18;
      state.brushSize = Math.max(4, Math.min(200, Math.round(state.brushSize * factor)));
      showToast('Brush size: ' + state.brushSize + ' px', { replace: true });
      updateUI();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.kind != null) {
      // In Auto Mode, project annotations/drafts are locked from Delete (use
      // Discard Drafts or Mark Review-Only). Deleting an added PHOTO is allowed
      // (US-052) — otherwise the only way to remove a photo is Reset Board.
      if (state.appMode === 'auto' && state.selection.kind !== 'image') return;
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === 'Escape') {
      if (!el.stitchesMenu.hidden) {
        closeLineStyleMenu();
      } else if (state.drawSession) {
        state.drawSession = null;
        state.tool = 'select';
        showToast('Drawing canceled.');
        updateUI();
        requestRender();
      } else if (state.eraseSession) {
        state.eraseSession = null;
        showToast('Erase canceled.');
        updateUI();
        requestRender();
      } else if (state.tool === 'straight' || state.tool === 'curved' || state.tool === 'eraser') {
        setTool('select');
      } else if (state.selection.kind === 'annotation' && state.selection.part) {
        // First Escape drops back to whole-line nudging; the next one
        // clears the selection itself.
        state.selection.part = null;
        updateUI();
        requestRender();
      } else if (state.selection.kind != null) {
        clearSelection();
      }
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      state.spacePan = false;
      document.body.classList.remove('space-pan');
      document.body.classList.remove('grabbing');
    }
  }

  function startPanInteraction(e) {
    const startScreen = getMousePos(e);
    state.interaction = {
      type: 'pan',
      startScreen,
      startPan: { x: state.panX, y: state.panY },
      changed: false,
    };
    document.body.classList.add('grabbing');
  }

function beginTrackedInteraction(type, payload) {
  state.interaction = {
    type,
    changed: false,
    beforeFingerprint: snapshotFingerprint(makeSnapshot()),
    ...payload,
  };
}

function startAnnotationDrag(id, world) {
  // Move every selected line together (Shift+click / marquee group), or just
  // this one when it isn't part of a multi-selection.
  const selected = getSelectedAnnotationIds();
  const groupIds = (selected.length > 1 && selected.includes(id)) ? selected.slice() : [id];
  beginTrackedInteraction('drag-annotation', { id, prevWorld: world, groupIds });
}

function startMarquee(world, additive) {
  beginTrackedInteraction('marquee', {
    startWorld: { x: world.x, y: world.y },
    currentWorld: { x: world.x, y: world.y },
    additive: !!additive,
    moved: false,
  });
}

function startLabelDrag(id, world) {
  beginTrackedInteraction('drag-label', { id, prevWorld: world });
}

function startHandleDrag(id, part, world) {
  // Keep the keyboard nudge aimed at the handle the TD last grabbed, so a
  // rough drag can be finished with arrow keys without pressing Tab.
  if (part !== 'label' && state.selection.kind === 'annotation' && state.selection.id === id) {
    state.selection.part = part;
  }
  beginTrackedInteraction('drag-handle', { id, part, prevWorld: world });
}

function startImageDrag(id, world) {
  // Move every selected image together (Cmd/Ctrl+click multi-selection), or
  // just the clicked one when nothing else is selected. Locked images never
  // move. Each moving image carries the POM lines that sit on it; the combined
  // set is de-duplicated so a line is never nudged twice.
  const selected = getSelectedImageIds();
  const movingIds = (selected.length > 1 ? selected : [id])
    .filter((imgId) => { const im = getImageById(imgId); return im && !im.locked; });
  if (!movingIds.includes(id)) movingIds.push(id);
  const annIdSet = new Set();
  for (const imgId of movingIds) {
    const im = getImageById(imgId);
    if (!im) continue;
    for (const ann of getAnnotationsOnImage(im)) annIdSet.add(ann.id);
  }
  beginTrackedInteraction('drag-image', {
    id,
    prevWorld: world,
    imageIds: movingIds,
    groupedAnnotationIds: Array.from(annIdSet),
  });
}

function startImageResize(id, corner) {
  const image = getImageById(id);
  if (!image) return;
  beginTrackedInteraction('drag-image-resize', {
    id,
    corner,
    anchor: getOppositeImageCorner(image, corner),
    aspect: image.width / Math.max(1, image.height),
  });
}

  // ---- Eraser ----
  // Strokes live in image-local pixel coordinates so they automatically follow
  // their parent image when it is moved or resized. Rendering clips to the
  // image rect so strokes never bleed onto the white canvas background.
  function beginEraseStroke(world) {
    const imageHit = hitTestImages(world);
    if (!imageHit) return;
    const image = getImageById(imageHit.id);
    if (!image || !image.img) return;
    const local = worldToImageLocal(image, world);
    // brushSize is user-facing world pixels; convert to image-local px so the
    // stroke visually keeps that width regardless of the image's natural
    // resolution, and also scales correctly if the image is resized later.
    const naturalW = image.img.naturalWidth || image.width;
    const localSize = state.brushSize * (naturalW / image.width);
    state.eraseSession = {
      imageId: image.id,
      size: localSize,
      points: [local],
    };
    updateUI();
    requestRender();
  }

  function appendErasePoint(world) {
    const session = state.eraseSession;
    if (!session) return;
    const image = getImageById(session.imageId);
    if (!image || !image.img) return;
    const local = worldToImageLocal(image, world);
    const last = session.points[session.points.length - 1];
    const dx = local.x - last.x;
    const dy = local.y - last.y;
    // 2px (image-local) threshold trims jitter without losing curve fidelity
    if (dx * dx + dy * dy < 4) return;
    session.points.push(local);
    requestRender();
  }

  function commitEraseStroke() {
    const session = state.eraseSession;
    state.eraseSession = null;
    if (!session || !session.points.length) {
      updateUI();
      requestRender();
      return;
    }
    state.eraseStrokes.push({
      id: state.idCounter++,
      imageId: session.imageId,
      size: session.size,
      points: session.points,
    });
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function worldToImageLocal(image, world) {
    const naturalW = image.img.naturalWidth || image.width;
    const naturalH = image.img.naturalHeight || image.height;
    return {
      x: (world.x - image.x) * (naturalW / image.width),
      y: (world.y - image.y) * (naturalH / image.height),
    };
  }

  function handleDrawToolClick(world) {
    // Extension follow-up: a straight line was just committed and the tool is
    // offering an optional collinear dashed extension. A click within the axis
    // snap zone commits it as its own annotation (separate seq number); a click
    // off-axis falls through and starts a fresh straight line at this point.
    if (state.drawSession && state.drawSession.type === 'extension-followup') {
      const proj = projectionOnAxis(world, state.drawSession.prevEnd, state.drawSession.prevDir);
      if (proj.qualifies) {
        const tip = {
          x: state.drawSession.prevEnd.x + state.drawSession.prevDir.x * proj.distance,
          y: state.drawSession.prevEnd.y + state.drawSession.prevDir.y * proj.distance,
        };
        const ann = createStraightAnnotation(
          state.drawSession.prevEnd,
          tip,
          'dashed',
          state.drawSession.color,
          'single',
          state.drawSession.lineWidth,
        );
        state.annotations.push(ann);
        state.selection = { kind: 'annotation', id: ann.id };
        state.nextSequence += 1;
        state.drawSession = null;
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return;
      }
      // Off-axis click — drop follow-up and treat as start of a new line.
      state.drawSession = null;
    }

    if (!state.drawSession) {
      state.drawSession = {
        type: state.tool,
        style: state.drawStyle,
        color: state.drawColor,
        arrowType: state.arrowType,
        lineWidth: state.lineWidth,
        start: world,
        current: world,
      };
      updateUI();
      requestRender();
      return;
    }

    // Curved lines take THREE clicks: start, middle, end. The middle click
    // records the point the curve must pass through; the curve is committed on
    // the third click. (Straight lines stay two clicks.)
    if (state.drawSession.type === 'curved') {
      const sess = state.drawSession;
      if (sess.mid == null) {
        if (distance(sess.start, world) < (4 / state.zoom)) return;
        sess.mid = clonePoint(world);
        sess.current = clonePoint(world);
        updateUI();
        requestRender();
        return;
      }
      if (distance(sess.mid, world) < (4 / state.zoom)) return;
      const curveAnn = createCurvedAnnotation(sess.start, world, sess.style, sess.color, sess.arrowType, sess.lineWidth, sess.mid);
      state.annotations.push(curveAnn);
      state.selection = { kind: 'annotation', id: curveAnn.id };
      state.nextSequence += 1;
      state.drawSession = null;
      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }

    const start = state.drawSession.start;
    const end = world;
    const drawSettings = state.drawSession;
    if (distance(start, end) < (4 / state.zoom)) {
      return;
    }

    if (state.tool === 'straight') {
      const ann = createStraightAnnotation(start, end, drawSettings.style, drawSettings.color, drawSettings.arrowType, drawSettings.lineWidth);
      state.annotations.push(ann);
      state.selection = { kind: 'annotation', id: ann.id };
      state.nextSequence += 1;

      // Stay armed for an optional collinear dashed extension. The next click
      // along the line's axis commits a separate annotation with its own seq;
      // a click off-axis (or Esc / tool change) drops this state and starts a
      // fresh line. Only armed for solid lines in measurement (POM) mode —
      // not when drawing stitch styles where dashed has a different meaning.
      if (!isStitchMode() && drawSettings.style === 'solid') {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.max(0.0001, Math.hypot(dx, dy));
        state.drawSession = {
          type: 'extension-followup',
          color: drawSettings.color,
          lineWidth: drawSettings.lineWidth,
          prevEnd: clonePoint(end),
          prevDir: { x: dx / len, y: dy / len },
          current: clonePoint(end),
        };
      } else {
        state.drawSession = null;
      }

      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }
  }

  // Project `world` onto the axis defined by `origin` + `dir` (unit vector).
  // Returns the signed forward distance, the perpendicular distance, and a
  // boolean that's true iff the cursor is in the extension snap zone
  // (positive forward distance, perpendicular within tolerance).
  function projectionOnAxis(world, origin, dir) {
    const dx = world.x - origin.x;
    const dy = world.y - origin.y;
    const distance = dx * dir.x + dy * dir.y;
    const perpX = dx - distance * dir.x;
    const perpY = dy - distance * dir.y;
    const perp = Math.hypot(perpX, perpY);
    const minDist = 4 / state.zoom;
    const maxPerp = 30 / state.zoom;
    return { distance, perp, qualifies: distance > minDist && perp <= maxPerp };
  }


  function dragHandle(ann, part, world, prevWorld) {
    const dx = world.x - prevWorld.x;
    const dy = world.y - prevWorld.y;

    const moveBy = (p) => { if (p) { p.x += dx; p.y += dy; } };

    if (part === 'start') {
      ann.start = clonePoint(world);
      // An anchor carries its own handle(s) rigidly, like a pen tool, so the
      // curve near it keeps its shape while the anchor moves.
      moveBy(ann.control1);
    } else if (part === 'end') {
      ann.end = clonePoint(world);
      moveBy(ann.control2);
    } else if (part === 'midPoint' && ann.type === 'curved') {
      // The middle is a real anchor now: move it and BOTH its handles together
      // so the whole joint slides and the two segments follow.
      ann.midPoint = clonePoint(world);
      moveBy(ann.midHandleIn);
      moveBy(ann.midHandleOut);
    } else if (part === 'control1' && ann.type === 'curved' && ann.control1) {
      ann.control1 = clonePoint(world); // start handle — bends segment 1 only
    } else if (part === 'control2' && ann.type === 'curved' && ann.control2) {
      ann.control2 = clonePoint(world); // end handle — bends segment 2 only
    } else if (part === 'midHandleIn' && ann.type === 'curved' && ann.midHandleIn) {
      ann.midHandleIn = clonePoint(world); // middle handle toward the start
    } else if (part === 'midHandleOut' && ann.type === 'curved' && ann.midHandleOut) {
      ann.midHandleOut = clonePoint(world); // middle handle toward the end
    }

    if (!ann.labelManual) {
      ann.label = computeDefaultLabelPosition(ann);
    }
  }

  // ---- US-027: arrow-key nudge for Manual-Mode lines ------------------------
  // Mirrors the Auto-Mode anchor nudge: arrows move one source-image pixel
  // (Shift = 10), and rapid keystrokes form one "nudge session" that pushes a
  // single history entry LINE_NUDGE_COMMIT_MS after the last keystroke — the
  // same one-commit-per-drag contract the mouse path follows. Tab cycles the
  // active part; with no part active the whole line moves.
  const LINE_NUDGE_COMMIT_MS = 700;
  let lineNudgeSession = null; // { annId, timer }

  // Ring order: the main points first (the common Tab targets), then the
  // bend handles (US-030) in geometric order start-side → end-side. Only
  // parts the annotation actually has are included, so single-segment
  // curves and straight lines get shorter rings automatically.
  function lineNudgeParts(ann) {
    const parts = [null, 'start'];
    if (ann.type === 'curved') {
      if (ann.midPoint) parts.push('midPoint');
      parts.push('end');
      if (ann.control1) parts.push('control1');
      if (ann.midHandleIn) parts.push('midHandleIn');
      if (ann.midHandleOut) parts.push('midHandleOut');
      if (ann.control2) parts.push('control2');
    } else {
      parts.push('end');
    }
    return parts;
  }

  function nudgePartLabel(part) {
    if (part === 'start') return 'start point';
    if (part === 'midPoint') return 'mid point';
    if (part === 'end') return 'end point';
    if (part === 'control1') return 'start bend handle';
    if (part === 'control2') return 'end bend handle';
    if (part === 'midHandleIn') return 'mid bend handle (start side)';
    if (part === 'midHandleOut') return 'mid bend handle (end side)';
    return 'whole line';
  }

  function cycleNudgePart(ann, dir) {
    const parts = lineNudgeParts(ann);
    const idx = parts.indexOf(state.selection.part || null);
    const next = parts[(idx + dir + parts.length) % parts.length];
    state.selection.part = next;
    // Live status — latest wins; queueing stale part names after a Tab
    // burst would mislead (US-032).
    showToast('Arrows move the ' + nudgePartLabel(next) + '.', { replace: true });
    updateUI();
    requestRender();
  }

  // World-units-per-source-pixel for the image under the line's midpoint —
  // the same association rule as getAnnotationsOnImage. Off-image lines fall
  // back to one screen pixel so the nudge always does something visible.
  function lineNudgeWorldStep(ann) {
    const mid = { x: (ann.start.x + ann.end.x) / 2, y: (ann.start.y + ann.end.y) / 2 };
    const hit = hitTestImages(mid);
    const image = hit ? getImageById(hit.id) : null;
    if (image && image.img && image.img.naturalWidth && image.width) {
      return image.width / image.img.naturalWidth;
    }
    return 1 / state.zoom;
  }

  function nudgeSelectedAnnotation(dxPx, dyPx) {
    const ann = getSelectedAnnotation();
    if (!ann) return false;
    const stepWorld = lineNudgeWorldStep(ann);
    const dx = dxPx * stepWorld;
    const dy = dyPx * stepWorld;
    if (lineNudgeSession && lineNudgeSession.annId !== ann.id) {
      flushLineNudgeSession();
    }
    if (!lineNudgeSession) {
      lineNudgeSession = { annId: ann.id, timer: null };
    }
    const part = state.selection.part;
    const point = part === 'start' ? ann.start
      : part === 'end' ? ann.end
        : part ? ann[part] : null;
    if (part && point) {
      // Route through dragHandle so curve semantics (endpoint carrying its
      // control, mid point carrying both mid handles) match a mouse drag.
      const prev = clonePoint(point);
      dragHandle(ann, part, { x: prev.x + dx, y: prev.y + dy }, prev);
    } else {
      moveAnnotation(ann, dx, dy);
    }
    if (isAutoDraft(ann)) markDraftTouchedByTD(ann);
    if (lineNudgeSession.timer) clearTimeout(lineNudgeSession.timer);
    lineNudgeSession.timer = setTimeout(flushLineNudgeSession, LINE_NUDGE_COMMIT_MS);
    refreshMeasuredValueForAnnotation(ann.id); // US-028: live Value cell
    requestRender();
    return true;
  }

  // Lets the renderer show the adjustment readout (US-029) while a nudge
  // burst is still open, without reaching into the session object.
  function isLineNudgeActive(annId) {
    return !!(lineNudgeSession && lineNudgeSession.annId === annId);
  }

  function flushLineNudgeSession() {
    const session = lineNudgeSession;
    lineNudgeSession = null;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    const ann = getAnnotationById(session.annId);
    pushHistoryIfChanged();
    requestRender(); // drop the on-canvas readout now that the burst committed
    // Same learning capture as a committed mouse drag on an applied draft.
    if (state.appMode === 'manual' && ann && isAutoDraft(ann)) {
      const evalResult = evaluateManualPomSample(ann, { allowAuto: true });
      if (evalResult.status === 'recorded') {
        showToast('POM ' + evalResult.pom + ' learning sample saved from TD edit.');
        updateUI();
      }
    }
  }

  function moveAnnotation(ann, dx, dy) {
    ann.start.x += dx; ann.start.y += dy;
    ann.end.x += dx; ann.end.y += dy;
    for (const key of ['midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      if (ann[key]) { ann[key].x += dx; ann[key].y += dy; }
    }
    ann.label.x += dx; ann.label.y += dy;
  }
