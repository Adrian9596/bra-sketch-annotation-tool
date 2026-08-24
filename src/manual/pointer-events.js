// Manual-mode canvas pointer state machine: mouse down/move/up dispatch,
// the drag-session starters, and the per-frame drag geometry.
// Source part for app.js. Run `npm run build` after editing.
//
// onMouseDown/Move/Up own the canvas pointer state, including pan, draw,
// erase, anchor drag, image drag, and label drag. The start* helpers open a
// tracked interaction for each gesture; dragHandle/moveAnnotation are the
// shared per-frame geometry, also used by the keyboard nudge in
// line-nudge.js. Selection state lives in selection.js; the tool state
// machines (eraser, click-to-draw) in canvas-tools.js; touch/pen input
// routes into these same handlers from touch-input.js.

  function onMouseDown(e) {
    // Commit any pending keyboard nudge burst first, so the drag that starts
    // now takes its before-fingerprint AFTER the nudge is in history.
    flushLineNudgeSession();
    // US-086: pin the canvas rect for this whole gesture before anything below
    // can call updateUI() and reflow the toolbar under the cursor.
    state.gestureCanvasRect = el.canvas.getBoundingClientRect();
    const isPanButton = state.spacePan || e.button === 1 || e.button === 2;
    if (isPanButton) {
      startPanInteraction(e);
      return;
    }
    if (e.button !== 0) return;

    // US-092: a press on the board while the note editor is open FINISHES that
    // note and does nothing else. The blur listener cannot own this by itself —
    // a focus change is the DEFAULT ACTION of mousedown, so blur arrives after
    // this handler, and letting the same press also place the next note would
    // have that late blur commit the new, empty session and close the editor
    // the TD had just opened. Click-away-to-finish costs one extra click to
    // place a second note and is worth it for a deterministic editor.
    if (isNoteEditorOpen()) {
      commitNoteEditor();
      return;
    }

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
      // A 2+ image group resizes from ONE set of handles on its bounding box; a
      // single selection keeps its own corner handles.
      if (startGroupResizeIfHandleHit(world)) return;
      const imageHandleHitAuto = selImageAuto && !selImageAuto.locked && getSelectedImageIds().length <= 1
        ? hitTestSelectedImageHandles(world, selImageAuto) : null;
      if (imageHandleHitAuto) {
        startImageResize(selImageAuto.id, imageHandleHitAuto.corner, world);
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

    // US-093: a persistent mode like every other tool. Only ever acts on the
    // curve that was already selected when the mode was entered — a click
    // elsewhere (or one that misses that curve) does nothing, per the TD's
    // own scoping in the ADR 0053 grilling session.
    if (state.tool === 'add-point') {
      handleAddPointClick(world);
      return;
    }

    // US-092: the Text tool places a note where it is clicked. Like the drawing
    // tools it STAYS active afterwards, so a run of remarks needs no trip back
    // to the toolbar; S or Escape returns to Select.
    if (state.tool === 'text') {
      openNoteEditorForNewNote(world);
      return;
    }

    // US-097 / ADR 0056: place a saved shape. Same interaction shape as
    // draw-graphic below — press, drag the box, release — because it is the
    // same gesture and the preview/commit plumbing is already proven.
    if (state.tool === 'stamp') {
      const stamp = getActiveShapeStamp();
      if (!stamp) {
        showToast('Pick a saved shape from Tools first.');
        setTool('select');
        return;
      }
      beginTrackedInteraction('draw-stamp', {
        stampId: stamp.id, startWorld: clonePoint(world), currentWorld: clonePoint(world),
        shiftKey: !!e.shiftKey, altKey: !!e.altKey,
      });
      return;
    }

    if (state.tool === 'rectangle' || state.tool === 'circle' || state.tool === 'hexagon') {
      beginTrackedInteraction('draw-graphic', {
        kind: state.tool, startWorld: bgClonePoint(world), currentWorld: bgClonePoint(world),
        shiftKey: !!e.shiftKey, altKey: !!e.altKey,
      });
      return;
    }

    // US-095: path-edit handles are precise targets on the already-selected
    // graphic and therefore win over line/photo body hits below.
    const selectedGraphic = getSelectedBoardGraphic();
    if (selectedGraphic && state.graphicEdit && state.graphicEdit.graphicId === selectedGraphic.id) {
      const editHit = hitTestGraphicEdit(world, selectedGraphic);
      if (editHit) {
        state.graphicEdit.active = editHit;
        if (editHit.kind === 'node' || editHit.kind === 'handleIn' || editHit.kind === 'handleOut') {
          beginTrackedInteraction('drag-graphic-part', { id:selectedGraphic.id, hit:editHit, startWorld:bgClonePoint(world), prevWorld:bgClonePoint(world), armed:false });
        } else { updateUI(); requestRender(); }
        return;
      }
    }

    if (selectedGraphic && !state.graphicEdit) {
      const resizeHit = bgHitResizeHandle(world, selectedGraphic);
      if (resizeHit) {
        const bounds = bgBounds(selectedGraphic);
        beginTrackedInteraction('drag-graphic-resize', {
          id:selectedGraphic.id, corner:resizeHit.name, startWorld:bgClonePoint(world), armed:false,
          startBounds:clone(bounds), origin:bgOppositeCorner(bounds, resizeHit.name), startGraphic:clone(selectedGraphic),
        });
        return;
      }
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

    // US-092 step 6: the selected note's leader tips and its leader-add handle
    // hold exactly the privilege the selected LINE's handles hold above — small,
    // deliberate targets on the thing the TD is already working on, so they beat
    // the endpoint test further down. No modifier guard, matching
    // hitTestSelectedHandles: Shift and Cmd build LINE and PHOTO groups, and a
    // press this precise on the selected note is not a group-building gesture.
    const selectedNoteForHandles = getSelectedNote();
    const noteHandleHit = selectedNoteForHandles
      ? hitTestSelectedNoteHandles(world, selectedNoteForHandles) : null;
    if (noteHandleHit) {
      if (noteHandleHit.part === 'leader-add') {
        startNoteLeaderCreate(selectedNoteForHandles.id, world);
      } else {
        startNoteLeaderDrag(selectedNoteForHandles.id, noteHandleHit.index, world);
      }
      return;
    }

    const selectedImage = getSelectedImage();
    if (startGroupResizeIfHandleHit(world)) return;
    const imageHandleHit = selectedImage && !selectedImage.locked && getSelectedImageIds().length <= 1
      ? hitTestSelectedImageHandles(world, selectedImage) : null;
    if (imageHandleHit) {
      startImageResize(selectedImage.id, imageHandleHit.corner, world);
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

    // US-086: any visible line's endpoint is grabbable on the FIRST press, not
    // just the selected line's (hitTestSelectedHandles above). Runs BEFORE the
    // line-body test so pressing an end means "move this end", never "move the
    // whole line". Excluded when a line multi-selection is live — that group is
    // for moving/copying, and endpoint editing stays a single-line action, the
    // same rule hitTestSelectedHandles is gated on. Shift and Cmd/Ctrl are
    // excluded too: they are reserved for building line and photo selections.
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && getSelectedAnnotationIds().length <= 1) {
      const endpointHit = hitTestAnyEndpoint(world);
      if (endpointHit) {
        setSelection('annotation', endpointHit.id);
        startHandleDrag(endpointHit.id, endpointHit.part, world);
        return;
      }
    }

    // US-092: a note box sits between the endpoints above and the line BODY
    // below. It loses to any endpoint because lines are the work (ADR 0050) and
    // an endpoint is the most precise target on the board. It beats the line
    // body because a note is an opaque filled box: the line under it is not
    // visible, so a press there cannot have meant that line — the same reason
    // hitTestAnnotations already skips hidden lines. And it must beat the photo,
    // or a note written on the sketch could never be picked up again.
    //
    // Shift is excluded: it belongs to the line multi-selection, and taking the
    // press here would call setSelection('note', …) and wipe the group the TD is
    // assembling — the same trap the Shift+miss marquee below was added for.
    if (!e.shiftKey) {
      const noteHit = hitTestNotes(world);
      if (noteHit) {
        setSelection('note', noteHit.id);
        startNoteDrag(noteHit.id, world);
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

    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const graphicHit = hitTestBoardGraphics(world);
      if (graphicHit) {
        setSelection('graphic', graphicHit.id);
        beginTrackedInteraction('drag-graphic', { id:graphicHit.id, startWorld:bgClonePoint(world), prevWorld:bgClonePoint(world), armed:false });
        return;
      }
    }

    // Shift is dedicated to building a line multi-selection. A Shift+click that
    // misses every line must NOT fall through to the image branch below, which
    // would call setSelection('image', …) and wipe the group the TD is
    // assembling (a near-miss of a thin line on a dense sketch is easy). Route
    // to an ADDITIVE marquee instead: a Shift+drag then rubber-bands more lines
    // in, and a plain Shift+click on empty space / the sketch commits nothing
    // and leaves the current selection intact (see the marquee branch in
    // onMouseUp: additive + not-moved = no clear).
    if (e.shiftKey) {
      startMarquee(world, true);
      return;
    }

    const imageHit = hitTestImages(world);
    if (imageHit) {
      const hitImage = getImageById(imageHit.id);
      // US-086: during correction the sketch is the BACKDROP, so a bare press on
      // it must not move it. The photo is a full-bounding-box drag target
      // sitting behind every POM line, and the only thing protecting it was the
      // ~8 screen px catch ribbon around each 2.5px line — measured, 14 of 18
      // presses just 12px off a line slid the whole sketch (and every line
      // riding on it). Moving a photo now takes an explicit second press: the
      // first selects it and reveals its resize handles, the next one drags.
      // An already-selected photo drags on the first press, so the group drag
      // from Cmd/Ctrl+click and Cmd+A is unchanged.
      // …and even then, not when the press sits in the near-miss band around a
      // line. Selection alone was not enough: the press that selects the photo
      // leaves it selected, so without this the very next mis-aim slid the
      // sketch again.
      if (hitImage && !hitImage.locked && isImageInSelection(imageHit.id)
          && !isPointNearAnyAnnotation(world, 16)) {
        startImageDrag(imageHit.id, world);
        return;
      }
      // First press: adopt the photo, then fall through to a marquee so a DRAG
      // rubber-bands the lines sitting on it — nearly always what the TD meant —
      // while a plain click just selects the photo. keepSelection stops the
      // marquee's empty-result path from dropping that selection again. A locked
      // photo takes this path too: it must stay selectable or the toolbar Lock
      // button could never unlock it.
      setSelection('image', imageHit.id);
      startMarquee(world, false, true);
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

    if (interaction.type === 'draw-stamp') {
      interaction.currentWorld = clonePoint(world);
      interaction.shiftKey = !!e.shiftKey; interaction.altKey = !!e.altKey;
      requestRender(); return;
    }

    if (interaction.type === 'draw-graphic') {
      interaction.currentWorld = bgClonePoint(world);
      interaction.shiftKey = !!e.shiftKey; interaction.altKey = !!e.altKey;
      requestRender(); return;
    }

    if (interaction.type === 'drag-graphic') {
      if (!dragArmed(interaction, world)) return;
      const graphic=getBoardGraphicById(interaction.id); if (!graphic) return;
      const dx=world.x-interaction.prevWorld.x, dy=world.y-interaction.prevWorld.y;
      if (dx||dy) { bgMove(graphic,dx,dy); interaction.prevWorld=bgClonePoint(world); interaction.changed=true; requestRender(); }
      return;
    }

    if (interaction.type === 'drag-graphic-part') {
      if (!dragArmed(interaction, world)) return;
      const graphic=getBoardGraphicById(interaction.id); if (!graphic) return;
      if (bgMoveEditPart(graphic,interaction.hit,world)) { interaction.changed=true; interaction.prevWorld=bgClonePoint(world); requestRender(); }
      return;
    }

    if (interaction.type === 'drag-graphic-resize') {
      if (!dragArmed(interaction, world)) return;
      const graphic=getBoardGraphicById(interaction.id); if (!graphic) return;
      bgResizeFromCorner(graphic,interaction,world,!!e.shiftKey,!!e.altKey); interaction.changed=true; requestRender(); return;
    }

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
      if (!dragArmed(interaction, world)) return;
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

    // US-092 step 6: moving an arrow's tip, or pulling a brand-new one out of
    // the note. One branch, because after the first armed frame the two are the
    // same gesture — the only difference is that the "new" flavour has no
    // leader to move until it arms.
    if (interaction.type === 'drag-note-leader' || interaction.type === 'drag-note-leader-new') {
      const note = getNoteById(interaction.id);
      if (!note) return;
      if (!dragArmed(interaction, world)) return;
      if (interaction.index < 0) {
        // Created on the ARMING frame, not on the press: a stray click on the
        // add handle must leave no zero-length arrow (and no history entry)
        // behind, and an arrow pointing at its own note means nothing.
        note.leaders = note.leaders || [];
        note.leaders.push({ x: world.x, y: world.y });
        interaction.index = note.leaders.length - 1;
      }
      const tip = (note.leaders || [])[interaction.index];
      if (!tip) return;
      // Same grab offset the line endpoints use (US-086): the catch radius is
      // deliberately generous, so without it a tip caught from 10px away
      // teleports to the cursor on the first move — and the arrow is a pointer
      // at a detail, so where it lands is the whole content of the gesture.
      const off = interaction.grabOffset || { x: 0, y: 0 };
      tip.x = world.x + off.x;
      tip.y = world.y + off.y;
      interaction.changed = true;
      requestRender();
      return;
    }

    // US-092. Armed like every other geometry drag: the press that SELECTS a
    // note must not also shift it by a pixel of hand jitter.
    if (interaction.type === 'drag-note') {
      const note = getNoteById(interaction.id);
      if (!note) return;
      if (!dragArmed(interaction, world)) return;
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        // moveNote carries the leaders too, so the whole callout travels as one.
        moveNote(note, dx, dy);
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
      if (!dragArmed(interaction, world)) return;
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
      // Target in handle space: the cursor plus the offset captured at grab
      // time, so the handle keeps its distance from the pointer (see
      // startHandleDrag). prevWorld lives in the same space.
      const off = interaction.grabOffset || { x: 0, y: 0 };
      const target = { x: world.x + off.x, y: world.y + off.y };
      if (!dragArmed(interaction, world)) return;
      dragHandle(ann, interaction.part, target, interaction.prevWorld, e.altKey);
      if (isAutoDraft(ann)) markDraftTouchedByTD(ann);
      interaction.changed = true;
      interaction.prevWorld = target;
      refreshMeasuredValueForAnnotation(ann.id); // US-028: live Value cell
      requestRender();
      return;
    }

    if (interaction.type === 'drag-image') {
      if (!dragArmed(interaction, world)) return;
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
        if (interaction.groupedNoteIds) {
          for (const noteId of interaction.groupedNoteIds) {
            const note = getNoteById(noteId);
            if (note) moveNote(note, dx, dy);
          }
        }
        if (interaction.groupedGraphicIds) for (const graphicId of interaction.groupedGraphicIds) {
          const graphic = getBoardGraphicById(graphicId); if (graphic) bgMove(graphic, dx, dy);
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
      if (!dragArmed(interaction, world)) return;
      resizeImageFromCorner(image, interaction.corner, interaction.anchor, interaction.aspect, world);
      interaction.changed = true;
      interaction.prevWorld = world;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-images-resize') {
      if (!dragArmed(interaction, world)) return;
      resizeImagesFromCorner(interaction, world);
      interaction.changed = true;
      interaction.prevWorld = world;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-anchor') {
      const anchor = getAnchorById(interaction.id);
      if (!anchor) return;
      if (!dragArmed(interaction, world)) return;
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
    // Release the gesture-pinned rect (US-086) on EVERY path out of here,
    // including the early return below when no interaction was open.
    state.gestureCanvasRect = null;
    if (state.eraseSession) {
      commitEraseStroke();
    }

    const interaction = state.interaction;
    if (!interaction) return;

    document.body.classList.remove('grabbing');

    if (interaction.type === 'draw-stamp') {
      const stamp = getShapeStampById(interaction.stampId);
      state.interaction = null;
      const placed = placeShapeStamp(stamp, interaction.startWorld, interaction.currentWorld,
        interaction.shiftKey, interaction.altKey);
      // Stay armed: placing the same shape on the front and back views is the
      // common case, and re-picking it from the menu each time is friction.
      // Escape or another tool disarms, exactly like the drawing tools.
      if (placed) showToast(`Placed "${stamp.name}". Esc to stop stamping.`);
      updateUI(); requestRender(); return;
    }

    if (interaction.type === 'draw-graphic') {
      const graphic = createBoardGraphicFromDrag(interaction.kind, interaction.startWorld, interaction.currentWorld, interaction.shiftKey, interaction.altKey);
      state.interaction = null;
      if (graphic) {
        state.graphics.push(graphic); setSelection('graphic', graphic.id); pushHistoryIfChanged();
      }
      updateUI(); requestRender(); return;
    }

    if (interaction.type === 'marquee') {
      if (interaction.moved) {
        selectAnnotationsInRect(
          interaction.startWorld.x, interaction.startWorld.y,
          interaction.currentWorld.x, interaction.currentWorld.y,
          interaction.additive, interaction.keepSelection
        );
      } else if (!interaction.additive && !interaction.keepSelection && state.selection.kind != null) {
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
        //
        // The panel is also refreshed HERE, unconditionally. moveAnchorBy
        // re-syncs the drafts (anchor-drag-sync.js) and that can drop a draft's
        // tdApproved and change its drawability / confidence — all of which the
        // spec panel and the Apply button render, and none of which used to
        // repaint: the canvas showed the corrected line while the row still read
        // "Approved" until the TD happened to click something else. Anchors and
        // drafts are part of the history snapshot now, so pushHistoryIfChanged
        // below normally covers this too; the direct call stays because it does
        // not depend on the fingerprint gate that swallowed the refresh in the
        // first place. Once per commit, never per mousemove — updateUI rebuilds
        // the whole spec table, against a re-sync deliberately kept at
        // 0.05-0.08 ms.
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
      if (interaction.type === 'drag-anchor') updateUI();
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

// US-086: a press that barely moves is a CLICK, not a drag. Before this, any
// selecting press nudged its target by a pixel or two of hand jitter — enough to
// push a history entry and change a measured value on a tool whose whole job is
// measurement. The marquee already worked this way (its own `moved` flag); this
// extends the same 3px grace to the gestures that mutate geometry. prevWorld is
// re-based at the moment of arming, so the drag starts from where the pointer
// actually is with no jump.
// prevWorld is deliberately NOT re-based when the gesture arms. Re-basing was
// the first attempt and it is wrong twice over: the target ends up permanently
// ~3px behind the cursor for the rest of the drag, and on the arming frame of a
// drag-handle it makes dx zero, so the endpoint snaps to the cursor while the
// curve control handle rigidly coupled to it stays behind and quietly reshapes
// the curve. Leaving prevWorld at the press point means the first armed frame
// applies the whole accumulated travel: one small catch-up jump, then 1:1.
//
// Returning true when startWorld is absent is a deliberate fail-open, so a drag
// type that has not opted in still works rather than freezing.
function dragArmed(interaction, world) {
  if (interaction.armed) return true;
  if (!interaction.startWorld) return true;
  const dx = (world.x - interaction.startWorld.x) * state.zoom;
  const dy = (world.y - interaction.startWorld.y) * state.zoom;
  if (Math.hypot(dx, dy) <= 3) return false;
  interaction.armed = true;
  return true;
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
  beginTrackedInteraction('drag-annotation', {
    id, prevWorld: world, groupIds,
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
}

// keepSelection (US-086): the marquee was started ON something already adopted
// as the selection — today only a photo taken by its first press. Without it the
// "no lines rubber-banded" path would clear the very selection that press made,
// so clicking a photo would select and immediately deselect it.
function startMarquee(world, additive, keepSelection) {
  beginTrackedInteraction('marquee', {
    startWorld: { x: world.x, y: world.y },
    currentWorld: { x: world.x, y: world.y },
    additive: !!additive,
    keepSelection: !!keepSelection,
    moved: false,
  });
}

function startLabelDrag(id, world) {
  // Armed like the other geometry drags: a stray pixel here also sets
  // labelManual, which permanently opts the callout out of auto layout.
  beginTrackedInteraction('drag-label', {
    id, prevWorld: world,
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
}

function startHandleDrag(id, part, world) {
  // Keep the keyboard nudge aimed at the handle the TD last grabbed, so a
  // rough drag can be finished with arrow keys without pressing Tab.
  if (part !== 'label' && state.selection.kind === 'annotation' && state.selection.id === id) {
    state.selection.part = part;
  }
  // US-086: remember how far the press landed from the handle itself. dragHandle
  // SNAPS the handle to the point it is given (pen-tool behaviour, deliberate),
  // so without this an endpoint caught from up to 10px away would teleport to
  // the cursor on the first mousemove — silently changing a measurement. Both
  // the target and prevWorld carry the same constant offset, so the control-
  // handle deltas computed inside dragHandle are unaffected.
  const ann = getAnnotationById(id);
  const anchorPt = ann ? getAnnPartPoint(ann, part) : null;
  const grabOffset = (anchorPt && Number.isFinite(anchorPt.x) && Number.isFinite(anchorPt.y))
    ? { x: anchorPt.x - world.x, y: anchorPt.y - world.y }
    : { x: 0, y: 0 };
  beginTrackedInteraction('drag-handle', {
    id, part, grabOffset,
    prevWorld: { x: world.x + grabOffset.x, y: world.y + grabOffset.y },
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
}

// US-092. No group set: notes have no multi-selection in v1, so exactly one
// note moves. History is handled by the generic changed -> fingerprint path in
// onMouseUp, which already sees notes because makeSnapshot captures them.
function startNoteDrag(id, world) {
  beginTrackedInteraction('drag-note', {
    id, prevWorld: world,
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
}

// US-092 step 6. The grab offset is captured against the tip's CURRENT position
// so a catch from up to 11px away drags 1:1 instead of snapping the arrow to
// the cursor. prevWorld carries the same offset, matching startHandleDrag.
function startNoteLeaderDrag(id, index, world) {
  const note = getNoteById(id);
  const tip = note && (note.leaders || [])[index];
  const grabOffset = (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y))
    ? { x: tip.x - world.x, y: tip.y - world.y }
    : { x: 0, y: 0 };
  beginTrackedInteraction('drag-note-leader', {
    id, index, grabOffset,
    prevWorld: { x: world.x + grabOffset.x, y: world.y + grabOffset.y },
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
}

// index -1 means "no leader yet" — the move handler creates it on the frame the
// drag arms. No grab offset: a new arrow starts exactly under the cursor.
function startNoteLeaderCreate(id, world) {
  beginTrackedInteraction('drag-note-leader-new', {
    id, index: -1,
    prevWorld: { x: world.x, y: world.y },
    startWorld: { x: world.x, y: world.y }, armed: false,
  });
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
  const noteIdSet = new Set();
  const graphicIdSet = new Set();
  for (const imgId of movingIds) {
    const im = getImageById(imgId);
    if (!im) continue;
    for (const ann of getAnnotationsOnImage(im)) annIdSet.add(ann.id);
    // US-092: and the text notes written on it — a remark whose arrow points at
    // a detail has to keep pointing at it.
    for (const note of getNotesOnImage(im)) noteIdSet.add(note.id);
    for (const graphic of bgOwnedByImage(im.id)) graphicIdSet.add(graphic.id);
  }
  beginTrackedInteraction('drag-image', {
    id,
    prevWorld: world,
    startWorld: { x: world.x, y: world.y },
    armed: false,
    imageIds: movingIds,
    groupedAnnotationIds: Array.from(annIdSet),
    groupedNoteIds: Array.from(noteIdSet),
    groupedGraphicIds: Array.from(graphicIdSet),
  });
}

function startImageResize(id, corner, world) {
  const image = getImageById(id);
  if (!image) return;
  beginTrackedInteraction('drag-image-resize', {
    id,
    corner,
    // US-086: resize is a geometry mutation like any other, so it arms too.
    startWorld: world ? { x: world.x, y: world.y } : null,
    armed: false,
    anchor: getOppositeImageCorner(image, corner),
    aspect: image.width / Math.max(1, image.height),
  });
}

// Group resize: 2+ selected photos scale together about the opposite corner of the
// GROUP's bounding box, so their relative sizes and spacing are preserved. Returns
// true when it claimed the click. A locked image in the selection blocks it (same
// rule as single-image resize). Anchors/drafts/erase strokes are stored normalized
// to their own image, so they follow each photo without extra work.
function startGroupResizeIfHandleHit(world) {
  const images = getSelectedImages();
  if (!images || images.length <= 1) return false;
  if (images.some(im => im.locked)) return false;
  const box = getImagesGroupBox(images);
  if (!box) return false;
  const hit = hitTestSelectedImageHandles(world, box);
  if (!hit) return false;
  beginTrackedInteraction('drag-images-resize', {
    corner: hit.corner,
    startWorld: { x: world.x, y: world.y },
    armed: false,
    anchor: getOppositeImageCorner(box, hit.corner),
    box,
    // Snapshot every member up front: scaling must be computed from the ORIGINAL
    // geometry each frame, or repeated relative scaling compounds and drifts.
    start: images.map(im => ({ id: im.id, x: im.x, y: im.y, width: im.width, height: im.height })),
  });
  return true;
}

// Uniform scale factor from the group's anchor corner to the cursor. Driven by the
// dominant axis so a diagonal drag feels like the single-image resize, and floored
// so no member can collapse below the 48px minimum used for one image.
function resizeImagesFromCorner(interaction, world) {
  const { anchor, box, start } = interaction;
  if (!anchor || !box || !Array.isArray(start) || !start.length) return;
  const spanX = Math.abs(box.x + (box.x + box.width) - 2 * anchor.x) || box.width;
  const spanY = Math.abs(box.y + (box.y + box.height) - 2 * anchor.y) || box.height;
  const rawW = Math.abs(world.x - anchor.x);
  const rawH = Math.abs(world.y - anchor.y);
  const sx = spanX > 0 ? rawW / spanX : 1;
  const sy = spanY > 0 ? rawH / spanY : 1;
  let scale = Math.max(sx, sy);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const MIN_IMAGE_SIZE = 48;
  const smallest = start.reduce((m, s) => Math.min(m, s.width, s.height), Infinity);
  if (Number.isFinite(smallest) && smallest > 0) {
    scale = Math.max(scale, MIN_IMAGE_SIZE / smallest);
  }
  // US-091: same contract as the single-image resize — the lines drawn on each
  // photo scale with it, about the GROUP anchor every photo is scaling about.
  // `scale` here is absolute against the gesture's start snapshot, so the
  // per-frame factor is the ratio against the rect the image has right now.
  //
  // Audit-found bug: membership and scaling used to run PER IMAGE in one pass —
  // for each grouped image, ask what belongs to it, then scale it right there.
  // That double-scales anything claimed by TWO grouped images in the same
  // frame, which the single-line-midpoint test makes rare for annotations but
  // notesWithinBounds makes ORDINARY for notes: its membership rule is "box
  // centre inside these bounds OR any leader tip inside them" (viewport.js), so
  // a caption parked on photo A with its arrow pointing at a detail on
  // neighbouring photo B — the commonest way a TD writes one — qualifies under
  // BOTH images' bounds at once. Because every grouped image scales by
  // essentially the same per-frame factor (they all track one shared `scale`
  // from one shared `anchor`), a double-scaled object doesn't just double —
  // it compounds toward the SQUARE of the intended factor over the drag,
  // silently detaching a note from the feature its arrow points at.
  // startImageDrag (above) already solved the identical ambiguity for a PAN by
  // de-duplicating through a Set before applying any delta; this is the same
  // fix shaped for a scale: collect every claim against each image's
  // PRE-mutation bounds first, keep only the first claim per id, move every
  // image, THEN scale each claimed object exactly once.
  const claimedAnnotations = new Map();
  const claimedNotes = new Map();
  const claimedGraphics = new Map();
  const perImage = [];
  for (const s of start) {
    const image = getImageById(s.id);
    if (!image) continue;
    const previousBounds = getImageBounds(image);
    const factor = image.width > 0 ? (s.width * scale) / image.width : 1;
    perImage.push({ s, factor });
    for (const ann of annotationsWithinBounds(previousBounds)) {
      if (!claimedAnnotations.has(ann.id)) claimedAnnotations.set(ann.id, factor);
    }
    for (const note of notesWithinBounds(previousBounds)) {
      if (!claimedNotes.has(note.id)) claimedNotes.set(note.id, factor);
    }
    for (const graphic of bgOwnedByImage(s.id)) if (!claimedGraphics.has(graphic.id)) claimedGraphics.set(graphic.id, factor);
  }
  for (const { s, factor } of perImage) {
    const image = getImageById(s.id);
    if (!image) continue;
    image.x = anchor.x + (s.x - anchor.x) * scale;
    image.y = anchor.y + (s.y - anchor.y) * scale;
    image.width = s.width * scale;
    image.height = s.height * scale;
  }
  const validFactor = (f) => Number.isFinite(f) && f > 0 && Math.abs(f - 1) > 1e-9;
  for (const [id, factor] of claimedAnnotations) {
    const ann = getAnnotationById(id);
    if (ann && validFactor(factor)) scaleAnnotationAbout(ann, anchor, factor);
  }
  for (const [id, factor] of claimedNotes) {
    const note = getNoteById(id);
    if (note && validFactor(factor)) scaleNoteAbout(note, anchor, factor);
  }
  for (const [id, factor] of claimedGraphics) {
    const graphic=getBoardGraphicById(id); if (graphic && validFactor(factor)) bgScaleAbout(graphic, anchor, factor, factor);
  }
}

  function dragHandle(ann, part, world, prevWorld, altHeld) {
    const dx = world.x - prevWorld.x;
    const dy = world.y - prevWorld.y;

    const moveBy = (p) => { if (p) { p.x += dx; p.y += dy; } };

    const anchor = ann.type === 'curved' ? parseCurveAnchorPart(part) : null;
    const anchorPt = anchor && ann.points ? ann.points[anchor.index] : null;

    if (anchorPt) {
      // US-093 / ADR 0053: dragging the anchor itself carries both its
      // handles rigidly (pen-tool style, same as start/end carrying
      // control1/control2 below). Dragging one of its handles keeps the
      // OPPOSITE handle mirrored unless Alt is held, so the curve can't kink
      // there by accident — recomputed fresh every drag, never stored.
      if (anchor.field === 'point') {
        anchorPt.point = clonePoint(world);
        moveBy(anchorPt.handleIn);
        moveBy(anchorPt.handleOut);
      } else {
        anchorPt[anchor.field] = clonePoint(world);
        if (!altHeld) mirrorOppositeCurveHandle(anchorPt, anchor.field);
      }
    } else if (part === 'start') {
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

  function moveAnnotation(ann, dx, dy) {
    ann.start.x += dx; ann.start.y += dy;
    ann.end.x += dx; ann.end.y += dy;
    for (const key of ['midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      if (ann[key]) { ann[key].x += dx; ann[key].y += dy; }
    }
    if (Array.isArray(ann.points)) {
      for (const anchor of ann.points) {
        for (const field of ['point', 'handleIn', 'handleOut']) {
          if (anchor[field]) { anchor[field].x += dx; anchor[field].y += dy; }
        }
      }
    }
    ann.label.x += dx; ann.label.y += dy;
  }
