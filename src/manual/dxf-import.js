// US-104: DXF import — the BOARD layer. The pure parse layer (tokenizer,
// section scan, converters, INSERT resolution, decoding, marks, legacy
// grouping, placement transform, parseDxfDocument) moved to
// src/geometry/dxf-parse.js in US-124 Phase 5 so dxf-worker.js can run it
// off the main thread; this part keeps everything that mutates state:
// annotation building, the one-shot board mutation (importDxfText /
// dxfPlaceParsedDocument), the measure-session hand-off, the toast, and the
// pre-placement picker + worker hand-offs. Source part for app.js. Run
// `npm run build` after editing.

  // ---- Board mutation (real annotations, real state) -------------------------

  function dxfAnnotationFromSegment(seg, bounds, transform, groupId) {
    const T = (p) => applyDxfTransform(p, bounds, transform);
    const base = {
      id: state.idCounter++,
      seq: state.nextSequence, // never advanced — a Sketch Element spends no POM number (ADR 0058, matches createAnnotationFromTemplateMember)
      style: 'solid',
      color: 'black',
      arrowType: 'none',
      lineWidth: DEFAULT_LINE_WIDTH,
      lineTreatment: null,
      purpose: 'sketch-element',
      templateGroupId: groupId,
      midPoint: null,
      midHandleIn: null,
      midHandleOut: null,
      labelManual: false,
      text: null,
      value: null,
    };
    let ann;
    if (seg.kind === 'straight') {
      ann = Object.assign(base, { type: 'straight', start: T(seg.a), end: T(seg.b), control1: null, control2: null, points: [] });
    } else {
      ann = Object.assign(base, { type: 'curved', start: T(seg.p0), end: T(seg.p3), control1: T(seg.c1), control2: T(seg.c2), points: [] });
      ensureCurveControls(ann);
    }
    ann.label = computeDefaultLabelPosition(ann);
    return ann;
  }

  function dxfBucketLabel(key) {
    switch (key) {
      case 'unsupportedType': return 'unsupported type';
      case 'nonPlanar': return 'non-planar';
      case 'unsupportedFit': return 'unsupported polyline fit mode';
      case 'malformed': return 'malformed';
      default: return key;
    }
  }

  // (dxfFormatCount lives in the pure parse layer, src/geometry/dxf-parse.js —
  // parseDxfDocument's total-cap message uses it too, in the worker.)

  // Phase 3: the skip summary names what was skipped (quality-curve twins,
  // exact duplicates, points by ASTM class, annotation text) instead of
  // lumping a standard file's 6,949 POINT/TEXT entities into "unsupported
  // type". `stats`/`marks` are optional so a rejection toast (no stats) still
  // reads the plain buckets.
  function dxfBucketsToast(buckets, stats, marks) {
    const parts = [];
    if (stats && stats.dropped) {
      if (stats.dropped.qvTwin) parts.push(dxfFormatCount(stats.dropped.qvTwin) + ' quality-curve twin lines (ASTM 84/85/87)');
      if (stats.dropped.exact) parts.push(dxfFormatCount(stats.dropped.exact) + ' exact duplicate lines');
    }
    if (marks && marks.points && marks.points.total) {
      const by = marks.points.byClass || {};
      const detail = ['turn', 'curve', 'notch', 'drill', 'other'].filter(k => by[k]).map(k => dxfFormatCount(by[k]) + ' ' + k);
      parts.push(dxfFormatCount(marks.points.total) + ' points' + (detail.length ? ' (' + detail.join(' · ') + ')' : ''));
    }
    if (marks && marks.texts && marks.texts.total) parts.push(dxfFormatCount(marks.texts.total) + ' texts');
    if (!marks && buckets && buckets.nonGeometry) parts.push(dxfFormatCount(buckets.nonGeometry) + ' points/texts');
    for (const key of ['unsupportedType', 'nonPlanar', 'unsupportedFit', 'malformed']) {
      const count = buckets && buckets[key];
      if (count) parts.push(dxfFormatCount(count) + ' ' + dxfBucketLabel(key));
    }
    return parts.length ? 'Skipped: ' + parts.join(', ') + '.' : '';
  }

  // The one entry point the Tools-menu button / test hooks call. `rect`
  // defaults to the real board viewport; tests may pass a fake one.
  // `extra` (Phase 4): `{ excludeInstances }` chosen in the pre-placement
  // picker; the picker calls back into this same function with it.
  function importDxfText(text, rect, fileName, extra) {
    // Phase 3: the import options travel with the source so the native
    // measurement model (built below and again on every project reopen)
    // drops exactly the same twins — and, Phase 4, skips exactly the same
    // instances — the board did.
    const importOptions = {
      keepQualityCurves: !!(state.dxfImportOptions && state.dxfImportOptions.keepQualityCurves),
      excludeInstances: (extra && Array.isArray(extra.excludeInstances)) ? extra.excludeInstances.slice() : [],
      // Phase 6: always the current pipeline for a real import. `1` is a
      // test-only door (debug hook) that builds a board the way the pre-ADR-
      // 0091 code did, so the reopen-compatibility suite has a genuine v1
      // project to open without a checked-in binary fixture.
      pipelineVersion: (extra && extra.pipelineVersion === 1) ? 1 : DXF_PIPELINE_VERSION,
    };
    // Phase 5: route. A file with more top-level INSERTs than
    // DXF_PATTERN_BATCH_THRESHOLD (or a forced route) parses in dxf-worker.js;
    // the SAME parse functions run there, and the board mutation below runs
    // here once the whole result is back. `extra.afterWorkerFailure` marks
    // the in-thread retry after a worker failure so it cannot loop.
    const route = (extra && extra.afterWorkerFailure)
      ? { useWorker: false, reason: extra.afterWorkerFailure, estimate: extra.estimate == null ? null : extra.estimate }
      : (typeof dxfWorkerRoute === 'function' ? dxfWorkerRoute(text) : { useWorker: false, reason: 'no-worker-client', estimate: null });
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const elapsed = () => Math.round((((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started) * 10) / 10;
    if (route.useWorker) {
      const progress = openDxfImportProgressDialog(fileName, route.estimate, () => {
        dxfCancelActiveWorkerImport();
        dxfRecordImportExecution({ engine: 'worker', reason: 'cancelled', estimate: route.estimate, elapsedMs: elapsed(), fileName: fileName || null });
        showToast('DXF import cancelled — nothing was placed.');
      });
      dxfWorkerParse(text, importOptions, (stage, done, total) => progress.update(stage, done, total))
        .then((result) => {
          if (progress.isCancelled()) return;
          progress.close();
          const execution = { engine: 'worker', reason: 'ok', estimate: route.estimate, elapsedMs: elapsed(), progressEvents: result.progressEvents, fileName: fileName || null };
          dxfHandleParsedDocument(result.board, result.native, text, rect, fileName, importOptions, execution);
        })
        .catch((error) => {
          if (error && error.message === 'cancelled') return;
          progress.close();
          if (typeof dxfMarkWorkerBroken === 'function') dxfMarkWorkerBroken();
          const reason = 'worker-failed: ' + (error && error.message ? error.message : error);
          console.warn('DXF import: ' + reason + '; parsing on the main thread for the rest of this session.');
          importDxfText(text, rect, fileName, Object.assign({}, extra || {}, { afterWorkerFailure: reason, estimate: route.estimate }));
        });
      return { ok: false, reason: 'pending-worker', pending: true, estimate: route.estimate };
    }
    const parsed = parseDxfDocument(text, importOptions);
    const execution = { engine: 'main-thread', reason: route.reason, estimate: route.estimate, elapsedMs: elapsed(), fileName: fileName || null };
    return dxfHandleParsedDocument(parsed, null, text, rect, fileName, importOptions, execution);
  }

  // Shared by both routes: rejection handling (the total-cap picker, the
  // toast) and then the one board mutation. `precomputedNative` is the
  // worker's parseDxfNativeModel result; null on the synchronous path.
  function dxfHandleParsedDocument(parsed, precomputedNative, text, rect, fileName, importOptions, execution) {
    if (execution) dxfRecordImportExecution(execution);
    if (!parsed.ok) {
      if (parsed.reason === 'total-cap' && parsed.overCap && typeof openDxfPatternPickerDialog === 'function') {
        // Phase 4 (owner decision 3): never turn the TD away — let them pick
        // which placement instances (sizes / pieces) to place. The dialog
        // re-enters importDxfText with the exclusions; cancel leaves the
        // board untouched.
        openDxfPatternPickerDialog(parsed.overCap, {
          fileName,
          alreadyExcluded: importOptions.excludeInstances,
          onConfirm: (excludeInstances) => importDxfText(text, rect, fileName, { excludeInstances }),
          onCancel: () => showToast('DXF import cancelled — nothing was placed.'),
        });
        return { ok: false, reason: 'total-cap', pending: true, overCap: parsed.overCap, message: parsed.message };
      }
      const toastMsg = [parsed.message, dxfBucketsToast(parsed.buckets)].filter(Boolean).join(' ');
      showToast(toastMsg);
      return { ok: false, reason: parsed.reason, message: parsed.message, buckets: parsed.buckets || null };
    }
    return dxfPlaceParsedDocument(parsed, precomputedNative, text, rect, fileName, importOptions, execution);
  }

  // The one board mutation, identical for both routes: annotations, labels,
  // meta, selection, the native measure session, the durable source, one
  // history push, the toast, the panel.
  function dxfPlaceParsedDocument(parsed, precomputedNative, text, rect, fileName, importOptions, execution) {
    const viewportRect = rect || getViewportRect();
    const bounds = dxfBoundsOfSegments(parsed.pieces.flat());
    const transform = computeDxfPlacementTransform(bounds, viewportRect, undefined, state.zoom);
    const allNewIds = [];
    let firstId = null;
    // US-105: one anchor annotation id per piece (its first segment's), so
    // the measure session can detect a piece having been dragged since
    // import (see dxfMeasureCurrentPieceOffset, dxf-measure-session.js) by
    // comparing that annotation's CURRENT position against where import
    // originally placed it — the board annotations are the only thing that
    // actually tracks a later whole-piece move.
    const pieceFirstAnnotationIds = [];
    const pieceAnnotationIds = [];
    // ADR 0070: one groupId per piece, in the same order as parsed.pieces, so
    // the Pattern Pieces panel (opened below) can label each row from the
    // block name recorded against that piece's instance — falling back to a
    // plain per-position label when the piece came from instance 0 (direct
    // ENTITIES, no INSERT) or an unnamed block.
    const groupIds = [];
    for (let pieceIndex = 0; pieceIndex < parsed.pieces.length; pieceIndex += 1) {
      const piece = parsed.pieces[pieceIndex];
      const groupId = 'dxf-' + state.idCounter++;
      groupIds.push(groupId);
      const pieceAnns = piece.map(seg => dxfAnnotationFromSegment(seg, bounds, transform, groupId));
      pieceFirstAnnotationIds.push(pieceAnns.length ? pieceAnns[0].id : null);
      pieceAnnotationIds.push(pieceAnns.map(ann => ann.id));
      const instance = piece.length ? piece[0].instance : null;
      const blockName = instance != null ? parsed.instanceBlockNames.get(instance) : null;
      if (blockName) {
        if (!state.templateGroupLabels) state.templateGroupLabels = {};
        // The label stays the block NAME — dxfMeasureSizeToken (ADR 0084)
        // reads the size token after its last underscore. The parsed
        // PIECE NAME/SIZE/QUANTITY annotation and the classification live in
        // templateGroupMeta (Phase 3) for the Pattern Pieces panel to show.
        state.templateGroupLabels[groupId] = blockName;
      }
      const pattern = parsed.patterns && parsed.patterns[pieceIndex];
      // Block-scoped only: instance 0 is the file's direct ENTITIES, whose TEXT
      // is style-level (STYLE NAME, AUTHOR…) and would otherwise stamp every
      // legacy piece of a 3380-style file with the same "piece" annotation.
      const annotation = (instance != null && instance !== 0 && parsed.marks && parsed.marks.labelsByInstance)
        ? parsed.marks.labelsByInstance[instance] : null;
      if (pattern || annotation) {
        if (!state.templateGroupMeta) state.templateGroupMeta = {};
        state.templateGroupMeta[groupId] = {
          pieceName: annotation ? annotation.pieceName : null,
          size: annotation ? annotation.size : null,
          quantity: annotation ? annotation.quantity : null,
          kind: pattern ? pattern.kind : null,
          orphan: !!(pattern && pattern.orphan),
          boundaryLayer: pattern ? pattern.boundaryLayer : null,
          classCounts: pattern ? clone(pattern.classCounts) : {},
          notchChains: pattern ? pattern.notchChains : 0,
          dropped: pattern ? clone(pattern.dropped) : { exact: 0, qvTwin: 0 },
          totalSegCount: pattern ? pattern.totalSegCount : piece.length,
        };
      }
      // One sourceImageId per PIECE (not per segment), matching
      // createAnnotationFromTemplateMember's own convention: landing outside
      // every board image gives the piece no sourceImageId at all, which is
      // exactly the Scratch Area placement semantics already documented for
      // every other sketch-element source.
      const pieceBounds = dxfBoundsOfPoints(pieceAnns.flatMap(a => a.type === 'straight'
        ? [a.start, a.end] : [a.start, a.control1, a.control2, a.end]));
      const owner = (typeof bgTopImageAt === 'function')
        ? bgTopImageAt({ x: pieceBounds.x + pieceBounds.width / 2, y: pieceBounds.y + pieceBounds.height / 2 })
        : null;
      for (const ann of pieceAnns) {
        if (owner) ann.sourceImageId = owner.id;
        state.annotations.push(ann);
        allNewIds.push(ann.id);
        if (firstId == null) firstId = ann.id;
      }
    }
    state.selection = { kind: 'annotation', id: firstId };
    state.selectedAnnotationIds = allNewIds;
    state.templateGroupEditId = null;
    // US-105: (re)build the native-coordinate measure session from the SAME
    // text and the SAME bounds/transform just used for the board
    // annotations above, so Pattern Measure's overlay is pixel-aligned with
    // what actually got drawn. Reset first — opening another DXF must never
    // leave a prior session's measurements dangling over new geometry.
    resetDxfMeasureSession();
    const measureSession = startDxfMeasureSession(text, bounds, transform, pieceFirstAnnotationIds, importOptions, precomputedNative || null);
    // ADR 0088: only a successful native-model build becomes the durable,
    // newest measurable source. A failed native build remains fail-closed.
    if (measureSession) {
      setDxfPatternSource(makeDxfPatternSource(
        text, fileName, bounds, transform,
        pieceFirstAnnotationIds, pieceAnnotationIds, groupIds, importOptions
      ));
    } else {
      clearDxfPatternSource();
    }
    pushHistoryIfChanged();
    if (typeof updateUI === 'function') updateUI();
    if (typeof requestRender === 'function') requestRender();

    const pieceCount = parsed.pieces.length;
    const pieceWord = pieceCount === 1 ? 'piece' : 'pieces';
    const lineWord = allNewIds.length === 1 ? 'line' : 'lines';
    const skipParts = [dxfBucketsToast(parsed.buckets, parsed.stats, parsed.marks)];
    if (parsed.skippedOversizedPieces) {
      skipParts.push(parsed.skippedOversizedPieces + ' oversized piece'
        + (parsed.skippedOversizedPieces === 1 ? '' : 's') + ' (over ' + DXF_PER_PIECE_CAP + ' lines each).');
    }
    const skipMsg = skipParts.filter(Boolean).join(' ');
    // ADR 0073: a guessed unit rides on the import toast itself, not a
    // separate earlier toast — toast.js's fair-reading queue would swap a
    // separate warning away after ~900ms in favor of this success message.
    // Guarded: startDxfMeasureSession can fail and leave the session null
    // (it shows its own explanation in that case).
    const unitWarning = (measureSession && measureSession.source.unitSource !== 'dxf-header')
      ? ' Units assumed (in) — set them under Tools ▸ Pattern Measure if the file is mm/cm.'
      : '';
    showToast('Imported ' + pieceCount + ' ' + pieceWord + ' (' + allNewIds.length + ' ' + lineWord + ').'
      + (skipMsg ? ' ' + skipMsg : '') + unitWarning);
    // ADR 0070: a grading-nest file places every chosen size's piece at the
    // same board position (see ADR 0069's Context) — more than one piece
    // means the TD likely just imported an overlapping stack of sizes and
    // needs the Pattern Pieces panel to tell them apart, not a single
    // "1 piece" import where there is nothing to pick between.
    if (pieceCount > 1 && typeof openPatternPiecesPanel === 'function') openPatternPiecesPanel();
    return {
      ok: true,
      execution: execution || null,
      pieceCount,
      annotationCount: allNewIds.length,
      annotationIds: allNewIds.slice(),
      groupIds,
      buckets: parsed.buckets,
      skippedOversizedPieces: parsed.skippedOversizedPieces || 0,
    };
  }
