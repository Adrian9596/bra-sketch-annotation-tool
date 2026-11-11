// Debug / introspection API facade for offline tooling: the single
// window.__braAutoModeDebug object literal, wiring together functions
// defined throughout the rest of the bundle by name. Source part for
// app.js. Run `npm run build` after editing.
//
// The export builder this facade calls (buildCvDebugExport) lives in the
// sibling src/debug/debug-export.js, which loads before this file.
//
// window.__braAutoModeDebug is a by-NAME contract with the headless test
// suites (smoke, golden, invariants, contract, junction-tests, pipeline-tests,
// and others) — every key/method name here
// must stay character-for-character identical even as implementations move.

  if (typeof window !== 'undefined') {
    window.__braAutoModeDebug = {
      // Pure detection pipeline stages, exposed so each can be driven with
      // synthetic input and timed independently. Side effects (canvas reads,
      // state writes, toasts) live in runOfflineDetection, not here.
      pipeline: {
        pixelsToLegacyInkAnalysis: (pixels, w, h) => pixelsToLegacyInkAnalysis(pixels, w, h),
        detectSketchFromInkAnalysis: (cvAnalysis, opts) => detectSketchFromInkAnalysis(cvAnalysis, opts || {}),
        // Skeleton junction / endpoint / corner pass (Phase 1, plan 2).
        // Pure typed-array work — scripts/junction-tests.mjs drives it with
        // synthetic masks, no Chrome needed.
        detectJunctions: (mask, w, h, opts) => detectJunctions(mask, w, h, opts),
        // Derived-anchor cascade (Phase 3, plan 2). Pure — tests feed an
        // anchor list and assert dependents follow their primaries.
        deriveAnchors: (anchors, opts) => deriveAnchors(anchors, opts),
        seedAnchorsFromDetection: (detection, sourceImage) =>
          seedAnchorsFromDetection(detection, sourceImage),
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
      getAnchors: () => clone(state.autoMode.anchors),
      // Board viewport, so UI-level tests can convert an anchor's world
      // position (image rect + normalized anchor) into canvas screen
      // coordinates for synthetic mouse events.
      getViewport: () => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
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
        requestRender();
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
      // own syncAfterHiddenPomChange() (src/measurements/spec-visibility.js). While it
      // only re-rendered the panel it missed the toolbar sync a real × click
      // does — "Add point" stays armed on the line just hidden — so it quietly
      // stopped standing in for the button it exists to stand in for.
      setHiddenAnnIds: (ids) => {
        state.hiddenAnnIds = Array.isArray(ids) ? ids.slice() : [];
        syncAfterHiddenPomChange();
        return clone(state.hiddenAnnIds);
      },
      // Tier-0 library-value suggestions (scripts/suggestions-tests.mjs).
      // getEffectivePomSpec: the panel's effective spec for a POM (TD override
      //   if any, else the library suggestion) — proves the fallback + export
      //   path. setPomSpecOverride: set a TD override and re-render, returning
      //   the new effective spec so a test can assert override wins.
      getEffectivePomSpec: (key) => clone(getPomSpec(key)),
      setPomSpecOverride: (key, field, value) => {
        const changed = setPomSpec(key, field, value);
        if (changed) pushHistoryIfChanged();
        renderSpecPanel();
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
      getMeasurementAnnIds: () => measurementAnnotations().map(a => a.id),
      getLinePresets: () => clone(getLinePresets()),
      applyLinePreset: (id) => applyLinePreset(id),
      addLinePreset: (name) => clone(addLinePreset(name)),
      addLineTreatment: (name, recipe) => clone(addLineTreatment(name, recipe)),
      applyLineTreatmentToIds: (ids, recipe) => {
        const anns = (Array.isArray(ids) ? ids : []).map(id => getAnnotationById(id)).filter(Boolean);
        return applyTreatmentRecipeToAnnotations(recipe, anns);
      },
      getLineTreatmentMetrics: (id) => {
        const ann = getAnnotationById(id);
        const treatment = ann && normalizeLineTreatment(ann.lineTreatment);
        return treatment ? { scale: treatment.scale, layers: clone(scaledLineTreatmentLayers(treatment)) } : null;
      },
      // US-125 focused structural/editing seam. Production UI uses the same
      // functions through the Stitches menu and canvas; this surface lets the
      // suite assert exact geometry, fingerprints and persistence without
      // guessing screen coordinates for every model-only invariant.
      seamPath: {
        addTestAnnotation: raw => {
          if (!raw || !raw.start || !raw.end) return null;
          const ann = {
            id: raw.id != null ? raw.id : state.idCounter++,
            seq: null,
            type: raw.type === 'straight' ? 'straight' : 'curved',
            style: raw.style || 'solid',
            color: raw.color || 'black',
            arrowType: 'none',
            lineWidth: raw.lineWidth || 2,
            lineTreatment: raw.lineTreatment ? clone(raw.lineTreatment) : null,
            purpose: raw.purpose || null,
            start: clone(raw.start),
            end: clone(raw.end),
            control1: raw.control1 ? clone(raw.control1) : null,
            control2: raw.control2 ? clone(raw.control2) : null,
            points: clone(raw.points || []),
            label: raw.label ? clone(raw.label) : null,
            labelManual: false,
            text: raw.text != null ? String(raw.text) : null,
            value: null,
            templateGroupId: raw.templateGroupId || null,
            sourceMode: raw.sourceMode || null,
            tdApproved: !!raw.tdApproved,
            tdApprovalRequired: !raw.tdApproved,
            approvedAt: raw.tdApproved ? (raw.approvedAt || 'test-approved') : null,
          };
          if (ann.type === 'curved') ensureCurveControls(ann);
          if (!ann.label) ann.label = computeDefaultLabelPosition(ann);
          state.annotations.push(ann);
          setSelection('annotation', ann.id);
          pushHistoryIfChanged();
          return clone(ann);
        },
        promote: (id, options) => {
          const ann = getAnnotationById(id);
          if (!ann) return null;
          ensureSeamPathAnnotation(ann, options || {});
          pushHistoryIfChanged();
          return clone(ann);
        },
        eligibility: id => {
          const ann = getAnnotationById(id);
          if (!ann) return { ok: false, reason: 'missing' };
          setSelection('annotation', id);
          const result = seamPathBreakEligibility(ann);
          return { ok: result.ok, reason: result.reason };
        },
        setApproval: (id, approved = true) => {
          const ann = getAnnotationById(id);
          if (!ann) return null;
          ann.tdApproved = !!approved;
          ann.tdApprovalRequired = !approved;
          ann.approvedAt = approved ? 'test-approved' : null;
          pushHistoryIfChanged();
          return clone(ann);
        },
        insertBreak: (id, segIndex, t) => {
          const ann = getAnnotationById(id);
          if (!ann) return null;
          setSelection('annotation', id);
          const result = seamPathInsertTreatmentBreakAt(ann, Number(segIndex), Number(t));
          if (result.status === 'inserted') pushHistoryIfChanged();
          return { result: clone(result), annotation: clone(ann), selectionPart: state.selection.part || null };
        },
        applyPreset: (id, runId, presetId) => {
          const ann = getAnnotationById(id);
          if (!ann) return false;
          setSelection('annotation', id);
          state.selection.part = seamPathTreatmentPart(runId);
          return applyLinePreset(presetId);
        },
        removeBreak: (id, pointIndex, preferredSide) => {
          const ann = getAnnotationById(id);
          if (!ann) return false;
          setSelection('annotation', id);
          state.selection.part = 'point' + Number(pointIndex) + '.point';
          return removeSelectedTreatmentBreak(preferredSide);
        },
        movePoint: (id, pointIndex, dx, dy) => {
          const ann = getAnnotationById(id);
          const point = ann && (ann.points || [])[Number(pointIndex)];
          if (!point) return null;
          for (const field of ['point', 'handleIn', 'handleOut']) {
            point[field].x += Number(dx) || 0;
            point[field].y += Number(dy) || 0;
          }
          pushHistoryIfChanged();
          return clone(ann);
        },
        sample: id => {
          const ann = getAnnotationById(id);
          return ann ? clone(getAnnotationPolyline(ann, 256)) : null;
        },
        get: id => {
          const ann = getAnnotationById(id);
          return ann ? clone(ann.seamPath || null) : null;
        },
        historyDepth: () => state.history.past.length,
        undo: async () => { await undo(); return clone(state.annotations); },
        redo: async () => { await redo(); return clone(state.annotations); },
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
        resetLinePresetsToBuiltins();
      },
      importLinePresetsJson: (text) => importLinePresetsFromJson(text),
      // US-097 / ADR 0056: the shape-stamp library. getShapeStamps returns the
      // stored geometry so a suite can compare a placed line against the stamp
      // it came from; sampleAnnotationShape returns the SHAPE of any line,
      // normalized into its own bounding box, which is the only way to assert
      // "the curve that came back is the curve that was saved" independently of
      // where and how big it was placed.
      getShapeStamps: () => clone(getShapeStamps()),
      resetShapeStamps: () => {
        commitShapeStamps([]);
      },
      importShapeStampsJson: (text) => importShapeStampsFromJson(text),
      setActiveShapeStamp: (id) => {
        setActiveShapeStamp(id);
      },
      addTemplateFromAnnotationIds: (name, ids, options) => {
        const anns = (Array.isArray(ids) ? ids : []).map(id => getAnnotationById(id)).filter(Boolean);
        const template = shapeStampFromAnnotations(anns, name, options);
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
        categories: () => clone(libraryCategories()),
        setCategory: (id, category) => setShapeStampCategory(id, category),
        setTags: (id, tags) => setShapeStampTags(id, tags),
        setNotes: (id, notes) => setShapeStampNotes(id, notes),
        toggleFavorite: (id) => toggleShapeStampFavorite(id),
        duplicate: (id) => clone(duplicateShapeStamp(id)),
        // US-107: deleting a Template is a real dialog action (card menu ▸
        // Delete…, behind a window.confirm the Library dialog itself owns).
        // This hook isolates deleteShapeStamp's OWN model-layer behavior —
        // specifically, that deleting the currently ARMED stamp also clears
        // the arm and switches the tool away from 'stamp' — from the
        // confirm-dialog plumbing around it, which library-manager-check.mjs
        // already drives for real.
        deleteStamp: (id) => deleteShapeStamp(id),
        armForPlacement: (id, opts) => {
          armShapeStampForPlacement(id, opts);
        },
        defaultBoxAt: (id, world) => {
          const stamp = getShapeStampById(id);
          return stamp ? clone(defaultStampBoxAt(stamp, world)) : null;
        },
      },
      // US-104: DXF import. `parse` is the pure text -> pieces parser (no
      // board mutation), `computePlacement` the pure viewport-fit transform,
      // both exposed independently so unit-level cases (bulge signs, cap
      // boundaries, the auto-fit-box formula) don't need a real file input or
      // a real viewport. `importText` drives the real one-shot board mutation
      // the Tools-menu button itself calls.
      dxf: {
        parse: (text) => clone(parseDxfDocument(text)),
        computePlacement: (bounds, rect, centerWorld, zoom) => clone(computeDxfPlacementTransform(bounds, rect, centerWorld, zoom)),
        importText: (text, rect, fileName) => clone(importDxfText(text, rect, fileName)),
        // ADR 0091 follow-up: the byte decoder the real file input runs
        // (strict UTF-8 → $DWGCODEPAGE → GBK → windows-1252), so a suite or a
        // corpus scan can feed the parser EXACTLY the text the TD's pick
        // would, instead of fetch().text()'s lossy UTF-8.
        decodeBytes: (buffer) => decodeDxfBytes(buffer),
        // Phase 3: the import-time options the real toggle in the Pattern
        // Pieces panel writes, and a parse with explicit options (so a suite
        // can prove keepQualityCurves without touching state; `diagnostics:
        // true` adds the per-instance boundary diagnosis, stats.instances).
        getImportOptions: () => clone(state.dxfImportOptions || { keepQualityCurves: false }),
        parseWith: (text, opts) => clone(parseDxfDocument(text, opts || {})),
        parseNative: (text, opts) => clone(parseDxfNativeModel(text, opts || {})),
        source: () => (state.dxfPatternSource ? clone(state.dxfPatternSource) : null),
        // ADR 0070: the Pattern Pieces panel's pure state operations, exposed
        // independently of the real DOM panel (src/dxf/pattern-pieces-panel.js)
        // so a headless suite can assert the group-list/remove logic without
        // driving live checkbox clicks for every case.
        patternPieces: {
          groups: () => clone(patternPieceGroups()),
          // Phase 3: groupId -> { pieceName, size, quantity, kind, classCounts, dropped, … }.
          meta: () => clone(state.templateGroupMeta || {}),
          remove: (groupIds) => { removePatternPieceGroups(groupIds); },
          // ADR 0072.
          simplify: (groupId) => clone(simplifyPieceGroup(groupId)),
          isOpen: () => isPatternPiecesPanelOpen(),
          open: () => { openPatternPiecesPanel(); },
          close: () => { closePatternPiecesPanel(); },
        },
        // US-105: Pattern Measure. `measure.*` exposes the pure native
        // parser + geometry kernel independently of any board/UI state (unit
        // tests), plus read-only session getters an E2E suite can compare
        // against real pointer-driven results. Every mutating action
        // (create/delete/undo/redo) also has a real UI path — see
        // src/dxf/measure/dxf-measure-interaction.js / dxf-measure-panel.js — this
        // namespace never substitutes for driving that path in an
        // integration-level test, only for isolating the pure math.
        measure: {
          parseNative: (text) => clone(parseDxfNativeModel(text)),
          // Pure kernel primitives (src/dxf/parse/dxf-path-kernel.js), exposed
          // independently of any session/board state so a unit test can
          // drive exact synthetic segments (bulge signs, wraparound sweeps,
          // adaptive Bézier tolerance, degenerate input) without importing a
          // file at all.
          reasonCodes: () => clone(DXF_MEASURE_REASON),
          // The sentence a TD reads when the native model could not be built
          // (dxf-import.js folds it into the import toast).
          failureMessage: (nativeModel) => dxfMeasureFailureMessage(nativeModel),
          segmentLength: (seg) => dxfSegmentLength(seg),
          segmentFailureReason: (seg) => dxfSegmentFailureReason(seg),
          partialLength: (seg, t0, t1) => dxfPartialLength(seg, t0, t1),
          projectPointOnSegment: (point, seg) => clone(dxfProjectPointOnSegment(point, seg)),
          directDistance: (a, b) => dxfDirectDistance(a, b),
          // US-112: snap. `lineArcIntersections` is pure kernel math (like
          // directDistance above) — this file's header comment is explicit
          // that a MUTATING action (toggling a snap kind on/off) always goes
          // through its real UI path (#dxfMeasureSnapEndpointBtn etc.,
          // src/dxf/measure/dxf-measure-panel.js), never a debug shortcut, so
          // there is deliberately no setter here.
          lineArcIntersections: (lineSeg, arcSeg) => clone(dxfMeasureLineArcIntersections(lineSeg, arcSeg)),
          // Pure-function versions taking a bare `segments` array directly
          // (no DXF parse, no board import, no piece-grouping involved) —
          // same "isolate the math from any session/board state" contract as
          // parseNative/segmentLength above.
          buildSnapIndexForSegments: (segments, tolerance) => clone(dxfMeasureBuildPieceSnapIndex({ segments }, tolerance)),
          buildIntersectionsForSegments: (segments) => clone(dxfMeasureBuildPieceIntersections({ segments })),
          // US-114: every within-tolerance candidate, and the near-tie subset
          // dxfMeasureSnapEntityHitsForClick actually resolves a click
          // against — exposed separately so a test can assert both "how many
          // candidates exist at all" and "how many count as a genuine tie".
          snapCandidates: (world) => clone(dxfMeasureSnapCandidates(state.dxfMeasureSession, world)),
          snapTieCandidates: (world) => clone(dxfMeasureSnapTieCandidates(state.dxfMeasureSession, world)),
          snapEnabled: () => ({ endpoint: !!state.dxfMeasureSnapEndpoint, midpoint: !!state.dxfMeasureSnapMidpoint, intersection: !!state.dxfMeasureSnapIntersection }),
          // US-114: the Pattern-Measure-only size filter. Read-only by design
          // (see this file's own header on why a real UI action is never
          // exposed as a debug shortcut) — a test drives the real
          // #dxfMeasureSizeSelect element, same as every other real control.
          pieceSizeLabel: (pieceIndex) => (state.dxfMeasureSession
            ? dxfMeasurePieceSizeLabel(state.dxfMeasureSession, pieceIndex) : null),
          // ADR 0084: the size TOKEN the filter actually groups by (the part
          // of the block name after its last underscore) — what
          // availableSizeLabels lists and activeSizeLabel holds.
          pieceSizeToken: (pieceIndex) => (state.dxfMeasureSession
            ? dxfMeasurePieceSizeToken(state.dxfMeasureSession, pieceIndex) : null),
          availableSizeLabels: () => (state.dxfMeasureSession
            ? clone(dxfMeasureAvailableSizeLabels(state.dxfMeasureSession)) : []),
          enumerateRoutesRaw: (segments, refA, refB, tolerance) => clone(dxfEnumerateRoutes(segments, refA, refB, tolerance)),
          reverseRoute: (route) => clone(dxfReverseRoute(route)),
          routeLength: (route, segments) => dxfRouteLength(route, segments),
          routeAuthoredDirectionScore: (route, segments) => dxfRouteAuthoredDirectionScore(route, segments),
          resolveNativeToInch: (insunits) => clone(dxfResolveNativeToInch(insunits)),
          // US-126: the geometry-based unit inference, exposed pure so the
          // suite can prove the mm/in decision and the deliberate
          // "fits both / fits neither -> infer nothing" abstention without
          // going through a whole import.
          inferUnitFromGeometry: (pieces) => clone(dxfInferUnitFromGeometry(pieces)),
          unitStatus: () => (state.dxfMeasureSession
            ? clone(dxfMeasureUnitStatus(state.dxfMeasureSession)) : null),
          getSession: () => {
            const session = state.dxfMeasureSession;
            if (!session) return null;
            return {
              pieceCount: session.pieces.length,
              pieceSegmentCounts: session.pieces.map(p => p.segments.length),
              // Phase 6: how many native pieces found their board anchor —
              // `pieceCount` when the two parses agree on the piece list, 0
              // when they diverged (the reopen-compatibility failure mode).
              pieceAnchorsNonNull: (session.pieceAnchors || []).filter(Boolean).length,
              source: clone(session.source),
              // ADR 0073: the TD's unit override + the resolved status the
              // UI note/status chip renders from.
              unitOverride: session.unitOverride || null,
              unitStatus: clone(dxfMeasureUnitStatus(session)),
              topologyToleranceNative: session.topologyToleranceNative,
              measurementCount: session.measurements.length,
              measurements: clone(session.measurements),
              // US-111: seam-match pairs.
              seamPairs: clone(session.seamPairs || []),
              selectedMeasurementId: session.selectedMeasurementId,
              // RB-1/RB-2/RB-3: the full interaction object (minus function
              // fields like onResolved, which structuredClone-style `clone()`
              // cannot carry across anyway) — a test needs candidates/hits/
              // chosenIndex/truncated/preview to assert on, not just `type`.
              interaction: session.interaction ? clone(session.interaction) : null,
              historyPast: session.history.past.length,
              historyFuture: session.history.future.length,
              diagnostics: clone(session.diagnostics || {}),
              pieceBounds: clone(session.pieceBounds || []),
              // US-112: read-only, for diagnosing the hover-driven snap preview.
              hoverWorld: clone(session.hoverWorld),
              hoverAltKey: !!session.hoverAltKey,
              // US-114: the active-size filter + what's actually selectable.
              activeSizeLabel: session.activeSizeLabel || null,
              availableSizeLabels: clone(dxfMeasureAvailableSizeLabels(session)),
            };
          },
          pieceSegments: (pieceIndex) => {
            const session = state.dxfMeasureSession;
            const piece = session && session.pieces[pieceIndex];
            return piece ? clone(piece.segments) : null;
          },
          enumerateRoutes: (refA, refB) => clone(dxfMeasureEnumerateRoutes(state.dxfMeasureSession, refA, refB)),
          nativeToBoard: (point) => clone(dxfMeasureNativeToBoard(point, state.dxfMeasureSession)),
          nativeToBoardLive: (point, pieceIndex) => clone(dxfMeasureNativeToBoardLive(point, state.dxfMeasureSession, pieceIndex)),
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
          formatInches: (value) => dxfMeasureFormatInches(value),
          // US-111: seamPairStatus is pure (a {judged} object in, a status
          // string out) — exposed directly for exact-boundary unit testing,
          // same "isolate the math" contract as directDistance/segmentLength.
          seamPairStatus: (delta) => dxfMeasureSeamPairStatus(delta),
          seamPairPartnerId: (measurementId) => dxfMeasureSeamPairPartnerId(state.dxfMeasureSession, measurementId),
          seamPairDelta: (pairId) => {
            const session = state.dxfMeasureSession;
            const pair = session ? dxfMeasureGetSeamPair(session, pairId) : null;
            return pair ? clone(dxfMeasureSeamPairDelta(session, pair)) : null;
          },
          valueInches: (measurementId) => {
            const session = state.dxfMeasureSession;
            const m = session ? dxfMeasureGetMeasurement(session, measurementId) : null;
            return m ? dxfMeasureValueInches(session, m) : null;
          },
          // ADR 0073: the TD unit override — same function the real
          // #dxfMeasureUnitSelect change handler calls.
          setUnitOverride: (key) => dxfMeasureSetUnitOverride(state.dxfMeasureSession, key),
          undo: () => dxfMeasureUndo(),
          redo: () => dxfMeasureRedo(),
        },
      },
      sampleAnnotationShape: (annotationId, samples) => {
        const ann = state.annotations.find(a => a && a.id === annotationId);
        if (!ann) return null;
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
      exportLinePresetsJson: () => JSON.stringify(linePresetsEnvelope()),
      // Export image paths honor hidden POMs (scripts/export-hidden-tests.mjs).
      // getExportAnnIds: the exact applied-annotation set the export renderers
      //   (PDF / Copy Image / Excel embedded PNG) draw and crop from, so a test
      //   can assert a hidden POM is dropped without a real canvas.
      // exportBoardDataUrl: the rendered export board as a PNG data URL, for
      //   visual verification that a hidden line's pixels are gone.
      getExportAnnIds: () => visibleExportAnnotations().map(a => a.id),
      exportBoardDataUrl: () => {
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
      runAutoOnDataUrl: async (dataURL, opts) => {
        // Opt-in CV debug capture per-call. When opts.cvDebug is true, the
        // CV debug flag is flipped on before detection so the resulting
        // detection.debug payload is populated for the caller to inspect.
        if (opts && opts.cvDebug) {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null };
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
          cvDebug: clone(state.autoMode.cvDebug && state.autoMode.cvDebug.lastDebug),
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
      exportProject: () => clone(buildProjectSnapshot()),
      /* US-080: drives a MAIN PAGE sketch slot the way the upload/paste menu
         does, and hands back the RAW runtime state.mainPage — the one history
         clones — so a suite can prove the image bytes never land in it. */
      setMainPageSketch: async (variant, index, dataURL) => {
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
        flush: () => flushAutosave(),
        peek: () => {
          try { return localStorage.getItem('bra-sketch-autosave-v1'); }
          catch (_) { return null; }
        },
        clear: () => clearAutosave(),
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
        selection: {
          kind: state.selection.kind,
          id: state.selection.id != null ? state.selection.id : null,
          part: state.selection.part || null,
        },
        selectedAnnotationIds: getSelectedAnnotationIds().slice(),
        templateGroupEditId: state.templateGroupEditId || null,
        smartAlignEnabled: !!state.smartAlignEnabled,
        sketchMode: !!state.sketchMode,
        // US-104 round 8: so a suite can assert Set/Clear Scale actually
        // wrote/cleared calibration, not just that a button toggled.
        calibration: clone(state.calibration),
        activeStampId: state.activeStampId != null ? state.activeStampId : null,
        interaction: state.interaction ? { type: state.interaction.type } : null,
        treatmentBreakPending: clone(state.treatmentBreakPending),
        drawStyle: state.drawStyle,
        // US-103: the pending "next line" arrow default, and its POM-side
        // backup while Sketch Focus is on (applySketchModeVisual,
        // src/board/sketch-mode.js) — both session-only, neither persisted.
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
      // hands tests a compact JSON snapshot they can diff — only intermediate
      // detector signals.
      cv: {
        setEnabled: (on) => {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null };
          }
          state.autoMode.cvDebug.enabled = !!on;
          if (!state.autoMode.cvDebug.enabled) state.autoMode.cvDebug.lastDebug = null;
          return state.autoMode.cvDebug.enabled;
        },
        // Compact JSON snapshot — anchors + thresholds + detection params +
        // validation warnings + (when CV debug was on) the full intermediate
        // capture. Safe to call any time after Detect Sketch.
        exportDebug: (imageName) => clone(buildCvDebugExport(imageName)),
      },
      // Switch Auto/Manual mode through the same setAppMode the toolbar
      // toggle uses. Anything other than 'auto' means Manual.
      setAppMode: (mode) => { setAppMode(mode === 'auto' ? 'auto' : 'manual'); },
      // Test-only: push a synthetic annotation straight into state.annotations
      // (no history entry, no UI refresh). Returns the inserted id.
      pushAnnotation: (ann) => {
        if (!ann || typeof ann !== 'object') return null;
        state.annotations.push(ann);
        return ann.id;
      },
      // Test-only: drop one annotation by id (no history entry, no
      // deletedPomKeys bookkeeping), clearing the selection if it pointed at
      // it. Returns the removed annotation, or null.
      removeAnnotation: (annotationId) => {
        const ann = state.annotations.find(a => a && a.id === annotationId);
        if (!ann) return null;
        state.annotations = state.annotations.filter(a => a && a.id !== annotationId);
        if (state.selection.kind === 'annotation' && state.selection.id === annotationId) {
          state.selection = { kind: null, id: null };
        }
        return clone(ann);
      },
    };
  }
