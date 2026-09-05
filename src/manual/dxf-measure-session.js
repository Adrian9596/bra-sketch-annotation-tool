// US-105 / ADR 0062: DXF Pattern Measure — session lifecycle
// (state.dxfMeasureSession), the board<->native coordinate mapping, the
// pure "create/delete a measurement" builders, and the session's own mini
// undo stack. See state.js's dxfMeasureSession comment for why a separate
// stack is required (the global one restores whole snapshots that never
// contain this field, so it structurally cannot reach it).
// Source part for app.js. Run `npm run build` after editing.

  // ---- Board <-> native coordinate mapping -----------------------------------

  // The session stores the EXACT bounds/transform importDxfText already
  // computed for the visible sketch-element annotations (passed in at
  // startDxfMeasureSession, not recomputed here) so a measurement overlay is
  // guaranteed pixel-aligned with the DXF lines actually drawn on the board —
  // recomputing an independent bounds from the native (non-Bézier) model
  // would very slightly disagree with the Bézier-approximated bounds
  // importDxfText's own pipeline used for any piece containing an arc/bulge/
  // circle (the Bézier chunk's control points overshoot the true arc by a
  // fraction of a percent), which would show up as the highlighted route not
  // quite lining up with the black DXF geometry underneath it.
  //
  // That stored bounds/transform were computed over Y-FLIPPED coordinates
  // (dxf-import.js flips Y before placement, matching board/screen's Y-down
  // convention) while this session's native segments stay in the DXF's own
  // Y-up authored space (see dxf-native-parser.js's header comment) — so the
  // forward map flips first, the inverse map un-flips last. dxfFlipPointY is
  // its own inverse (pure negation), so no separate "unflip" function exists.
  function dxfMeasureNativeToBoard(nativePoint, session) {
    if (!session || !nativePoint) return null;
    return applyDxfTransform(dxfFlipPointY(nativePoint), session.transforms.bounds, session.transforms.placement);
  }

  function dxfMeasureBoardToNative(boardPoint, session) {
    if (!session || !boardPoint) return null;
    return dxfFlipPointY(invertDxfPlacementTransform(boardPoint, session.transforms.bounds, session.transforms.placement));
  }

  // ---- Per-piece "has this moved since import" tracking ---------------------
  //
  // US-104 lets a TD drag a whole placed piece (or the group any of its
  // segments belongs to) independently after import — a plain, expected
  // gesture, not an edit the "Source Geometry Immutability" rule needs to
  // block. But this session's transforms.bounds/placement are frozen at
  // import time, so a moved piece's LIVE board position is import position
  // + however far the TD dragged it. Rather than track every drag itself
  // (duplicating pointer-events.js's own move code), this compares one
  // anchor annotation's CURRENT position against where import originally
  // placed that same native point — the delta is the piece's whole-move
  // offset, whatever gesture produced it (drag, arrow-key nudge, undo/redo).
  // `pieceAnchors[i]` is null (offset always {0,0}) when dxf-import.js could
  // not pair native piece i with a board annotation id — see startDxfMeasureSession.
  function dxfMeasureCurrentPieceOffset(session, pieceIndex) {
    const anchor = session && session.pieceAnchors && session.pieceAnchors[pieceIndex];
    if (!anchor) return { x: 0, y: 0 };
    const ann = getAnnotationById(anchor.annotationId);
    if (!ann || !ann.start) return { x: 0, y: 0 };
    const importBoardPoint = dxfMeasureNativeToBoard(anchor.nativeStart, session);
    if (!importBoardPoint) return { x: 0, y: 0 };
    return { x: ann.start.x - importBoardPoint.x, y: ann.start.y - importBoardPoint.y };
  }

  // `precomputedOffset` (optional): dxfMeasureCurrentPieceOffset is O(n) in
  // `state.annotations` (getAnnotationById does a linear `.find()`) — cheap
  // for an occasional single-point call, but a real cost multiplier for a
  // caller invoking this once per SNAP POINT or per ROUTE SAMPLE within one
  // piece (thousands of calls, same piece, same offset every time). Found on
  // a real 108-piece/21211-annotation file: dxfMeasureSnapCandidates was
  // taking ~525-611ms per call — consistently, not a one-time cache miss —
  // because it recomputed this offset from scratch for every one of a
  // piece's endpoints/midpoints instead of once for the whole piece. Any
  // hot loop that already knows it's staying within one pieceIndex across
  // many calls should compute the offset ONCE (dxfMeasureCurrentPieceOffset
  // directly) and pass it here instead of paying that scan again per point.
  function dxfMeasureNativeToBoardLive(nativePoint, session, pieceIndex, precomputedOffset) {
    const base = dxfMeasureNativeToBoard(nativePoint, session);
    if (!base) return null;
    const offset = precomputedOffset || dxfMeasureCurrentPieceOffset(session, pieceIndex);
    return { x: base.x + offset.x, y: base.y + offset.y };
  }

  function dxfMeasureBoardToNativeLive(boardPoint, session, pieceIndex, precomputedOffset) {
    if (!boardPoint) return null;
    const offset = precomputedOffset || dxfMeasureCurrentPieceOffset(session, pieceIndex);
    return dxfMeasureBoardToNative({ x: boardPoint.x - offset.x, y: boardPoint.y - offset.y }, session);
  }

  // Resolve a direct-distance endpoint to native coordinates and, when the
  // click belongs unambiguously to one imported piece, retain that piece
  // attachment. This lets the overlay travel with a whole-piece display move
  // without ever changing the native coordinate used for the value.
  function dxfMeasureOutOfPathEndpointFromBoard(session, boardPoint, altBypass) {
    if (!session || !boardPoint) return null;
    if (!altBypass) {
      const snap = dxfMeasureSnapCandidate(session, boardPoint);
      if (snap) return { pieceIndex: snap.pieceIndex, native: clonePoint(snap.native) };
    }
    const nearHits = dxfMeasureHitTestNativeSegments(session, boardPoint, dxfMeasureToleranceWorld());
    const nearPieces = Array.from(new Set(nearHits.map(hit => hit.pieceIndex)));
    if (nearPieces.length === 1) {
      const pieceIndex = nearPieces[0];
      return { pieceIndex, native: dxfMeasureBoardToNativeLive(boardPoint, session, pieceIndex) };
    }
    const containing = [];
    session.pieceBounds.forEach((bounds, pieceIndex) => {
      if (!dxfMeasurePieceIsActive(session, pieceIndex)) return;
      const native = dxfMeasureBoardToNativeLive(boardPoint, session, pieceIndex);
      if (native && native.x >= bounds.x && native.x <= bounds.x + bounds.width
        && native.y >= bounds.y && native.y <= bounds.y + bounds.height) {
        containing.push({ pieceIndex, native, area: Math.max(1e-12, bounds.width * bounds.height) });
      }
    });
    if (containing.length === 1) return { pieceIndex: containing[0].pieceIndex, native: containing[0].native };
    if (containing.length > 1) {
      containing.sort((a, b) => a.area - b.area || a.pieceIndex - b.pieceIndex);
      if (containing[0].area < containing[1].area * 0.999999) {
        return { pieceIndex: containing[0].pieceIndex, native: containing[0].native };
      }
    }
    const native = dxfMeasureBoardToNative(boardPoint, session);
    return native ? { pieceIndex: null, native } : null;
  }

  // ---- Session construction / lifecycle --------------------------------------

  function makeDxfMeasureSession(nativeModel, bounds, transform, pieceFirstAnnotationIds) {
    // Pairs native piece i with the board annotation id dxf-import.js built
    // for that same piece's first segment, PROVIDED the two parses agree on
    // piece count — true whenever the file has no ARC/CIRCLE/bulge entity
    // (an arc is one native segment but N>=1 Bézier chunks in the board
    // model, which cannot shift which entities end up grouped into which
    // piece, but its slightly looser native bounding box, see
    // dxf-import.js's dxfSegmentPoints 'arc' case, could in principle change
    // a containment-merge decision at the margin — accepted for v1, flagged
    // here rather than silently assumed exact). A mismatch leaves every
    // pieceAnchors entry null, which dxfMeasureCurrentPieceOffset already
    // treats as "assume unmoved" (offset {0,0}) rather than throwing.
    const ids = Array.isArray(pieceFirstAnnotationIds) ? pieceFirstAnnotationIds : [];
    const pieceAnchors = nativeModel.pieces.length === ids.length
      ? nativeModel.pieces.map((piece, i) => (ids[i] == null || !piece.segments.length ? null : {
        annotationId: ids[i],
        nativeStart: dxfPointOnSegment(piece.segments[0], 0),
      }))
      : nativeModel.pieces.map(() => null);
    return {
      source: {
        unit: nativeModel.unit,
        unitSource: nativeModel.unitSource,
        unitDiagnostic: nativeModel.unitDiagnostic || null,
        insunits: nativeModel.insunits != null ? nativeModel.insunits : null,
        rejectedGeometry: clone(nativeModel.buckets || {}),
      },
      // RB-4: the topology merge tolerance used to build the Along Path
      // graph must be an ABSOLUTE native-unit distance whose worst-case
      // conversion to mm stays inside the kernel's own 0.01mm internal
      // budget — see dxfDefaultTopologyTolerance's comment in
      // dxf-path-kernel.js for why the old relative-diagonal tolerance
      // (borrowed from dxf-import.js's visual piece-grouping) was not
      // measurement-topology authority. 0.01mm expressed in native units:
      // native units per inch is 1/nativeModel.unit, and inches per mm is
      // 1/25.4, so native units per mm is 1/(25.4*nativeModel.unit).
      topologyToleranceNative: 0.01 / (25.4 * (nativeModel.unit || 1)),
      pieces: nativeModel.pieces,
      pieceBounds: nativeModel.pieces.map(piece => dxfBoundsOfSegments(piece.segments)),
      pieceAnchors,
      transforms: { bounds: clone(bounds), placement: clone(transform) },
      // ADR 0073: the TD's explicit "this file's native unit is …" choice
      // ('in' | 'mm' | 'cm', null = trust source.unit). Session-level display
      // setting, deliberately OUTSIDE the measure-undo fingerprint (see
      // dxfMeasureSnapshot) — undoing a measurement must not silently revert
      // a unit correction.
      unitOverride: null,
      measurements: [],
      // US-111: seam-match pairs — {id, aId, bId, ease}. A pair relates two
      // EXISTING along-path measurements; it owns no geometry of its own
      // (delta is always derived, see dxfMeasureSeamPairDelta) and each
      // measurement belongs to at most one pair (dxfMeasureCreateSeamPair
      // enforces this). MUST stay in dxfMeasureSnapshot/RestoreSnapshot below
      // — an undo that restores `measurements` but drops `seamPairs` would
      // leave a pair pointing at a since-reverted measurement id.
      seamPairs: [],
      nextSeamPairId: 1,
      interaction: null,
      selectedMeasurementId: null,
      pendingMode: 'along-path',
      placementArmed: false,
      nextMeasurementId: 1,
      history: { past: [], future: [] },
      diagnostics: { dragPreviewRecomputes: 0 },
      // US-112: per-piece snap point cache (endpoints/midpoints/lazy
      // intersections) — see src/manual/dxf-measure-snap.js. Derived purely
      // from `pieces`, which never changes after import, so this is safe to
      // build lazily and keep for the life of the session; never included in
      // dxfMeasureSnapshot (nothing here is TD-editable state).
      snapIndex: { byPiece: nativeModel.pieces.map(() => null) },
      // US-112: last pointer position while Pattern Measure is active, and
      // whether Alt/Option was held then — read only by the snap-hover
      // renderer (drawDxfMeasureSnapHover). Transient UI state, like
      // `interaction`; never part of the undo snapshot.
      hoverWorld: null,
      hoverAltKey: false,
      // US-114: Pattern-Measure-only active-size filter — see
      // dxfMeasurePieceIsActive below. Session-scoped (unlike the snap kind
      // toggles) because the choices themselves are file-specific; a fresh
      // import always starts unfiltered.
      activeSizeLabel: null,
    };
  }

  // ---- US-114: size filter (grading-nest disambiguation) --------------------
  //
  // A raw grading-nest import places every detected size's pieces at the
  // same board position (ADR 0069/0070, deliberately — it's what keeps
  // Pattern Pieces' "keep only these sizes" possible after the fact). That
  // overlap is exactly what makes Pattern Measure's own click/snap
  // resolution genuinely ambiguous between two different sizes' near-
  // identical points (confirmed on a real factory file: two different
  // sizes' matching vertices only 0.06 native units apart). Rather than
  // build US-110's own full import-time size picker (a separate, not-yet-
  // built high-risk story), this is a narrower, Pattern-Measure-only,
  // NON-destructive preference: scope every piece-search to one size at a
  // time, using the SAME block-name-per-piece data the Pattern Pieces panel
  // already shows — never a new naming heuristic, never re-derived.

  // The piece's own INSERT block name, exactly as the Pattern Pieces panel
  // shows it (mojibake and all) — reached via the SAME anchor-annotation
  // chain dxfMeasureCurrentPieceOffset above already uses. Null for a piece
  // with no anchor (dxf-import.js couldn't pair native/board piece counts)
  // or one that came from direct ENTITIES rather than an INSERT/BLOCK (no
  // block name to have).
  function dxfMeasurePieceSizeLabel(session, pieceIndex) {
    const anchor = session && session.pieceAnchors && session.pieceAnchors[pieceIndex];
    if (!anchor) return null;
    const ann = getAnnotationById(anchor.annotationId);
    const groupId = ann && ann.templateGroupId;
    if (!groupId) return null;
    return (state.templateGroupLabels && state.templateGroupLabels[groupId]) || null;
  }

  // Fraction of the SMALLER of the two boxes' own area that the two boxes'
  // intersection covers — 0 for no overlap, up to 1 for one box wholly
  // containing the other. A plain "do their bounding boxes touch at all"
  // test is too permissive: real multi-piece layouts often have two
  // unrelated pieces sharing/crossing a cut edge, which is a thin sliver of
  // incidental AABB overlap, not the SAME-position stacking a grading nest
  // creates (ADR 0069/0070 places every size at the same board position, so
  // a real size pair's bounds are almost entirely coincident, not merely
  // touching).
  function dxfMeasureBoundsOverlapRatio(a, b) {
    if (!a || !b) return 0;
    const ix0 = Math.max(a.x, b.x), iy0 = Math.max(a.y, b.y);
    const ix1 = Math.min(a.x + a.width, b.x + b.width), iy1 = Math.min(a.y + a.height, b.y + b.height);
    const iw = ix1 - ix0, iy = iy1 - iy0;
    if (iw <= 0 || iy <= 0) return 0;
    const smallerArea = Math.min(Math.max(a.width * a.height, 1e-12), Math.max(b.width * b.height, 1e-12));
    return (iw * iy) / smallerArea;
  }

  // How much of the smaller piece's bounds the overlap must cover to count
  // as "the same piece stacked at another size" rather than incidental
  // adjacency — see dxfMeasureBoundsOverlapRatio. A genuine same-position
  // grading pair (same anchor corner, one size uniformly larger) covers the
  // smaller piece's bounds almost completely; a real single-size factory
  // file's sliver of incidental edge-sharing between two UNRELATED pieces
  // measured as low as ~9% on a real fixture (see US-117) — comfortably
  // under this threshold either way.
  const DXF_MEASURE_SIZE_FILTER_OVERLAP_RATIO = 0.5;

  // ADR 0084: the SIZE a block name encodes, not the whole block name.
  // Every grading-nest export in the real corpus names its blocks
  // `<piece>_<size>` — `杯侧_S1` / `杯侧_M1` (3708.dxf), `11_22_M`
  // (BiancaBra), `K01543CW-SE0583-STRIKE COST-TAILONR_C34` (K01543CB) — so
  // the token after the LAST underscore is the size and everything before it
  // is which piece. Filtering on the whole name (US-114/117) hid every piece
  // whose name differed from the one selected — on a file grading TWO
  // different pieces at the same position (cup outer `..CW.._C34..C40` and
  // cup lining `..CZ.._C34..C40`, found 2026-09-02), selecting `CW_C34`
  // made `CZ_C34` unreachable by any click, snap or Alt-bypass, though it is
  // a different piece at the SAME size, not a size sibling. Grouping by the
  // size token keeps every `_C34` piece active together and hides only the
  // other sizes — which is what a control labeled "Size" means. A name with
  // no underscore (or nothing after it) is its own token, so a file whose
  // names carry no size structure behaves exactly as before. Because same
  // token ⊇ same name, this can only ever hide FEWER pieces than the
  // whole-name rule did — never more.
  function dxfMeasureSizeToken(label) {
    if (typeof label !== 'string' || !label) return null;
    const cut = label.lastIndexOf('_');
    if (cut < 0 || cut === label.length - 1) return label;
    return label.slice(cut + 1);
  }

  function dxfMeasurePieceSizeToken(session, pieceIndex) {
    return dxfMeasureSizeToken(dxfMeasurePieceSizeLabel(session, pieceIndex));
  }

  // The dropdown's option list: distinct size tokens (see
  // dxfMeasureSizeToken) across every piece, in first-seen (piece) order.
  // Empty when fewer than 2 distinct tokens exist — an unlabeled sketch, a
  // single-size file, or one whose pieces came from direct ENTITIES — since
  // there is nothing to filter between.
  //
  // Found 2026-09-01 testing a real single-size factory file (5 different
  // garment pieces, each its own INSERT, laid out side by side): 2+ distinct
  // block-name labels is NOT by itself evidence of a grading nest — the
  // filter's own justification above is specifically the SAME-position
  // overlap a grading nest creates. Two differently-labeled pieces whose
  // bounds don't SUBSTANTIALLY overlap are ordinary side-by-side garment
  // pieces (or two pieces that merely share/cross a cut edge), not size
  // variants stacked on each other; activating the filter for a file like
  // that would silently make the other pieces unclickable with nothing
  // genuinely ambiguous to resolve. So the filter now also requires at
  // least one pair of differently-labeled pieces whose bounds substantially
  // overlap before it activates at all.
  function dxfMeasureAvailableSizeLabels(session) {
    if (!session) return [];
    const seen = [];
    const piecesByLabel = new Map();
    session.pieces.forEach((piece, i) => {
      const label = dxfMeasurePieceSizeToken(session, i);
      if (!label) return;
      if (!seen.includes(label)) seen.push(label);
      if (!piecesByLabel.has(label)) piecesByLabel.set(label, []);
      piecesByLabel.get(label).push(i);
    });
    if (seen.length < 2) return [];
    const hasOverlappingPair = seen.some((labelA, ai) => seen.slice(ai + 1).some(labelB =>
      piecesByLabel.get(labelA).some(i => piecesByLabel.get(labelB).some(j =>
        dxfMeasureBoundsOverlapRatio(session.pieceBounds[i], session.pieceBounds[j]) >= DXF_MEASURE_SIZE_FILTER_OVERLAP_RATIO))));
    return hasOverlappingPair ? seen : [];
  }

  // The single gate every piece-search loop in this file and
  // dxf-measure-snap.js must call. `session.activeSizeLabel` null (the
  // default, and the only possible value when dxfMeasureAvailableSizeLabels
  // returns empty) means "every piece" — today's unfiltered behavior,
  // byte-for-byte unchanged. Otherwise it holds a size TOKEN (ADR 0084), and
  // a piece is active when its own token matches — every piece of that size,
  // whatever piece it is.
  function dxfMeasurePieceIsActive(session, pieceIndex) {
    if (!session || !session.activeSizeLabel) return true;
    return dxfMeasurePieceSizeToken(session, pieceIndex) === session.activeSizeLabel;
  }

  // A TD preference, not an edit — no history push (matches
  // smartAlignEnabled and the snap-kind toggles), but DOES drop any
  // in-flight placement: a pending choosing-entity/awaiting-b interaction
  // may hold refs into a piece the new filter just hid, and there is no
  // sane way to "continue" that pick once its own candidates are no longer
  // valid choices.
  function dxfMeasureSetActiveSizeLabel(session, label) {
    if (!session) return;
    session.activeSizeLabel = label || null;
    session.interaction = null;
    updateUI();
    requestRender();
  }

  // Called from importDxfText right after a successful import, with the
  // SAME bounds/transform it just computed for the board annotations (see
  // the mapping comment above for why) and the id of each piece's first
  // annotation (for later move-tracking, see dxfMeasureCurrentPieceOffset).
  // Parses the same text a second time, through the native-coordinate
  // adapter — a corrupt/rejected file here would already have been rejected
  // by parseDxfDocument first, so this is not expected to fail in practice,
  // but a failure here leaves the session null rather than half-built.
  // `importOptions` (Phase 3, ADR 0091): the board import's
  // `{ keepQualityCurves }`, forwarded to the native parser so both drop the
  // same twins. Omitted -> defaults (drop), which is also what a source saved
  // before this option existed means.
  // `precomputedNativeModel` (Phase 5): the worker already ran
  // parseDxfNativeModel on the same text with the same options; reuse it
  // instead of parsing a second time on the main thread. Omitted -> parse
  // here (the synchronous path and every project reopen).
  function startDxfMeasureSession(text, bounds, transform, pieceFirstAnnotationIds, importOptions, precomputedNativeModel) {
    const parseStartedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const nativeModel = precomputedNativeModel || parseDxfNativeModel(text, importOptions || {});
    const parseFinishedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    if (!nativeModel.ok) {
      // RB-5: the board-annotation import (importDxfText, US-104) already
      // succeeded by the time this runs — that atomic behavior must not be
      // disturbed — but a TD who just imported a DXF and reaches for Pattern
      // Measure deserves an explicit reason it is not available, rather than
      // a silently-missing Tools-menu feature.
      showToast('DXF imported, but Pattern Measure could not build a native measurement '
        + 'model for this file' + (nativeModel.message ? ' (' + nativeModel.message + ')' : '') + '.');
      state.dxfMeasureSession = null;
      return null;
    }
    state.dxfMeasureSession = makeDxfMeasureSession(nativeModel, bounds, transform, pieceFirstAnnotationIds);
    state.dxfMeasureSession.source.nativeParseDurationMs = Math.max(0, parseFinishedAt - parseStartedAt);
    state.dxfMeasureSession.source.nativeParserExecution = precomputedNativeModel ? 'worker-precomputed' : 'main-thread-measured';
    dxfMeasureSeedHistory();
    return state.dxfMeasureSession;
  }

  // Opening another DXF, loading a project, or resetting the board all call
  // this so no measurement overlay can outlive the geometry it describes.
  function resetDxfMeasureSession() {
    state.dxfMeasureSession = null;
  }

  // findings-dxf.md Finding 7: Pattern Pieces panel mutations (Remove
  // unchecked, Simplify) rewrite `state.annotations` — the board geometry the
  // session's `pieceAnchors`/board-group ids were built against — without
  // touching `state.dxfMeasureSession` at all. Left alone, that lets the
  // session point at deleted geometry (a removed piece stays hit-testable and
  // measurable at its old position) or silently detach from moved geometry
  // (a Simplify-replaced anchor annotation makes `dxfMeasureCurrentPieceOffset`
  // fall back to {0,0} instead of tracking the piece). Per the cross-cutting
  // note this story left open: either remap the session or invalidate it —
  // remapping would need every piece's native segments re-associated with
  // whatever new/renumbered annotation ids resulted from an arbitrary,
  // TD-driven structural edit, which is exactly the kind of ad hoc
  // re-derivation ADR 0062 keeps this session simple by avoiding. Invalidating
  // is the safe choice: a fresh DXF import (or Undo, which restores the prior
  // annotations) is already how a TD gets a session in the first place, so
  // losing it here costs a re-import, not lost work.
  function dxfMeasureInvalidateOnPieceEdit() {
    if (!state.dxfMeasureSession && !state.dxfPatternSource) return;
    invalidateDxfPatternSource(
      'Pattern Measure cleared — this piece edit changed the board geometry it was reading. Reopen the DXF to measure again.'
    );
  }

  // ---- Hit-testing a board click against native geometry --------------------

  // Finds the nearest native segment, across every piece, to a board-space
  // click — the "Along Path" endpoint-placement hit test. `toleranceWorld`
  // is in WORLD units (i.e. already divided by state.zoom by the caller, the
  // same convention every other board hit-test in this codebase uses).
  // Converts the tolerance into each piece's OWN native scale (dividing by
  // the placement transform's scale, since flip+scale is uniform) rather
  // than converting the click point once globally, so a per-piece live
  // offset (see dxfMeasureCurrentPieceOffset) is applied before projecting.
  // Returns null when nothing is within tolerance — never "the closest
  // thing regardless of distance," matching "do not silently select the
  // closest entity" for the multi-candidate case (candidate cycling is the
  // interaction layer's job; this returns every candidate within tolerance,
  // nearest first).
  function dxfMeasureHitTestNativeSegments(session, boardPoint, toleranceWorld) {
    if (!session || !boardPoint) return [];
    const scale = session.transforms.placement.scale || 1;
    const nativeTolerance = toleranceWorld / Math.max(1e-9, scale);
    const hits = [];
    session.pieces.forEach((piece, pieceIndex) => {
      if (!dxfMeasurePieceIsActive(session, pieceIndex)) return;
      const nativePoint = dxfMeasureBoardToNativeLive(boardPoint, session, pieceIndex);
      if (!nativePoint) return;
      piece.segments.forEach((seg, segIndexInPiece) => {
        const proj = dxfProjectPointOnSegment(nativePoint, seg);
        if (proj && proj.distance <= nativeTolerance) {
          hits.push({ pieceIndex, segIndexInPiece, t: proj.t, distance: proj.distance * scale });
        }
      });
    });
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  // ---- Route lookup (piece-scoped — see file header of dxf-path-kernel.js) --

  // A point-on-path reference is {pieceIndex, segIndexInPiece, t}. Along Path
  // requires A and B to resolve to the SAME connected path graph; enforcing
  // "same piece" here, before ever calling the kernel, is what makes that
  // check meaningful — the kernel's own segIndex addressing is only valid
  // relative to one shared segments array, so two refs naming different
  // pieces cannot be compared by index at all. A shared piece that is
  // ITSELF a containment-merged union of disconnected sub-parts (e.g. an
  // outline plus a disjoint internal grainline) still correctly resolves to
  // NO_CONNECTED_PATH — the kernel's own graph search finds that on its own.
  function dxfMeasureEnumerateRoutes(session, refA, refB) {
    if (!session || !refA || !refB || refA.pieceIndex !== refB.pieceIndex) {
      return { ok: false, reason: DXF_MEASURE_REASON.NO_CONNECTED_PATH, routes: [], truncated: false };
    }
    const piece = session.pieces[refA.pieceIndex];
    if (!piece) return { ok: false, reason: DXF_MEASURE_REASON.NO_CONNECTED_PATH, routes: [], truncated: false };
    return dxfEnumerateRoutes(piece.segments,
      { segIndex: refA.segIndexInPiece, t: refA.t },
      { segIndex: refB.segIndexInPiece, t: refB.t },
      session.topologyToleranceNative);
  }

  // ---- Pure measurement builders ---------------------------------------------

  // RB-1: `route` is stored EXACTLY as dxfMeasureEnumerateRoutes returned it
  // — a canonical A-to-B traversal — regardless of `direction`. Direction is
  // a pure ARROW/rendering flag (see render-dxf-measurements.js), never
  // baked into which end of the stored route is "first"; that decoupling is
  // what makes "A/B pixel locations remain unchanged when direction
  // changes" and "no route direction depends on DFS array order" hold by
  // construction rather than by convention. `routeCandidateIndex` is the
  // TD's actual chosen candidate (0-based, into the SAME canonical
  // enumeration a fresh dxfMeasureEnumerateRoutes(session,a,b) call would
  // return) — stored verbatim, never re-derived from `direction` or from any
  // "index === 1 means reverse" assumption.
  function dxfMeasureCreateAlongPathMeasurement(session, refA, refB, route, direction, routeCandidateIndex, routeCandidateCount) {
    if (!session || !route || !Array.isArray(route.steps) || !route.steps.length || !(route.length > 0)) return null;
    const pieceA = session.pieces[refA.pieceIndex];
    const pieceB = session.pieces[refB.pieceIndex];
    const segA = pieceA && pieceA.segments[refA.segIndexInPiece];
    const segB = pieceB && pieceB.segments[refB.segIndexInPiece];
    if (!segA || !segB) return null;
    const id = session.nextMeasurementId;
    session.nextMeasurementId += 1;
    const measurement = {
      id,
      mode: 'along-path',
      direction: direction === 'reverse' ? 'reverse' : 'forward',
      a: { pieceIndex: refA.pieceIndex, segIndexInPiece: refA.segIndexInPiece, t: refA.t, native: dxfPointOnSegment(segA, refA.t) },
      b: { pieceIndex: refB.pieceIndex, segIndexInPiece: refB.segIndexInPiece, t: refB.t, native: dxfPointOnSegment(segB, refB.t) },
      route,
      routeCandidateIndex: routeCandidateIndex || 0,
      routeCandidateCount: routeCandidateCount || 1,
      labelOffset: null,
      // US-113: TD-given display name for the measurements list panel; null
      // means "show the default M{id} label". Lives on the measurement
      // record itself, so the existing snapshot/undo machinery below covers
      // renames for free — no separate history plumbing needed.
      name: null,
    };
    session.measurements.push(measurement);
    dxfMeasurePushHistoryIfChanged();
    return measurement;
  }

  function dxfMeasureCreateOutOfPathMeasurement(session, endpointA, endpointB) {
    if (!session || !endpointA || !endpointB) return null;
    const normalizedA = endpointA.native ? endpointA : { pieceIndex: null, native: endpointA };
    const normalizedB = endpointB.native ? endpointB : { pieceIndex: null, native: endpointB };
    if (!normalizedA.native || !normalizedB.native) return null;
    const id = session.nextMeasurementId;
    session.nextMeasurementId += 1;
    const measurement = {
      id,
      mode: 'out-of-path',
      direction: 'forward',
      a: { pieceIndex: normalizedA.pieceIndex == null ? null : normalizedA.pieceIndex, segIndexInPiece: null, t: null, native: clonePoint(normalizedA.native) },
      b: { pieceIndex: normalizedB.pieceIndex == null ? null : normalizedB.pieceIndex, segIndexInPiece: null, t: null, native: clonePoint(normalizedB.native) },
      route: null,
      labelOffset: null,
      name: null,
    };
    session.measurements.push(measurement);
    dxfMeasurePushHistoryIfChanged();
    return measurement;
  }

  function dxfMeasureGetMeasurement(session, id) {
    if (!session) return null;
    return session.measurements.find(m => m.id === id) || null;
  }

  function dxfMeasureDeleteMeasurement(session, id) {
    if (!session) return false;
    const idx = session.measurements.findIndex(m => m.id === id);
    if (idx === -1) return false;
    session.measurements.splice(idx, 1);
    if (session.selectedMeasurementId === id) session.selectedMeasurementId = null;
    // US-111: a seam pair cannot outlive either of its two members — the
    // other measurement stays, just no longer matched to anything.
    const pairIdx = session.seamPairs.findIndex(p => p.aId === id || p.bId === id);
    if (pairIdx !== -1) session.seamPairs.splice(pairIdx, 1);
    dxfMeasurePushHistoryIfChanged();
    return true;
  }

  // ---- US-111: seam-match pairs -----------------------------------------------

  function dxfMeasureFindSeamPairId(session, measurementId) {
    if (!session || measurementId == null) return null;
    const pair = session.seamPairs.find(p => p.aId === measurementId || p.bId === measurementId);
    return pair ? pair.id : null;
  }

  function dxfMeasureGetSeamPair(session, pairId) {
    if (!session || pairId == null) return null;
    return session.seamPairs.find(p => p.id === pairId) || null;
  }

  function dxfMeasureSeamPairPartnerId(session, measurementId) {
    if (!session || measurementId == null) return null;
    const pair = session.seamPairs.find(p => p.aId === measurementId || p.bId === measurementId);
    if (!pair) return null;
    return pair.aId === measurementId ? pair.bId : pair.aId;
  }

  // Only two UNPAIRED Along Path measurements can be matched — Out of Path
  // has no "route" a seam-length comparison is measuring, and one pair per
  // measurement keeps "the other side of THIS seam" unambiguous (a TD who
  // wants a different partner unlinks first, an explicit action, rather than
  // silently reassigning).
  function dxfMeasureCreateSeamPair(session, aId, bId) {
    if (!session || aId == null || bId == null || aId === bId) return null;
    const a = dxfMeasureGetMeasurement(session, aId);
    const b = dxfMeasureGetMeasurement(session, bId);
    if (!a || !b || a.mode !== 'along-path' || b.mode !== 'along-path') return null;
    if (dxfMeasureFindSeamPairId(session, aId) != null || dxfMeasureFindSeamPairId(session, bId) != null) return null;
    const pair = { id: session.nextSeamPairId, aId, bId, ease: 0 };
    session.nextSeamPairId += 1;
    session.seamPairs.push(pair);
    dxfMeasurePushHistoryIfChanged();
    return pair;
  }

  // Removes the MATCH, not either measurement — "unlink" reads as undoing a
  // relationship, not a delete, so it stays a separate action from ✕.
  function dxfMeasureDeleteSeamPair(session, pairId) {
    if (!session) return false;
    const idx = session.seamPairs.findIndex(p => p.id === pairId);
    if (idx === -1) return false;
    session.seamPairs.splice(idx, 1);
    dxfMeasurePushHistoryIfChanged();
    return true;
  }

  function dxfMeasureSetSeamEase(session, pairId, ease) {
    const pair = dxfMeasureGetSeamPair(session, pairId);
    if (!pair) return false;
    const next = Number.isFinite(ease) ? ease : 0;
    if (pair.ease === next) return false;
    pair.ease = next;
    dxfMeasurePushHistoryIfChanged();
    return true;
  }

  // TD-confirmed thresholds (2026-09-01): absolute inches on the 1/16" grid
  // this tool already displays fractions on (US-048), not a percentage of
  // seam length.
  const DXF_SEAM_MATCH_THRESHOLD_IN = 1 / 16;
  const DXF_SEAM_REVIEW_THRESHOLD_IN = 3 / 16;

  // Derived, NEVER stored — recomputed from each member's CURRENT value every
  // call, so dragging an endpoint (or Undo/Redo, or a unit-override change)
  // updates the delta the same frame the member's own value updates, with no
  // separate cache to keep in sync. `raw` is signed (A minus B); `judged` is
  // what the threshold actually reads — the plan's agreed formula
  // |lenA - lenB - ease|, i.e. how far the ACTUAL difference deviates from
  // the EXPECTED one, not the unsigned raw delta itself (a seam with 0.25"
  // of intentional cup ease reading exactly 0.25" off judges as a perfect
  // match, not a quarter-inch mismatch).
  function dxfMeasureSeamPairDelta(session, pair) {
    if (!session || !pair) return null;
    const a = dxfMeasureGetMeasurement(session, pair.aId);
    const b = dxfMeasureGetMeasurement(session, pair.bId);
    if (!a || !b) return null;
    const va = dxfMeasureValueInches(session, a);
    const vb = dxfMeasureValueInches(session, b);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return null;
    const raw = va - vb;
    return { a: va, b: vb, raw, judged: Math.abs(raw - (pair.ease || 0)) };
  }

  function dxfMeasureSeamPairStatus(delta) {
    if (!delta) return 'unknown';
    if (delta.judged <= DXF_SEAM_MATCH_THRESHOLD_IN) return 'match';
    if (delta.judged <= DXF_SEAM_REVIEW_THRESHOLD_IN) return 'review';
    return 'mismatch';
  }

  // US-113: TD-given display name, shown by the measurements list panel
  // instead of the default "M{id}". Empty/whitespace-only clears back to the
  // default rather than storing a blank string, so the panel's "M{id}"
  // fallback (dxfMeasurementDisplayName) is the only place that formats the
  // unnamed case. Returns false (no history push, no re-render) when the
  // trimmed name is unchanged, so an in/out rename with no real edit does not
  // manufacture a no-op undo step.
  function dxfMeasureRenameMeasurement(session, id, name) {
    const measurement = session && dxfMeasureGetMeasurement(session, id);
    if (!measurement) return false;
    const next = (name || '').trim() || null;
    if (measurement.name === next) return false;
    measurement.name = next;
    dxfMeasurePushHistoryIfChanged();
    return true;
  }

  // US-113: bulk-delete every measurement in ONE history step, so Cmd+Z
  // undoes the whole clear at once rather than one measurement at a time —
  // matching "Clear All" reading as a single action, not N deletes in a
  // trenchcoat. No confirm dialog: deleting a single measurement via the
  // panel's own ✕ has none either, and this is exactly as undo-able.
  function dxfMeasureClearAllMeasurements(session) {
    if (!session || !session.measurements.length) return 0;
    const count = session.measurements.length;
    session.measurements = [];
    session.seamPairs = []; // US-111: no pair can outlive its measurements
    session.selectedMeasurementId = null;
    dxfMeasurePushHistoryIfChanged();
    return count;
  }

  // RB-3: COMMITS a fully-resolved endpoint move in one shot — never called
  // with a still-ambiguous or still-invalid candidate. The interaction layer
  // (dxf-measure-interaction.js) owns projecting the pointer, hit-testing
  // entities, and enumerating routes against a SCRATCH copy while the drag is
  // in progress (session.interaction.preview); this function only ever
  // mutates the real `measurement` once that scratch work has resolved to
  // exactly one entity and exactly one route (or the TD has explicitly
  // confirmed one from an ambiguous set) — matching "endpoint drag is
  // transactional... commit exactly once on pointer-up/confirmation." `route`
  // is the canonical A-to-B route already returned by
  // dxfMeasureEnumerateRoutes for the NEW (refA/refB) pair — this function
  // does no enumeration of its own, so it cannot itself introduce a stale or
  // re-derived candidate.
  function dxfMeasureCommitEndpoint(session, measurement, which, ref, route, routeCandidateIndex, routeCandidateCount) {
    if (!session || !measurement) return false;
    const key = which === 'a' ? 'a' : 'b';
    if (measurement.mode === 'out-of-path') {
      measurement[key] = {
        pieceIndex: ref.pieceIndex == null ? null : ref.pieceIndex,
        segIndexInPiece: null,
        t: null,
        native: clonePoint(ref.native),
      };
      return true;
    }
    const piece = session.pieces[ref.pieceIndex];
    const seg = piece && piece.segments[ref.segIndexInPiece];
    if (!seg) return false;
    measurement[key] = { pieceIndex: ref.pieceIndex, segIndexInPiece: ref.segIndexInPiece, t: ref.t, native: dxfPointOnSegment(seg, ref.t) };
    measurement.route = route;
    measurement.routeCandidateIndex = routeCandidateIndex || 0;
    measurement.routeCandidateCount = routeCandidateCount || 1;
    return true;
  }

  // ---- Units (ADR 0073) --------------------------------------------------------

  // Real factory files routinely omit $INSUNITS (or set it to 0, "Unitless")
  // while being authored in mm — the parser's inch default is a GUESS
  // (findings-dxf.md Finding 2). These three functions make that guess
  // visible and correctable: the effective native→inch factor is the TD's
  // explicit override when set, else the parser's resolution.
  function dxfMeasureUnitKeyFactor(key) {
    if (key === 'mm') return 1 / 25.4;
    if (key === 'cm') return 1 / 2.54;
    if (key === 'in') return 1;
    return null;
  }

  function dxfMeasureEffectiveUnitFactor(session) {
    if (!session) return null;
    const overrideFactor = dxfMeasureUnitKeyFactor(session.unitOverride);
    return overrideFactor != null ? overrideFactor : session.source.unit;
  }

  // Changing the unit changes the RB-4 topology tolerance too (0.01mm
  // expressed in native units — see makeDxfMeasureSession) so future route
  // enumeration stays inside the kernel's mm budget under the corrected
  // unit. Existing measurements need no touch: values are converted on
  // demand from stored native lengths, so every displayed number updates on
  // the next paint.
  function dxfMeasureSetUnitOverride(session, key) {
    if (!session) return false;
    const normalized = dxfMeasureUnitKeyFactor(key) != null ? key : null;
    if (session.unitOverride === normalized) return false;
    session.unitOverride = normalized;
    session.topologyToleranceNative = 0.01 / (25.4 * (dxfMeasureEffectiveUnitFactor(session) || 1));
    if (typeof updateUI === 'function') updateUI();
    if (typeof requestRender === 'function') requestRender();
    return true;
  }

  // The unit key + provenance the UI shows. Three DISTINCT non-override
  // states, per the kernel's RB-4 comment: "no header" (default-inch) and
  // "explicit but unrecognized code" (unsupported-explicit-unit) must never
  // be folded into one "assumed" — the second names the code so a TD can
  // tell the file DID declare something.
  function dxfMeasureUnitStatus(session) {
    if (!session) return null;
    if (session.unitOverride) {
      return { key: session.unitOverride, provenance: 'set by you' };
    }
    const source = session.source;
    if (source.unitSource === 'dxf-header') {
      // Name the declared unit by its $INSUNITS code; the header can
      // legitimately declare units the override select doesn't offer
      // (ft, m, US survey ft), so this maps the code, not the option list.
      const names = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 21: 'us-ft' };
      return { key: names[source.insunits] || 'in', provenance: 'from file' };
    }
    // US-126: a fourth non-override state. The file declared nothing usable,
    // but its own piece geometry fits exactly one supported unit, so the value
    // is scaled from evidence rather than from the locked default-inch guess.
    // Named separately from 'from file' because it IS weaker than a
    // declaration, and separately from 'assumed' because it is stronger than
    // one — the TD override still overrules it.
    if (source.unitSource === 'inferred-geometry') {
      const diagnostic = source.unitDiagnostic || {};
      const key = diagnostic.inferredKey || 'in';
      const declared = diagnostic.unsupportedDeclaredCode;
      return {
        key,
        provenance: declared != null
          ? 'auto-scaled from piece size — file declares unsupported unit code ' + declared
          : 'auto-scaled from piece size — file didn\'t declare units',
      };
    }
    if (source.unitSource === 'unsupported-explicit-unit') {
      const code = source.unitDiagnostic && source.unitDiagnostic.code;
      return { key: 'in', provenance: 'assumed — file declares unsupported unit code ' + (code != null ? code : '?') };
    }
    return { key: 'in', provenance: 'assumed — file didn\'t declare units' };
  }

  // ---- Value / formatting -----------------------------------------------------

  function dxfMeasureValueInches(session, measurement) {
    if (!session || !measurement) return null;
    const factor = dxfMeasureEffectiveUnitFactor(session);
    let nativeLength = null;
    if (measurement.mode === 'out-of-path') {
      nativeLength = dxfDirectDistance(measurement.a.native, measurement.b.native);
    } else if (measurement.route) {
      const piece = session.pieces[measurement.a.pieceIndex];
      nativeLength = piece ? dxfRouteLength(measurement.route, piece.segments) : null;
    }
    return Number.isFinite(nativeLength) && Number.isFinite(factor) ? nativeLength * factor : null;
  }

  // Up to 3 decimals, trailing zeroes trimmed, inch quote suffix — matches
  // 2.25", 2.257", 10" exactly, while retaining the precision the 0.1mm CLO
  // acceptance gate needs.
  function dxfMeasureFormatInches(value) {
    if (!Number.isFinite(value)) return null;
    let s = value.toFixed(3);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s + '"';
  }

  // ---- Mini undo stack (fingerprint-diff, mirrors src/project/history.js) ---

  function dxfMeasureSnapshot(session) {
    if (!session) return null;
    return {
      measurements: clone(session.measurements),
      nextMeasurementId: session.nextMeasurementId,
      // US-111: MUST travel with measurements — restoring one without the
      // other lets Undo bring back a measurement a pair still references (or
      // resurrect a pair pointing at an id Undo just removed).
      seamPairs: clone(session.seamPairs),
      nextSeamPairId: session.nextSeamPairId,
    };
  }

  function dxfMeasureFingerprint(snapshot) {
    return JSON.stringify(snapshot);
  }

  function dxfMeasurePushHistoryIfChanged() {
    const session = state.dxfMeasureSession;
    if (!session) return;
    const snap = dxfMeasureSnapshot(session);
    const fingerprint = dxfMeasureFingerprint(snap);
    const last = session.history.past[session.history.past.length - 1];
    if (last && last.fingerprint === fingerprint) return;
    session.history.past.push({ snapshot: snap, fingerprint });
    if (session.history.past.length > HISTORY_LIMIT) session.history.past.shift();
    session.history.future = [];
  }

  function dxfMeasureSeedHistory() {
    const session = state.dxfMeasureSession;
    if (!session) return;
    const snap = dxfMeasureSnapshot(session);
    session.history.past = [{ snapshot: snap, fingerprint: dxfMeasureFingerprint(snap) }];
    session.history.future = [];
  }

  function dxfMeasureRestoreSnapshot(session, snapshot) {
    if (!session || !snapshot) return;
    session.measurements = clone(snapshot.measurements);
    session.nextMeasurementId = snapshot.nextMeasurementId;
    session.seamPairs = clone(snapshot.seamPairs || []);
    session.nextSeamPairId = snapshot.nextSeamPairId || 1;
    session.selectedMeasurementId = null;
    session.interaction = null;
  }

  function dxfMeasureIsSessionActive() {
    return !!state.dxfMeasureSession;
  }

  function dxfMeasureUndo() {
    const session = state.dxfMeasureSession;
    if (!session || session.history.past.length <= 1) return false;
    const current = session.history.past.pop();
    session.history.future.push(current);
    const target = session.history.past[session.history.past.length - 1];
    dxfMeasureRestoreSnapshot(session, target.snapshot);
    return true;
  }

  function dxfMeasureRedo() {
    const session = state.dxfMeasureSession;
    if (!session || !session.history.future.length) return false;
    const next = session.history.future.pop();
    session.history.past.push(next);
    dxfMeasureRestoreSnapshot(session, next.snapshot);
    return true;
  }
