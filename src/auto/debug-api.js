// Debug / introspection API facade for offline tooling: the single
// window.__braAutoModeDebug object literal, wiring together functions
// defined throughout the rest of the bundle by name. Source part for
// app.js. Run `npm run build` after editing.
//
// The export builders this facade calls (exportGroundTruth/downloadGroundTruth,
// buildCvDebugExport/downloadCvDebugExport, buildStageDebugSummary) live in
// the sibling src/auto/debug-export.js, which loads before this file.
//
// window.__braAutoModeDebug is a by-NAME contract with the headless test
// suites (smoke, golden, invariants, contract, learning-tests, evidence-tests,
// junction-tests, pipeline-tests, and others) — every key/method name here
// must stay character-for-character identical even as implementations move.

  if (typeof window !== 'undefined') {
    window.__braAutoModeDebug = {
      // Pure detection pipeline stages, exposed so each can be driven with
      // synthetic input and timed independently. Side effects (canvas reads,
      // state writes, toasts) live in runOfflineDetection, not here.
      pipeline: {
        readSourceImagePixels: (img, targetWidth) => readSourceImagePixels(img, targetWidth),
        pixelsToLegacyInkAnalysis: (pixels, w, h) => pixelsToLegacyInkAnalysis(pixels, w, h),
        detectSketchFromInkAnalysis: (cvAnalysis, opts) => detectSketchFromInkAnalysis(cvAnalysis, opts || {}),
        // Skeleton junction / endpoint / corner pass (Phase 1, plan 2).
        // Pure typed-array work — scripts/junction-tests.mjs drives it with
        // synthetic masks, no Chrome needed.
        detectJunctions: (mask, w, h, opts) => detectJunctions(mask, w, h, opts),
        // Derived-anchor cascade (Phase 3, plan 2). Pure — tests feed an
        // anchor list and assert dependents follow their primaries.
        deriveAnchors: (anchors, opts) => deriveAnchors(anchors, opts),
        seedAnchorsFromDetection: (detection, sourceImage, options) =>
          seedAnchorsFromDetection(detection, sourceImage, options),
        // Headless-Chrome-free POM-fixture builder. Tests pass an anchor list
        // and the matching detection so the closure that reads
        // state.autoMode.detection (for cradle/cradleCfTop signals) sees the
        // same numbers a real run would.
        buildPOMFixtureFromAnchors: (anchorList, detectionForTest) => {
          const prev = state.autoMode.detection;
          if (detectionForTest !== undefined) state.autoMode.detection = detectionForTest;
          try {
            return buildPOMFixtureFromAnchors(anchorList);
          } finally {
            state.autoMode.detection = prev;
          }
        },
        validateAutoFixture: (fixture, detectionForTest) => {
          const prev = state.autoMode.detection;
          if (detectionForTest !== undefined) state.autoMode.detection = detectionForTest;
          try {
            return validateAutoFixture(fixture);
          } finally {
            state.autoMode.detection = prev;
          }
        },
      },
      getDetection: () => {
        const det = state.autoMode.detection;
        if (!det) return null;
        // Drop the binary ink mask (U2 snap-to-ink working data): JSON-cloning
        // a Uint8Array would explode it into one key per pixel. Expose its
        // dimensions so tests can assert it was retained.
        const { inkMask, ...rest } = det;
        return Object.assign(clone(rest), { hasInkMask: !!inkMask });
      },
      // Read-only per-stage debug summary (Engineering Workflow, Phase 1):
      // segmentation quality signals, contour/junction counts, geometry facts,
      // landmark confidence, and anchor confidence for the most recent run.
      // Pure read of state.autoMode.detection/.anchors — never mutates them, so
      // it cannot affect detection output.
      getStageSummary: (name) => clone(buildStageDebugSummary(name)),
      // Phase 3 segmentation seam. A registered adapter is tried FIRST in the
      // segmentation stage; it must return the built-in ink-analysis shape and
      // MUST run fully offline (no network call carrying sketch/measurement
      // data). Default is unregistered, so the runtime is unchanged until a
      // caller opts in. clear() restores the built-in OpenCV / legacy path.
      segmentation: {
        registerAdapter: (fn) => registerSegmentationAdapter(fn),
        clearAdapter: () => clearSegmentationAdapter(),
        hasAdapter: () => !!getSegmentationAdapter(),
      },
      getAnchors: () => clone(state.autoMode.anchors),
      // Board viewport, so UI-level tests can convert an anchor's world
      // position (image rect + normalized anchor) into canvas screen
      // coordinates for synthetic mouse events.
      getViewport: () => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      // Ground-truth export for scripts/accuracy-tests.mjs. Returns the
      // current anchors keyed by kind in normalized image space.
      exportGroundTruth: (name) => clone(exportGroundTruth(name)),
      getDrafts: () => clone(state.autoMode.draftAnnotations),
      getImages: () => state.images.map(image => ({
        id: image.id,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
      // US-082 toolbar test seam: add decoded Board image data without also
      // invoking detection. This isolates the ready-state toolbar contract;
      // the smoke/golden suites continue to own detection proof.
      addBoardImages: async (dataURLs) => {
        await addImagesFromDataURLs(Array.isArray(dataURLs) ? dataURLs : []);
        return {
          imageCount: state.images.length,
          status: state.autoMode.status,
        };
      },
      getAnnotations: () => clone(state.annotations),
      // ADR 0071.
      getNotches: () => clone(state.notches || []),
      // US-095 focused browser proof. The mutation seams call the same model
      // functions as the toolbar/pointer paths and keep measurement state out.
      getGraphics: () => clone(state.graphics || []),
      graphics: {
        addLive: (kind, box, sourceImageId) => {
          const b = box || {x:0,y:0,width:100,height:100};
          const graphic = normalizeBoardGraphic({ id:bgNextId('bg'), shapeKind:kind, mode:'live', color:state.drawColor,
            lineWidth:state.lineWidth, sourceImageId:sourceImageId == null?null:sourceImageId,
            live:{center:{x:b.x+b.width/2,y:b.y+b.height/2},width:b.width,height:b.height} });
          state.graphics.push(graphic); setSelection('graphic',graphic.id); pushHistoryIfChanged(); requestRender(); return clone(graphic);
        },
        enterEdit: id => { setSelection('graphic',id); return bgEnterEdit(getSelectedBoardGraphic()); },
        activateNode: (graphicId, subpathIndex, nodeIndex) => {
          const g=getBoardGraphicById(graphicId), sp=g&&g.subpaths[subpathIndex], n=sp&&sp.nodes[nodeIndex]; if(!n)return false;
          setSelection('graphic',graphicId); state.graphicEdit={graphicId,active:{kind:'node',subpathId:sp.id,nodeId:n.id}}; updateUI();requestRender();return true;
        },
        activateSegment: (graphicId, subpathIndex, segmentIndex, t) => {
          const g=getBoardGraphicById(graphicId), sp=g&&g.subpaths[subpathIndex], n=sp&&sp.nodes[segmentIndex]; if(!n)return false;
          setSelection('graphic',graphicId); state.graphicEdit={graphicId,active:{kind:'segment',subpathId:sp.id,startNodeId:n.id,t:Number.isFinite(t)?t:0.5}};updateUI();requestRender();return true;
        },
        cut: () => cutSelectedBoardGraphicPath(),
        setSegmentType: type => bgSetActiveSegmentType(type),
        selectImage: id => { setSelection('image', id); return !!getSelectedImage(); },
      },
      // US-092 Board text notes. getNotes is the read side; addNote is the
      // test seam that stands in for the Text tool before the pointer layer
      // exists, and behaves like it will — one history entry per note, so a
      // suite can assert undo/redo and the save round-trip.
      getNotes: () => clone(state.notes || []),
      addNote: (text, pos, options) => {
        const note = createNote(text, pos, options);
        state.notes.push(note);
        pushHistoryIfChanged();
        if (typeof requestRender === 'function') requestRender();
        return clone(note);
      },
      setNoteAppearance: value => { setNoteAppearance(value); return normalizeNoteAppearance(state.noteAppearance); },
      setNoteTextColor: value => { setNoteTextColor(value); return normalizeColorKey(state.noteTextColor); },
      setNoteLeaderColor: value => { setNoteLeaderColor(value); return normalizeColorKey(state.noteLeaderColor); },
      // US-092 step 6: where a note's grabbable geometry actually is — its
      // shrink-wrapped box, its leader tips, and the handle that pulls a new
      // arrow out. A test must AIM at these, and noteBounds depends on measured
      // text so it cannot be recomputed outside the app; guessing the box from
      // pos + boxWidth would mean the suite silently tests empty canvas the day
      // the padding changes. Read-only, same spirit as getView.
      getNoteHandles: (id) => {
        const note = getNoteById(id);
        if (!note) return null;
        const box = noteBounds(note);
        return {
          box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
          add: clone(noteLeaderAddHandle(note)),
          resize: clone(noteResizeHandle(note)),
          leaders: clone(note.leaders || []),
        };
      },
      // US-092 step 5: the note editor's live session, so a suite can assert
      // that a Text-tool click OPENED an editor and what it holds, rather than
      // inferring it from a note that may not exist yet. `mode` distinguishes
      // placing a new note from re-opening one — the two commit paths differ.
      getNoteEditor: () => {
        const session = state.noteEditor;
        if (!session) return null;
        return {
          mode: session.id != null ? 'edit' : 'create',
          noteId: session.id != null ? session.id : null,
          value: String(el.noteEditor.value || ''),
          visible: el.noteEditor.style.display === 'block',
        };
      },
      // Test-only: set the review-time hidden POM lines by annotation id — the
      // same session-only state the panel's × toggle writes (state.hiddenAnnIds).
      // Lets the export suite assert hidden lines are omitted from the spec
      // without faking clicks. Not persisted, mirroring the UI it stands in for.
      // US-093 / ADR 0053 code review, 2026-08-21: it exits through the panel's
      // own syncAfterHiddenPomChange() (src/ui/spec-visibility.js). While it
      // only re-rendered the panel it missed the toolbar sync a real × click
      // does — "Add point" stays armed on the line just hidden — so it quietly
      // stopped standing in for the button it exists to stand in for.
      setHiddenAnnIds: (ids) => {
        state.hiddenAnnIds = Array.isArray(ids) ? ids.slice() : [];
        syncAfterHiddenPomChange();
        return clone(state.hiddenAnnIds);
      },
      // Tier-0 library-value suggestions (scripts/suggestions-tests.mjs).
      // getPomSuggestions: the raw per-POM corpus stats loaded into scope.
      // getEffectivePomSpec: the panel's effective spec for a POM (TD override
      //   if any, else the library suggestion) — proves the fallback + export
      //   path. setPomSpecOverride: set a TD override and re-render, returning
      //   the new effective spec so a test can assert override wins.
      getPomSuggestions: () => clone(POM_SUGGESTIONS),
      getEffectivePomSpec: (key) => (typeof getPomSpec === 'function' ? clone(getPomSpec(key)) : null),
      setPomSpecOverride: (key, field, value) => {
        const changed = setPomSpec(key, field, value);
        if (changed) pushHistoryIfChanged();
        if (typeof renderSpecPanel === 'function') renderSpecPanel();
        return clone(getPomSpec(key));
      },
      // US-096 / ADR 0055: the measurement set and the preset library.
      //   getMeasurementAnnIds: the exact lines the spec panel, both workbooks
      //     and Preview build rows from — the claim the story is about. A
      //     construction line is absent here while still present in
      //     getAnnotations() and getExportAnnIds() (it is drawn and exported,
      //     just not measured).
      //   getLinePresets / applyLinePreset: drive the library without opening
      //     the menu, so a suite can assert the model separately from the UI.
      getMeasurementAnnIds: () => (typeof measurementAnnotations === 'function'
        ? measurementAnnotations().map(a => a.id) : null),
      getLinePresets: () => (typeof getLinePresets === 'function' ? clone(getLinePresets()) : null),
      applyLinePreset: (id) => (typeof applyLinePreset === 'function' ? applyLinePreset(id) : false),
      addLinePreset: (name) => (typeof addLinePreset === 'function' ? clone(addLinePreset(name)) : null),
      addLineTreatment: (name, recipe) => (typeof addLineTreatment === 'function'
        ? clone(addLineTreatment(name, recipe)) : null),
      updateLineTreatment: (id, recipe, name) => (typeof updateLineTreatment === 'function'
        ? updateLineTreatment(id, recipe, name) : false),
      applyLineTreatmentToIds: (ids, recipe) => {
        const anns = (Array.isArray(ids) ? ids : []).map(id => getAnnotationById(id)).filter(Boolean);
        return typeof applyTreatmentRecipeToAnnotations === 'function'
          ? applyTreatmentRecipeToAnnotations(recipe, anns) : 0;
      },
      getLineTreatmentMetrics: (id) => {
        const ann = getAnnotationById(id);
        const treatment = ann && normalizeLineTreatment(ann.lineTreatment);
        return treatment ? { scale: treatment.scale, layers: clone(scaledLineTreatmentLayers(treatment)) } : null;
      },
      setSmartAlignEnabled: (enabled) => setSmartAlignEnabled(enabled, false),
      previewSmartAlignment: (ids, dx, dy, bypass) => {
        const movingIds = Array.isArray(ids) ? ids : [];
        const sources = movingIds.map(id => getAnnotationById(id)).filter(Boolean).map(clone);
        return clone(computeSmartAlignment(sources, movingIds, dx, dy, !!bypass));
      },
      selectAnnotation: (id) => {
        if (!getAnnotationById(id)) return false;
        setSelection('annotation', id);
        return true;
      },
      clearSelection: () => { clearSelection(); return true; },
      // US-102: the two callout-visibility gates, exposed distinctly so a
      // test can prove Sketch Focus reaches only the live-canvas one.
      // annotationShowsCallout is what the Board canvas (render-annotations
      // .js), hit-testing, and the label editor read; labelsVisible is what
      // export-pdf.js's drawBoardContentForExport reads (shared by Copy
      // Image, the Excel embedded sketch, and the Preview board sheet) — it
      // must stay true/false based only on the Hide/Show Numbers toggle and
      // Stitch mode, never on state.sketchMode.
      annotationShowsCallout: (id) => {
        const ann = getAnnotationById(id);
        return ann ? annotationShowsCallout(ann) : null;
      },
      labelsVisible: () => labelsVisible(),
      resetLinePresets: () => {
        if (typeof resetLinePresetsToBuiltins === 'function') resetLinePresetsToBuiltins();
      },
      importLinePresetsJson: (text) => (typeof importLinePresetsFromJson === 'function'
        ? importLinePresetsFromJson(text) : 0),
      // US-107: a project's own presets the local library does not have yet —
      // the model half of the Library dialog's "Import N from project" action
      // (src/manual/line-presets.js), so a suite can assert the offer without
      // the dialog's own visibility rule standing in for it.
      getPendingLinePresets: () => (typeof getPendingProjectLinePresets === 'function'
        ? clone(getPendingProjectLinePresets()) : null),
      // US-097 / ADR 0056: the shape-stamp library. getShapeStamps returns the
      // stored geometry so a suite can compare a placed line against the stamp
      // it came from; sampleAnnotationShape returns the SHAPE of any line,
      // normalized into its own bounding box, which is the only way to assert
      // "the curve that came back is the curve that was saved" independently of
      // where and how big it was placed.
      getShapeStamps: () => (typeof getShapeStamps === 'function' ? clone(getShapeStamps()) : null),
      resetShapeStamps: () => {
        if (typeof commitShapeStamps === 'function') commitShapeStamps([]);
      },
      importShapeStampsJson: (text) => (typeof importShapeStampsFromJson === 'function'
        ? importShapeStampsFromJson(text) : 0),
      setActiveShapeStamp: (id) => {
        if (typeof setActiveShapeStamp === 'function') setActiveShapeStamp(id);
      },
      addTemplateFromAnnotationIds: (name, ids, options) => {
        const anns = (Array.isArray(ids) ? ids : []).map(id => getAnnotationById(id)).filter(Boolean);
        const template = typeof shapeStampFromAnnotations === 'function'
          ? shapeStampFromAnnotations(anns, name, options) : null;
        if (!template) return null;
        commitShapeStamps([...getShapeStamps(), template]);
        return clone(template);
      },
      placeTemplateInBox: (id, box, mirrored) => {
        const template = getShapeStampById(id);
        if (!template || !box) return [];
        const groupId = 'template-' + state.idCounter++;
        const anns = createAnnotationsFromStamp(template, box, groupId, !!mirrored);
        state.annotations.push(...anns);
        if (anns.length) {
          state.selection = { kind: 'annotation', id: anns[0].id };
          state.selectedAnnotationIds = anns.map(ann => ann.id);
        }
        pushHistoryIfChanged(); updateUI(); requestRender();
        if (template.id) touchShapeStampUsage(template.id);
        return clone(anns);
      },
      // US-106: Library Manager — categories, metadata edits, and the two
      // small placement seams (place-at-saved-size and mirror) so a suite can
      // assert on the model directly, alongside driving the real dialog.
      library: {
        categories: () => (typeof libraryCategories === 'function' ? clone(libraryCategories()) : []),
        setCategory: (id, category) => (typeof setShapeStampCategory === 'function' ? setShapeStampCategory(id, category) : false),
        setTags: (id, tags) => (typeof setShapeStampTags === 'function' ? setShapeStampTags(id, tags) : false),
        setNotes: (id, notes) => (typeof setShapeStampNotes === 'function' ? setShapeStampNotes(id, notes) : false),
        setFavorite: (id, favorite) => (typeof setShapeStampFavorite === 'function' ? setShapeStampFavorite(id, favorite) : false),
        toggleFavorite: (id) => (typeof toggleShapeStampFavorite === 'function' ? toggleShapeStampFavorite(id) : false),
        duplicate: (id) => (typeof duplicateShapeStamp === 'function' ? clone(duplicateShapeStamp(id)) : null),
        // US-107: deleting a Template is a real dialog action (card menu ▸
        // Delete…, behind a window.confirm the Library dialog itself owns).
        // This hook isolates deleteShapeStamp's OWN model-layer behavior —
        // specifically, that deleting the currently ARMED stamp also clears
        // the arm and switches the tool away from 'stamp' — from the
        // confirm-dialog plumbing around it, which library-manager-check.mjs
        // already drives for real.
        deleteStamp: (id) => (typeof deleteShapeStamp === 'function' ? deleteShapeStamp(id) : false),
        armForPlacement: (id, opts) => {
          if (typeof armShapeStampForPlacement === 'function') armShapeStampForPlacement(id, opts);
        },
        getArmedMirrored: () => !!state.activeStampMirrored,
        defaultBoxAt: (id, world) => {
          const stamp = getShapeStampById(id);
          return stamp && typeof defaultStampBoxAt === 'function' ? clone(defaultStampBoxAt(stamp, world)) : null;
        },
      },
      // US-104: DXF import. `parse` is the pure text -> pieces parser (no
      // board mutation), `computePlacement` the pure viewport-fit transform,
      // both exposed independently so unit-level cases (bulge signs, cap
      // boundaries, the auto-fit-box formula) don't need a real file input or
      // a real viewport. `importText` drives the real one-shot board mutation
      // the Tools-menu button itself calls.
      dxf: {
        parse: (text) => (typeof parseDxfDocument === 'function' ? clone(parseDxfDocument(text)) : null),
        computePlacement: (bounds, rect, centerWorld, zoom) => (typeof computeDxfPlacementTransform === 'function'
          ? clone(computeDxfPlacementTransform(bounds, rect, centerWorld, zoom)) : null),
        importText: (text, rect) => (typeof importDxfText === 'function' ? clone(importDxfText(text, rect)) : null),
        // ADR 0070: the Pattern Pieces panel's pure state operations, exposed
        // independently of the real DOM panel (src/ui/pattern-pieces-panel.js)
        // so a headless suite can assert the group-list/remove logic without
        // driving live checkbox clicks for every case.
        patternPieces: {
          groups: () => (typeof patternPieceGroups === 'function' ? clone(patternPieceGroups()) : null),
          remove: (groupIds) => { if (typeof removePatternPieceGroups === 'function') removePatternPieceGroups(groupIds); },
          // ADR 0072.
          simplify: (groupId) => (typeof simplifyPieceGroup === 'function' ? clone(simplifyPieceGroup(groupId)) : null),
          isOpen: () => (typeof isPatternPiecesPanelOpen === 'function' ? isPatternPiecesPanelOpen() : null),
          open: () => { if (typeof openPatternPiecesPanel === 'function') openPatternPiecesPanel(); },
          close: () => { if (typeof closePatternPiecesPanel === 'function') closePatternPiecesPanel(); },
        },
        // US-105: Pattern Measure. `measure.*` exposes the pure native
        // parser + geometry kernel independently of any board/UI state (unit
        // tests), plus read-only session getters an E2E suite can compare
        // against real pointer-driven results. Every mutating action
        // (create/delete/undo/redo) also has a real UI path — see
        // src/manual/dxf-measure-interaction.js / dxf-measure-panel.js — this
        // namespace never substitutes for driving that path in an
        // integration-level test, only for isolating the pure math.
        measure: {
          parseNative: (text) => (typeof parseDxfNativeModel === 'function' ? clone(parseDxfNativeModel(text)) : null),
          // Pure kernel primitives (src/geometry/dxf-path-kernel.js), exposed
          // independently of any session/board state so a unit test can
          // drive exact synthetic segments (bulge signs, wraparound sweeps,
          // adaptive Bézier tolerance, degenerate input) without importing a
          // file at all.
          reasonCodes: () => clone(DXF_MEASURE_REASON),
          segmentLength: (seg) => (typeof dxfSegmentLength === 'function' ? dxfSegmentLength(seg) : null),
          segmentFailureReason: (seg) => (typeof dxfSegmentFailureReason === 'function' ? dxfSegmentFailureReason(seg) : null),
          partialLength: (seg, t0, t1) => (typeof dxfPartialLength === 'function' ? dxfPartialLength(seg, t0, t1) : null),
          projectPointOnSegment: (point, seg) => (typeof dxfProjectPointOnSegment === 'function' ? clone(dxfProjectPointOnSegment(point, seg)) : null),
          directDistance: (a, b) => (typeof dxfDirectDistance === 'function' ? dxfDirectDistance(a, b) : null),
          enumerateRoutesRaw: (segments, refA, refB, tolerance) => (typeof dxfEnumerateRoutes === 'function'
            ? clone(dxfEnumerateRoutes(segments, refA, refB, tolerance)) : null),
          reverseRoute: (route) => (typeof dxfReverseRoute === 'function' ? clone(dxfReverseRoute(route)) : null),
          routeLength: (route, segments) => (typeof dxfRouteLength === 'function' ? dxfRouteLength(route, segments) : null),
          routeAuthoredDirectionScore: (route, segments) => (typeof dxfRouteAuthoredDirectionScore === 'function'
            ? dxfRouteAuthoredDirectionScore(route, segments) : null),
          resolveNativeToInch: (insunits) => (typeof dxfResolveNativeToInch === 'function' ? clone(dxfResolveNativeToInch(insunits)) : null),
          getSession: () => {
            const session = state.dxfMeasureSession;
            if (!session) return null;
            return {
              pieceCount: session.pieces.length,
              pieceSegmentCounts: session.pieces.map(p => p.segments.length),
              source: clone(session.source),
              // ADR 0073: the TD's unit override + the resolved status the
              // UI note/status chip renders from.
              unitOverride: session.unitOverride || null,
              unitStatus: (typeof dxfMeasureUnitStatus === 'function') ? clone(dxfMeasureUnitStatus(session)) : null,
              topologyToleranceNative: session.topologyToleranceNative,
              measurementCount: session.measurements.length,
              measurements: clone(session.measurements),
              selectedMeasurementId: session.selectedMeasurementId,
              // RB-1/RB-2/RB-3: the full interaction object (minus function
              // fields like onResolved, which structuredClone-style `clone()`
              // cannot carry across anyway) — a test needs candidates/hits/
              // chosenIndex/truncated/preview to assert on, not just `type`.
              interaction: session.interaction ? clone(session.interaction) : null,
              historyPast: session.history.past.length,
              historyFuture: session.history.future.length,
              diagnostics: clone(session.diagnostics || {}),
              pieceAnchorAnnotationIds: (session.pieceAnchors || []).map(anchor => anchor ? anchor.annotationId : null),
              pieceBounds: clone(session.pieceBounds || []),
            };
          },
          pieceSegments: (pieceIndex) => {
            const session = state.dxfMeasureSession;
            const piece = session && session.pieces[pieceIndex];
            return piece ? clone(piece.segments) : null;
          },
          enumerateRoutes: (refA, refB) => (typeof dxfMeasureEnumerateRoutes === 'function'
            ? clone(dxfMeasureEnumerateRoutes(state.dxfMeasureSession, refA, refB)) : null),
          nativeToBoard: (point) => (typeof dxfMeasureNativeToBoard === 'function'
            ? clone(dxfMeasureNativeToBoard(point, state.dxfMeasureSession)) : null),
          nativeToBoardLive: (point, pieceIndex) => (typeof dxfMeasureNativeToBoardLive === 'function'
            ? clone(dxfMeasureNativeToBoardLive(point, state.dxfMeasureSession, pieceIndex)) : null),
          boardToNative: (point) => (typeof dxfMeasureBoardToNative === 'function'
            ? clone(dxfMeasureBoardToNative(point, state.dxfMeasureSession)) : null),
          valueInches: (measurementId) => {
            const session = state.dxfMeasureSession;
            const measurement = session && dxfMeasureGetMeasurement(session, measurementId);
            return measurement ? dxfMeasureValueInches(session, measurement) : null;
          },
          handleWorldPosition: (measurementId, which) => {
            const session = state.dxfMeasureSession;
            const measurement = session && dxfMeasureGetMeasurement(session, measurementId);
            return measurement ? clone(dxfMeasureHandleWorldPos(session, measurement, which)) : null;
          },
          labelWorldPosition: (measurementId) => {
            const session = state.dxfMeasureSession;
            const measurement = session && dxfMeasureGetMeasurement(session, measurementId);
            return measurement ? clone(dxfMeasureLabelWorldPos(session, measurement)) : null;
          },
          routeWorldPoints: (measurementId) => {
            const session = state.dxfMeasureSession;
            const measurement = session && dxfMeasureGetMeasurement(session, measurementId);
            return measurement ? clone(dxfMeasureRouteWorldPoints(session, measurement, 16)) : [];
          },
          cycleChoice: (delta) => dxfMeasureCycleRouteCandidate(state.dxfMeasureSession, delta),
          confirmChoice: () => dxfMeasureConfirmRouteCandidate(state.dxfMeasureSession),
          confirmPendingChoice: () => dxfMeasureHandleEnterKey(),
          selectMeasurement: (measurementId) => {
            const session = state.dxfMeasureSession;
            if (!session || !dxfMeasureGetMeasurement(session, measurementId)) return false;
            session.selectedMeasurementId = measurementId;
            requestRender();
            return true;
          },
          activateMeasurementForEdit: (measurementId) => {
            const session = state.dxfMeasureSession;
            if (!session || !dxfMeasureGetMeasurement(session, measurementId)) return false;
            session.placementArmed = false;
            session.interaction = null;
            session.selectedMeasurementId = measurementId;
            setTool('pattern-measure');
            requestRender();
            return true;
          },
          pieceAnchorGeometry: (pieceIndex) => {
            const session = state.dxfMeasureSession;
            const anchor = session && session.pieceAnchors && session.pieceAnchors[pieceIndex];
            const ann = anchor && getAnnotationById(anchor.annotationId);
            return ann ? clone({ id: ann.id, start: ann.start, end: ann.end }) : null;
          },
          beginPieceMove: (pieceIndex, world) => {
            const session = state.dxfMeasureSession;
            const anchor = session && session.pieceAnchors && session.pieceAnchors[pieceIndex];
            const ann = anchor && getAnnotationById(anchor.annotationId);
            if (!ann || !world) return false;
            setSelection('annotation', ann.id);
            startAnnotationDrag(ann.id, world);
            return true;
          },
          formatInches: (value) => (typeof dxfMeasureFormatInches === 'function' ? dxfMeasureFormatInches(value) : null),
          valueInches: (measurementId) => {
            const session = state.dxfMeasureSession;
            const m = session && typeof dxfMeasureGetMeasurement === 'function' ? dxfMeasureGetMeasurement(session, measurementId) : null;
            return m && typeof dxfMeasureValueInches === 'function' ? dxfMeasureValueInches(session, m) : null;
          },
          deleteMeasurement: (id) => (typeof dxfMeasureDeleteMeasurement === 'function'
            ? dxfMeasureDeleteMeasurement(state.dxfMeasureSession, id) : false),
          // ADR 0073: the TD unit override — same function the real
          // #dxfMeasureUnitSelect change handler calls.
          setUnitOverride: (key) => (typeof dxfMeasureSetUnitOverride === 'function'
            ? dxfMeasureSetUnitOverride(state.dxfMeasureSession, key) : false),
          undo: () => (typeof dxfMeasureUndo === 'function' ? dxfMeasureUndo() : false),
          redo: () => (typeof dxfMeasureRedo === 'function' ? dxfMeasureRedo() : false),
        },
      },
      sampleAnnotationShape: (annotationId, samples) => {
        const ann = state.annotations.find(a => a && a.id === annotationId);
        if (!ann || typeof getAnnotationPolyline !== 'function') return null;
        const n = Math.max(8, Number(samples) || 64);
        const pts = getAnnotationPolyline(ann, n);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const w = maxX - minX, h = maxY - minY;
        const total = polylineLength(pts);
        // Resampled at EQUAL ARC LENGTH, not at equal index: two renderings of
        // the same curve at different sizes get different chord counts, so
        // index-wise comparison would drift even for an identical shape.
        const out = [];
        for (let i = 0; i <= n; i += 1) {
          const at = samplePolylineAt(pts, total * (i / n));
          out.push({
            x: w > 1e-6 ? (at.point.x - minX) / w : 0.5,
            y: h > 1e-6 ? (at.point.y - minY) / h : 0.5,
          });
        }
        return { points: out, width: w, height: h, aspect: w > 1e-6 ? h / w : 0 };
      },
      exportLinePresetsJson: () => (typeof linePresetsEnvelope === 'function'
        ? JSON.stringify(linePresetsEnvelope()) : null),
      // Export image paths honor hidden POMs (scripts/export-hidden-tests.mjs).
      // getExportAnnIds: the exact applied-annotation set the export renderers
      //   (PDF / Copy Image / Excel embedded PNG) draw and crop from, so a test
      //   can assert a hidden POM is dropped without a real canvas.
      // exportBoardDataUrl: the rendered export board as a PNG data URL, for
      //   visual verification that a hidden line's pixels are gone.
      getExportAnnIds: () => (typeof visibleExportAnnotations === 'function'
        ? visibleExportAnnotations().map(a => a.id) : null),
      exportBoardDataUrl: () => {
        if (typeof getContentBounds !== 'function' || typeof renderBoardRegionToCanvas !== 'function') return null;
        const bounds = getContentBounds();
        if (!bounds) return null;
        return renderBoardRegionToCanvas(bounds).toDataURL('image/png');
      },
      // Canvas view transform. Needed to drive REAL pointer events from world
      // coordinates in a test (screenX = worldX * zoom + panX + canvasRect.left),
      // which is the only way to exercise selection, drag and resize the way a TD
      // does. Without it a UI test has to guess pixel positions.
      getView: () => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      // US-103: a direct zoom setter — proving Smart Hit's catch zone scales
      // correctly at more than one zoom needs a real zoom CHANGE, and driving
      // one through synthetic wheel events would test the wheel handler, not
      // Smart Hit. requestRender() so the next getBoundingClientRect-based
      // screen math in a test reads the already-repainted canvas.
      setZoom: (zoom) => {
        state.zoom = Math.max(0.05, Number(zoom) || state.zoom);
        requestRender();
        return state.zoom;
      },
      setView: (view) => {
        if (view && Number.isFinite(view.zoom)) state.zoom = Math.max(0.05, view.zoom);
        if (view && Number.isFinite(view.panX)) state.panX = view.panX;
        if (view && Number.isFinite(view.panY)) state.panY = view.panY;
        requestRender();
        return { zoom: state.zoom, panX: state.panX, panY: state.panY };
      },
      // US-086: what the pointer is currently doing. board-interaction-check
      // needs to assert WHICH gesture a press opened — "the whole line moved"
      // alone cannot tell a line drag from a photo drag that carried its lines
      // along. Shape only, never the geometry payload.
      getInteraction: () => {
        const it = state.interaction;
        if (!it) return null;
        return {
          type: it.type,
          part: it.part || null,
          id: it.id != null ? it.id : null,
          armed: !!it.armed,
          hasStartWorld: !!it.startWorld,
          changed: !!it.changed,
        };
      },
      getAcceptanceStats: () => clone(getAutoAcceptanceStats()),
      clearAcceptanceStats: () => clearAutoAcceptanceStats(),
      getTelemetryLog: () => clone(getAutoTelemetryLog()),
      getTelemetryReport: (limit) => clone(getAutoTelemetryReport(limit || 10)),
      clearTelemetryLog: () => clearAutoTelemetryLog(),
      runAutoOnDataUrl: async (dataURL, opts) => {
        // Opt-in CV debug capture per-call. When opts.cvDebug is true, the
        // CV debug flag is flipped on before detection so the resulting
        // detection.debug payload is populated for the caller to inspect.
        if (opts && opts.cvDebug) {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null, lastExport: null };
          }
          state.autoMode.cvDebug.enabled = true;
        }
        setAppMode('auto');
        await addImagesFromDataURLs([dataURL]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceImage = state.images[state.images.length - 1] || null;
        if (!sourceImage) throw new Error('No image was added.');
        // opts.auxDataURLs: add EXTRA board photos (e.g. a separate front-inner
        // cutaway) before detection, so a suite can exercise the real 2-image board
        // a TD uses. Until this existed every suite ran a single image, which is why
        // the aux-view path could regress with all suites green (ADR 0036 follow-up).
        // The primary image stays the detection source; extras become aux views.
        const auxDataURLs = (opts && Array.isArray(opts.auxDataURLs)) ? opts.auxDataURLs : [];
        if (auxDataURLs.length) {
          await addImagesFromDataURLs(auxDataURLs);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        state.selection = { kind: 'image', id: sourceImage.id };
        await runOfflineDetection();
        generatePOMDraftsFromAnchors({ keepDraftsForReview: true, suppressReplacePrompt: true });
        return {
          state: window.__braAutoModeDebug.getState(),
          images: window.__braAutoModeDebug.getImages(),
          detection: window.__braAutoModeDebug.getDetection(),
          anchors: window.__braAutoModeDebug.getAnchors(),
          drafts: window.__braAutoModeDebug.getDrafts(),
          cvDebug: window.__braAutoModeDebug.cv.getLastDebug(),
          cvExport: window.__braAutoModeDebug.cv.exportDebug(sourceImage.id),
        };
      },
      approveDrawableDrafts: () => {
        const targets = state.autoMode.draftAnnotations
          .filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
        for (const draft of targets) approveDraftAnnotation(draft);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return targets.length;
      },
      applyApprovedDrafts: () => applyApprovedDraftsAtomically({ suppressPrompt: true }),
      /* The draft -> applied-annotation field copy on its own, so a suite can
         assert what survives Apply without having to drive a whole board into a
         state where Apply succeeds. buildAppliedAnnotation is the mirror of
         buildDraftAnnotation and a field missing from it vanishes silently. */
      buildAppliedAnnotationForTest: (draft) => clone(buildAppliedAnnotation(clone(draft))),
      exportProject: () => clone(buildProjectSnapshot()),
      /* US-080: drives a MAIN PAGE sketch slot the way the upload/paste menu
         does, and hands back the RAW runtime state.mainPage — the one history
         clones — so a suite can prove the image bytes never land in it. */
      setMainPageSketch: async (variant, index, dataURL) => {
        if (typeof mpSetSketch !== 'function') return null;
        await mpSetSketch(variant, index, dataURL);
        return JSON.stringify(state.mainPage);
      },
      loadProject: async (project) => {
        await loadProject(project);
        return window.__braAutoModeDebug.getState();
      },
      // Autosave hooks — only intended for end-to-end tests that need
      // to force a write without simulating a live edit cycle.
      autosave: {
        flush: () => (typeof flushAutosave === 'function' ? flushAutosave() : null),
        peek: () => {
          try { return localStorage.getItem('bra-sketch-autosave-v1'); }
          catch (_) { return null; }
        },
        clear: () => (typeof clearAutosave === 'function' ? clearAutosave() : null),
      },
      getState: () => ({
        appMode: state.appMode,
        activePage: state.activePage,
        // US-092: the pointer layer's own outputs. `state` itself is inside the
        // bundle's IIFE and unreachable from a test page, so "which tool is
        // active" and "what is selected" have to come through here — a click
        // that selected the wrong KIND of thing is otherwise invisible.
        tool: state.tool,
        drawSession: clone(state.drawSession),
        selection: { kind: state.selection.kind, id: state.selection.id != null ? state.selection.id : null },
        selectedAnnotationIds: getSelectedAnnotationIds().slice(),
        templateGroupEditId: state.templateGroupEditId || null,
        smartAlignEnabled: !!state.smartAlignEnabled,
        sketchMode: !!state.sketchMode,
        // US-104 round 8: so a suite can assert Set/Clear Scale actually
        // wrote/cleared calibration, not just that a button toggled.
        calibration: clone(state.calibration),
        activeStampId: state.activeStampId != null ? state.activeStampId : null,
        interaction: state.interaction ? { type: state.interaction.type } : null,
        drawStyle: state.drawStyle,
        // US-103: the pending "next line" arrow default, and its POM-side
        // backup while Sketch Focus is on (applySketchModeVisual,
        // src/manual/sketch-mode.js) — both session-only, neither persisted.
        arrowType: state.arrowType,
        pomArrowType: state.pomArrowType != null ? state.pomArrowType : null,
        smartAlignGuides: clone(state.smartAlignGuides || []),
        hoverAnnotationId: state.hoverAnnotationId != null ? state.hoverAnnotationId : null,
        noteCount: (state.notes || []).length,
        autoStatus: state.autoMode.status,
        lastError: state.autoMode.lastError,
        validation: clone(state.autoMode.validation),
        imageCount: state.images.length,
        draftCount: state.autoMode.draftAnnotations.length,
        anchorCount: state.autoMode.anchors.length,
      }),
      // US-094: read-only command inventory for the focused keyboard suite.
      // Functions stay private; tests get only stable metadata plus the same
      // live availability result the palette renders.
      commands: {
        list: () => getAppCommands().map(command => ({
          id: command.id,
          label: command.label,
          category: command.category,
          page: command.page,
          shortcut: formatAppCommandShortcuts(command),
          availability: getAppCommandAvailability(command),
        })),
        run: id => runAppCommand(String(id || '')),
      },
      // CV debug surface. Toggles intermediate detector state capture and
      // hands tests a compact JSON snapshot they can diff. Pure orthogonal
      // to learning / meaning — only intermediate detector signals.
      cv: {
        isEnabled: () => !!(state.autoMode.cvDebug && state.autoMode.cvDebug.enabled),
        setEnabled: (on) => {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null, lastExport: null };
          }
          state.autoMode.cvDebug.enabled = !!on;
          if (!state.autoMode.cvDebug.enabled) state.autoMode.cvDebug.lastDebug = null;
          return state.autoMode.cvDebug.enabled;
        },
        getLastDebug: () => clone(state.autoMode.cvDebug && state.autoMode.cvDebug.lastDebug),
        clearLastDebug: () => {
          if (state.autoMode.cvDebug) {
            state.autoMode.cvDebug.lastDebug = null;
            state.autoMode.cvDebug.lastExport = null;
          }
        },
        // Compact JSON snapshot — anchors + thresholds + learned params +
        // validation warnings + (when CV debug was on) the full intermediate
        // capture. Safe to call any time after Detect Sketch.
        exportDebug: (imageName) => clone(buildCvDebugExport(imageName)),
        // Browser-only: triggers a Blob download of the export JSON.
        downloadDebug: (imageName) => clone(downloadCvDebugExport(imageName)),
      },
      // Learning-mode test surface. Lets scripts/learning-tests.mjs
      // drive recordAnchorResidual / getAnchorBias / the on-off toggle
      // without touching the DOM or window.confirm. Not used by the
      // app itself — purely a CDP hook for the test runner.
      learning: {
        isEnabled: () => isLearningEnabled(),
        setEnabled: (on) => { setLearningEnabled(!!on); },
        recordResidual: (kind, dx, dy, anchor) => recordAnchorResidual(kind, dx, dy, anchor),
        // Phase 8: stage attribution for a hypothetical correction, without
        // recording it — lets the learning suite assert the classifier.
        classifyResidual: (kind, dx, dy) => classifyResidualStage(kind, dx, dy),
        getBias: (kind, anchor) => clone(getAnchorBias(kind, anchor)),
        getSampleCount: () => getLearningSampleCount(),
        // US-096 / ADR 0055 code review, 2026-08-23: the LIVE TD-edit capture
        // funnel (pointer-events drag-commit, line-nudge arrow keys) reached
        // through directly, so a suite can prove a construction line is refused
        // without having to run detection and stage a real drag.
        evaluateManualPomSample: (annotationId, options) => {
          const ann = state.annotations.find(a => a && a.id === annotationId);
          if (!ann) return null;
          return clone(evaluateManualPomSample(ann, options || {}));
        },
        getBuckets: () => clone(learningStore.buckets),
        getParamSamples: () => clone(learningStore.paramSamples || {}),
        getDetectionParams: () => clone(getLearnedDetectionParams()),
        summarize: () => clone(summarizeLearningStore()),
        clearBuckets: () => {
          learningStore = emptyLearningStore();
          saveLearningStore();
          clearManualLearnCache();
        },
        applyBiasTo: (anchors) => clone(applyLearningBiasToAnchors(clone(anchors))),
        evaluateSample: (ann) => {
          const result = evaluateManualPomSample(ann);
          // Surface the status + hash so a follow-up call can confirm
          // the same hash is now considered a duplicate.
          return {
            status: result.status,
            pom: result.pom || null,
            hash: result.hash || null,
            annHash: ann.learnSampleHash || null,
          };
        },
        evaluateAutoAppliedSample: (ann) => {
          const result = evaluateManualPomSample(ann, { allowAuto: true });
          return {
            status: result.status,
            pom: result.pom || null,
            hash: result.hash || null,
            annHash: ann.learnSampleHash || null,
          };
        },
      },
      // Meaning-aware learning test surface. scripts/meaning-tests.mjs
      // drives the (style, POM) catalog and the confirmation flow without
      // touching the DOM. Keeping it here so the meaning helpers stay
      // private to auto-drafts.js but a runner can still poke at them.
      meaning: {
        getStore: () => clone(meaningStore),
        clearAll: () => { clearMeaningStore('all'); },
        clearCurrent: () => { clearMeaningStore('current'); },
        setStyleId: (id) => { state.styleId = (id == null ? '' : String(id)); },
        getStyleId: () => state.styleId || '',
        currentStyleBucketId: () => currentStyleId(),
        resolve: (pom) => {
          const m = resolvePomMeaning(String(pom));
          return m ? clone(m) : null;
        },
        confirm: (pom, meaningId) => { confirmPomMeaning(String(pom), meaningId); },
        forget: (pom, styleId) => forgetPomMeaning(String(pom), styleId),
        listForStyle: (styleId) => clone(listConfirmedMeanings(styleId || currentStyleId())),
        summarize: () => clone(summarizeMeaningStore()),
        knownStyles: () => listKnownStyleIds(),
        catalog: () => clone(getAllCatalogMeanings()),
        addCustom: (label, startAnchor, endAnchor) => {
          const entry = addCustomMeaning(label, startAnchor, endAnchor);
          return entry ? clone(entry) : null;
        },
        usagePriority: (meaningId) => meaningUsagePriority(meaningId),
        suggest: (ann, limit) => {
          const image = pickImageForAnnotation(ann);
          if (!image) return [];
          return clone(rankCatalogForLine(image, ann, limit || 3));
        },
        // Run the full evaluate → commit cycle from a script. Returns the
        // eval result + the final ann.learnSampleHash so callers can
        // check whether the sample was actually recorded.
        commitChoice: (ann, meaningId) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoice(evalResult, meaningId);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            meaningId,
          };
        },
        commitCustom: (ann, label) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoiceCustom(evalResult, label);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            label,
          };
        },
        // Force-set a usage record so recency tests can synthesize an
        // "I confirmed this 100 days ago" history without waiting.
        seedUsage: (meaningId, count, lastUsedAt) => {
          if (!meaningId) return false;
          meaningStore.usage[meaningId] = {
            count: Number(count) || 0,
            lastUsedAt: Number(lastUsedAt) || 0,
          };
          saveMeaningStore();
          return true;
        },
        // Popover + canvas inspection — these reach into manual-tools.js
        // through the shared IIFE scope (the bundle wraps every source
        // part in the same closure). Keeping them here keeps the test
        // surface in one namespace.
        getCanvasTool: () => state.tool,
        setAppMode: (mode) => { setAppMode(mode === 'auto' ? 'auto' : 'manual'); },
      },
      // Style evidence test surface. Read-only Phase 1 store — scripts
      // can list/summarize/add/forget without touching the DOM. Kept
      // alongside learning and meaning so a test runner sees one
      // namespace per durable store.
      styleEvidence: {
        getStore: () => clone(styleEvidenceStore),
        list: (styleId) => clone(listStyleEvidence(styleId || currentStyleId())),
        summarize: (styleId) => clone(summarizeStyleEvidence(styleId || currentStyleId())),
        add: (styleId, record) => {
          const out = addStyleEvidence(styleId || currentStyleId(), record);
          return out ? clone(out) : null;
        },
        forget: (styleId, evidenceId) =>
          forgetStyleEvidence(styleId || currentStyleId(), evidenceId),
        clearAll: () => clearStyleEvidence('all'),
        clearStyle: (styleId) => clearStyleEvidence('style', styleId || currentStyleId()),
        knownStyles: () => listKnownEvidenceStyleIds(),
        // Phase 2 capture path. Tests can preview the candidate list and
        // commit it without driving the dialog — the save flow uses the
        // same two helpers under the hood.
        collectCandidates: (styleId) =>
          clone(collectStyleEvidenceCandidates(styleId)),
        commitCandidates: (styleId, candidates) =>
          commitStyleEvidenceCandidates(styleId || currentStyleId(), candidates || []),
        applyAbsenceToDrafts: (drafts) => {
          const copied = clone(drafts || []);
          applyStyleAbsenceEvidenceToDrafts(copied);
          return copied;
        },
        // Confirmed-evidence reuse: returns the drafts after the soft
        // blend toward the median of recent TD-confirmed lines for the
        // current style. Caller passes the source image so we can convert
        // normalized evidence into world coords.
        applyConfirmedToDrafts: (drafts, sourceImage) => {
          const copied = clone(drafts || []);
          applyStyleConfirmedEvidenceToDrafts(copied, sourceImage);
          return copied;
        },
        confirmedMedians: (styleId) => {
          const map = getConfirmedEvidenceMediansByPom(styleId || currentStyleId());
          const out = {};
          for (const [pom, value] of map.entries()) out[pom] = clone(value);
          return out;
        },
        // Test-only: push a synthetic annotation into state.annotations
        // so collectCandidates can see it. Used by the manual-confirmed
        // path test, which needs a real annotation in the project (not
        // just a synthetic ann passed through the meaning popover).
        // Returns the inserted annotation id.
        pushAnnotation: (ann) => {
          if (!ann || typeof ann !== 'object') return null;
          state.annotations.push(ann);
          return ann.id;
        },
        // Test-only: simulate a TD edit on one applied auto annotation
        // by id. Optional `patch` overrides specific endpoints in world
        // coordinates so the harness can verify normalization without
        // having to fake mouse interactions.
        simulateTdEdit: (annotationId, patch) => {
          const ann = state.annotations.find(a => a && a.id === annotationId);
          if (!ann) return null;
          ann.tdEdited = true;
          if (patch && typeof patch === 'object') {
            if (patch.start && typeof patch.start === 'object') {
              ann.start = { x: Number(patch.start.x), y: Number(patch.start.y) };
            }
            if (patch.end && typeof patch.end === 'object') {
              ann.end = { x: Number(patch.end.x), y: Number(patch.end.y) };
            }
          }
          return clone(ann);
        },
        simulateTdDelete: (annotationId) => {
          const ann = state.annotations.find(a => a && a.id === annotationId);
          if (!ann) return null;
          markDeletedAutoAnnotationForEvidence(ann);
          state.annotations = state.annotations.filter(a => a && a.id !== annotationId);
          if (state.selection.kind === 'annotation' && state.selection.id === annotationId) {
            state.selection = { kind: null, id: null };
          }
          return clone(ann);
        },
      },
    };
  }
