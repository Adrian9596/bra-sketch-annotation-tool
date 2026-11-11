// US-104: DXF import — the BOARD layer. The pure parse layer (tokenizer,
// section scan, converters, INSERT resolution, decoding, marks, legacy
// grouping, placement transform, dxfParseDocumentAndModel) lives in
// src/dxf/parse/ (split out in US-124 Phase 5; `npm run check` keeps it free
// of Board state); this part keeps everything that mutates state: annotation
// building, the one-shot board mutation (importDxfText /
// dxfPlaceParsedDocument), the measure-session hand-off and the toast.
// Source part for app.js. Run `npm run build` after editing.

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
      // US-127 / ADR 0102: named, not lumped into 'malformed' — a TD who sees
      // "838 zero-length lines" knows the file carries duplicated vertices,
      // which is a real quality signal about the CAD export.
      case 'degenerate': return 'zero-length lines';
      default: return key;
    }
  }

  // (dxfFormatCount lives in the pure parse layer, src/dxf/parse/dxf-parse.js —
  // dxfParseDocumentAndModel's total-cap message uses it too.)

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
    for (const key of ['degenerate', 'unsupportedType', 'nonPlanar', 'unsupportedFit', 'malformed']) {
      const count = buckets && buckets[key];
      if (count) parts.push(dxfFormatCount(count) + ' ' + dxfBucketLabel(key));
    }
    return parts.length ? 'Skipped: ' + parts.join(', ') + '.' : '';
  }

  // The one entry point File ▸ Open project… / test hooks call. `rect`
  // defaults to the real board viewport; tests may pass a fake one.
  // A rejected file (binary, corrupt, empty, or over DXF_TOTAL_OUTPUT_CAP)
  // changes nothing and says why in a toast.
  function importDxfText(text, rect, fileName) {
    // Phase 3: the import options travel with the source so the native
    // measurement model rebuilt on every project reopen drops exactly the
    // same twins the board did.
    const importOptions = {
      keepQualityCurves: !!(state.dxfImportOptions && state.dxfImportOptions.keepQualityCurves),
    };
    // ONE parse: the board document and the native measurement model are two
    // views of it (ADR 0105 follow-up), so Pattern Measure reads exactly the
    // pieces the board draws.
    const parseStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const both = dxfParseDocumentAndModel(text, importOptions);
    const parseDurationMs = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - parseStartedAt;
    const parsed = both.board;
    if (!parsed.ok) {
      const toastMsg = [parsed.message, dxfBucketsToast(parsed.buckets)].filter(Boolean).join(' ');
      showToast(toastMsg);
      return { ok: false, reason: parsed.reason, message: parsed.message, buckets: parsed.buckets || null };
    }
    return dxfPlaceParsedDocument(parsed, both.native, text, rect, fileName, importOptions, parseDurationMs);
  }

  // The one board mutation: annotations, labels, meta, selection, the native
  // measure session, the durable source, one history push, the toast, the
  // panel.
  function dxfPlaceParsedDocument(parsed, nativeModel, text, rect, fileName, importOptions, parseDurationMs) {
    const viewportRect = rect || getViewportRect();
    // US-127 / ADR 0102: frame the pieces that are the same order of size as
    // each other, not the raw extent of every coordinate in the file. See
    // dxfFitBoundsForPieces. An out-of-scale piece is still placed with the
    // same transform (it simply lands outside the viewport) and is flagged in
    // the Pattern Pieces panel and the import toast.
    const fit = dxfFitBoundsForPieces(parsed.pieces);
    const bounds = fit.bounds;
    const outOfScalePieces = new Set(fit.outlierPieces);
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
      const outOfScale = outOfScalePieces.has(pieceIndex);
      // Block-scoped only: instance 0 is the file's direct ENTITIES, whose TEXT
      // is style-level (STYLE NAME, AUTHOR…) and would otherwise stamp every
      // legacy piece of a 3380-style file with the same "piece" annotation.
      const annotation = (instance != null && instance !== 0 && parsed.marks && parsed.marks.labelsByInstance)
        ? parsed.marks.labelsByInstance[instance] : null;
      if (pattern || annotation || outOfScale) {
        if (!state.templateGroupMeta) state.templateGroupMeta = {};
        state.templateGroupMeta[groupId] = {
          // US-127: this piece is orders of magnitude bigger than the rest of
          // the file and was left out of the auto-fit, so the TD is told
          // which row to look at (and can Remove it) instead of hunting for
          // why the board looks wrong.
          outOfScale,
          pieceName: annotation ? annotation.pieceName : null,
          size: annotation ? annotation.size : null,
          quantity: annotation ? annotation.quantity : null,
          kind: pattern ? pattern.kind : null,
          orphan: !!(pattern && pattern.orphan),
          classCounts: pattern ? clone(pattern.classCounts) : {},
          notchChains: pattern ? pattern.notchChains : 0,
          dropped: pattern ? clone(pattern.dropped) : { exact: 0, qvTwin: 0 },
        };
      }
      // One sourceImageId per PIECE (not per segment), matching
      // createAnnotationFromTemplateMember's own convention: landing outside
      // every board image gives the piece no sourceImageId at all, which is
      // exactly the Scratch Area placement semantics already documented for
      // every other sketch-element source.
      const pieceBounds = dxfBoundsOfPoints(pieceAnns.flatMap(a => a.type === 'straight'
        ? [a.start, a.end] : [a.start, a.control1, a.control2, a.end]));
      const owner = bgTopImageAt({ x: pieceBounds.x + pieceBounds.width / 2, y: pieceBounds.y + pieceBounds.height / 2 });
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
    // parse and the SAME bounds/transform just used for the board
    // annotations above, so Pattern Measure's overlay is pixel-aligned with
    // what actually got drawn. Reset first — opening another DXF must never
    // leave a prior session's measurements dangling over new geometry. The
    // native model is the board's own pieces, so this cannot fail here.
    resetDxfMeasureSession();
    const measureSession = startDxfMeasureSession(nativeModel, bounds, transform, pieceFirstAnnotationIds, { parseDurationMs });
    // ADR 0088: the newest import is the durable, measurable source.
    setDxfPatternSource(makeDxfPatternSource(
      text, fileName, bounds, transform,
      pieceFirstAnnotationIds, pieceAnnotationIds, groupIds, importOptions
    ));
    pushHistoryIfChanged();
    updateUI();
    requestRender();

    const pieceCount = parsed.pieces.length;
    const pieceWord = pieceCount === 1 ? 'piece' : 'pieces';
    const lineWord = allNewIds.length === 1 ? 'line' : 'lines';
    const skipParts = [dxfBucketsToast(parsed.buckets, parsed.stats, parsed.marks)];
    if (fit.outlierPieces.length) {
      const n = fit.outlierPieces.length;
      skipParts.push(n === 1
        ? '1 piece is far out of scale with the rest of the file and sits outside the view — see the Pattern Pieces panel.'
        : n + ' pieces are far out of scale with the rest of the file and sit outside the view — see the Pattern Pieces panel.');
    }
    if (parsed.skippedOversizedPieces) {
      skipParts.push(parsed.skippedOversizedPieces + ' oversized piece'
        + (parsed.skippedOversizedPieces === 1 ? '' : 's') + ' (over ' + DXF_PER_PIECE_CAP + ' lines each).');
    }
    const skipMsg = skipParts.filter(Boolean).join(' ');
    // ADR 0073: a guessed unit rides on the import toast itself, not a
    // separate earlier toast — toast.js's fair-reading queue would swap a
    // separate warning away after ~900ms in favor of this success message.
    // US-126: three distinct things to say, not one. A declared unit says
    // nothing; an INFERRED one names what the geometry decided (so the TD can
    // disagree with a real claim rather than a silent default); only a file
    // whose size fits neither candidate still falls back to the old warning.
    const unitStatus = measureSession.source.unitSource;
    const unitWarning = unitStatus === 'dxf-header' ? ''
      : unitStatus === 'inferred-geometry'
        ? ' Units auto-scaled to ' + ((measureSession.source.unitDiagnostic
          && measureSession.source.unitDiagnostic.inferredKey) || 'in')
          + ' from piece size (file declares none) — change under Pattern ▸ File units if wrong.'
        : ' Units assumed (in) — set them under Pattern ▸ File units if the file is mm/cm.';
    showToast('Imported ' + pieceCount + ' ' + pieceWord + ' (' + allNewIds.length + ' ' + lineWord + ').'
      + (skipMsg ? ' ' + skipMsg : '') + unitWarning);
    // ADR 0070: a grading-nest file places every chosen size's piece at the
    // same board position (see ADR 0069's Context) — more than one piece
    // means the TD likely just imported an overlapping stack of sizes and
    // needs the Pattern Pieces panel to tell them apart, not a single
    // "1 piece" import where there is nothing to pick between.
    if (pieceCount > 1) openPatternPiecesPanel();
    return {
      ok: true,
      pieceCount,
      annotationCount: allNewIds.length,
      annotationIds: allNewIds.slice(),
      groupIds,
      buckets: parsed.buckets,
      skippedOversizedPieces: parsed.skippedOversizedPieces || 0,
    };
  }
