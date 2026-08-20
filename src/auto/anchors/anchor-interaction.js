// World-space anchor position, hit testing, drag start, keyboard nudge, and
// snap-to-ink — the pointer/keyboard mutation pipeline.
// Source part for app.js. Run `npm run build` after editing.
//
// hitTestAnchors funnels into onMouseDown so anchor pins beat annotation
// hits in Auto Mode. startAnchorDrag captures a learnOrigin so the
// learning loop sees one (anchor pre-drag → anchor post-drag) sample per
// commit, regardless of how the mouse moved in between. moveAnchorBy is
// the single mutation path for every anchor move (drag, nudge, snap), so
// the derived-pin / cascade / draft-sync side effects can't diverge.
//
// getAnchorById and the US-038 hide/show/isolate state live in
// anchor-visibility.js; this file consumes isAnchorHidden so hidden pins
// stay ungrabbable.

  // Learning origin = the UNBIASED predicted position when learning stashed one
  // (predictedX/Y set by applyLearningBiasToAnchors), else the current position.
  // Recording the TD's correction relative to the raw prediction — not the
  // biased seed — is what lets the bucket median converge to the FULL offset
  // instead of half of it (A2).
  function learnOriginX(anchor) {
    return Number.isFinite(anchor && anchor.predictedX) ? anchor.predictedX : anchor.x;
  }
  function learnOriginY(anchor) {
    return Number.isFinite(anchor && anchor.predictedY) ? anchor.predictedY : anchor.y;
  }

  function anchorWorldPos(anchor) {
    const image = getImageById(anchor.sourceImageId);
    if (!image) return null;
    return {
      x: image.x + anchor.x * image.width,
      y: image.y + anchor.y * image.height,
    };
  }

  function hitTestAnchors(world) {
    if (state.appMode !== 'auto' || !state.autoMode.anchors.length) return null;
    // Hidden pins must not be grabbable, or the user would drag invisible
    // anchors while trying to pan or select applied lines.
    if (state.autoMode.anchorsHidden) return null;
    const radiusWorld = 9 / Math.max(state.zoom, 0.1); // 9px screen
    let best = null;
    let bestDist = Infinity;
    for (const anchor of state.autoMode.anchors) {
      if (isAnchorHidden(anchor.kind)) continue; // US-038: hidden pins aren't grabbable
      const pos = anchorWorldPos(anchor);
      if (!pos) continue;
      const dx = world.x - pos.x;
      const dy = world.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= radiusWorld && d < bestDist) {
        best = anchor;
        bestDist = d;
      }
    }
    return best;
  }

  function startAnchorDrag(anchorId, world) {
    // A pending keyboard-nudge session must commit before a new drag begins,
    // or its learnOrigin would blend two separate corrections into one sample.
    flushAnchorNudgeSession();
    const before = snapshotFingerprint(makeSnapshot());
    const anchor = getAnchorById(anchorId);
    state.interaction = {
      type: 'drag-anchor',
      id: anchorId,
      prevWorld: world,
      changed: false,
      beforeFingerprint: before,
      // Snapshot the anchor's pre-drag normalized position so onMouseUp
      // can compute the (detected → corrected) residual exactly once
      // per commit, regardless of how the mouse moved in between. Use the
      // UNBIASED prediction (predictedX/Y stashed by applyLearningBiasToAnchors)
      // so the residual trains against the raw detector, not the biased seed
      // (A2). Falls back to the current position when no bias was applied.
      learnOrigin: anchor ? { kind: anchor.kind, x: learnOriginX(anchor), y: learnOriginY(anchor) } : null,
    };
    document.body.classList.add('grabbing');
  }

  // Single mutation path for every anchor move (mouse drag, keyboard nudge,
  // snap-to-ink). Deltas are normalized [0,1] source-image space. Returns
  // whether the anchor actually moved (clamping at the image border can make
  // a requested move a no-op).
  function moveAnchorBy(anchor, dxNorm, dyNorm) {
    if (!anchor || (!dxNorm && !dyNorm)) return false;
    const nx = clamp01(anchor.x + dxNorm);
    const ny = clamp01(anchor.y + dyNorm);
    if (nx === anchor.x && ny === anchor.y) return false;
    anchor.x = nx;
    anchor.y = ny;
    anchor.autoFilled = false;
    // Moving a DERIVED anchor directly pins it so the cascade below never
    // fights a deliberate TD correction (cleared on reseed).
    if (!anchor.derivedPinned && anchorDerivationForKind(anchor.kind)) {
      anchor.derivedPinned = true;
      showToast(anchor.name + ' unpinned from its auto-placement — it will stay where you put it.');
    }
    // Moving a PRIMARY re-derives its dependents live (Phase 3): e.g.
    // moving cf-top or the band endpoints re-projects cf-bottom onto the
    // band line so POM 5/6 need one move instead of two.
    cascadeDerivedAnchors(anchor);
    // Keep POM 1/2/3/4 drafts in sync with band/chest anchors so the
    // 1/5-length rule for the dashed extensions holds live during the move.
    syncBandChestDraftsFromAnchors(anchor.kind);
    requestRender();
    return true;
  }

  // ---- U1: arrow-key nudge -------------------------------------------------
  // Arrow keys move the selected anchor by whole source-image pixels (the
  // space the ink mask and detectors work in). Rapid keystrokes form one
  // "nudge session": the learning residual, telemetry event, and history
  // push commit once, NUDGE_COMMIT_MS after the last keystroke — mirroring
  // the one-commit-per-drag contract of the mouse path.
  const NUDGE_COMMIT_MS = 700;
  let anchorNudgeSession = null; // { anchorId, learnOrigin, timer }

  function nudgeSelectedAnchor(dxPx, dyPx) {
    if (state.appMode !== 'auto' || state.autoMode.anchorsHidden) return false;
    const anchor = getAnchorById(state.autoMode.anchorSelectedId);
    if (!anchor) return false;
    const image = getImageById(anchor.sourceImageId);
    if (!image) return false;
    const naturalW = (image.img && image.img.naturalWidth) || image.width;
    const naturalH = (image.img && image.img.naturalHeight) || image.height;
    if (!naturalW || !naturalH) return false;
    if (anchorNudgeSession && anchorNudgeSession.anchorId !== anchor.id) {
      flushAnchorNudgeSession();
    }
    if (!anchorNudgeSession) {
      anchorNudgeSession = {
        anchorId: anchor.id,
        // Train against the unbiased prediction, not the biased seed (A2).
        learnOrigin: { kind: anchor.kind, x: learnOriginX(anchor), y: learnOriginY(anchor) },
        timer: null,
      };
    }
    moveAnchorBy(anchor, dxPx / naturalW, dyPx / naturalH);
    if (anchorNudgeSession.timer) clearTimeout(anchorNudgeSession.timer);
    anchorNudgeSession.timer = setTimeout(flushAnchorNudgeSession, NUDGE_COMMIT_MS);
    return true;
  }

  function flushAnchorNudgeSession() {
    const session = anchorNudgeSession;
    anchorNudgeSession = null;
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    const anchor = getAnchorById(session.anchorId);
    if (!anchor || anchor.kind !== session.learnOrigin.kind) return;
    const dx = anchor.x - session.learnOrigin.x;
    const dy = anchor.y - session.learnOrigin.y;
    if (!dx && !dy) return;
    recordAnchorResidual(anchor.kind, dx, dy, anchor);
    recordAutoTelemetryEvent('anchor_nudged', {
      sourceImageId: anchor.sourceImageId,
      anchor_id: anchor.id,
      anchor_kind: anchor.kind,
    });
    pushHistoryIfChanged();
    requestRender();
  }

  // The loupe stays up while a nudge session is live so the TD sees each
  // keystroke land; render-auto-overlay polls this.
  function activeNudgeAnchorId() {
    return anchorNudgeSession ? anchorNudgeSession.anchorId : null;
  }

  // ---- U2: snap-to-ink -----------------------------------------------------
  // On drag release the anchor pulls onto the nearest ink pixel of the
  // detection's binary mask (kept on detection.inkMask at sample resolution),
  // within a tolerance of ~12 screen px. Returns the normalized target
  // position, or null when there is no mask for this image, no ink within
  // tolerance, or the anchor already sits on ink. Deterministic: nearest
  // pixel by squared distance, row-major scan order breaking ties.
  function snapAnchorToInk(anchor) {
    const det = state.autoMode.detection;
    if (!det || !det.inkMask || det.sourceImageId !== anchor.sourceImageId) return null;
    const mask = det.inkMask;
    const maskW = det.inkMaskW;
    const maskH = det.inkMaskH;
    if (!maskW || !maskH) return null;
    const image = getImageById(anchor.sourceImageId);
    if (!image || !image.width) return null;
    // 12 screen px → world → normalized → mask px, capped so a zoomed-out
    // board can never yank an anchor across the sketch.
    const zoom = Math.max(state.zoom, 0.1);
    const tolNorm = (12 / zoom) / image.width;
    const tolPx = Math.min(Math.round(tolNorm * maskW), Math.max(2, Math.round(maskW * 0.03)));
    if (tolPx < 1) return null;
    const cx = Math.round(anchor.x * maskW - 0.5);
    const cy = Math.round(anchor.y * maskH - 0.5);
    const inkAt = (x, y) => x >= 0 && y >= 0 && x < maskW && y < maskH && mask[y * maskW + x];
    if (inkAt(cx, cy)) return null;
    let best = null;
    let bestD2 = Infinity;
    for (let dy = -tolPx; dy <= tolPx; dy += 1) {
      for (let dx = -tolPx; dx <= tolPx; dx += 1) {
        if (!inkAt(cx + dx, cy + dy)) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { x: cx + dx, y: cy + dy };
        }
      }
    }
    if (!best || bestD2 > tolPx * tolPx) return null;
    return {
      x: clamp01((best.x + 0.5) / maskW),
      y: clamp01((best.y + 0.5) / maskH),
    };
  }

  // Teach the ⌥-override once per session, not on every release.
  let snapHintShown = false;
  function maybeToastSnapHint() {
    if (snapHintShown) return;
    snapHintShown = true;
    showToast('Anchor snapped to the sketch ink — hold ⌥ (Alt) while releasing to place it freely.', 4200);
  }
