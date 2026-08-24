// Hit-testing helpers: turn world-space coordinates into selected
// annotations, images, draft annotations, label hits, and image-corner
// resize anchors. Source part for app.js. Run `npm run build` after
// editing.

  function hitTestSelectedHandles(world, ann) {
    // Generous radius for endpoints so resizing a line stays a one-click
    // grab even at low zoom. The visual handle is smaller; this is the
    // forgiving INVISIBLE catch zone around it.
    const endpointRadius = 14 / state.zoom;
    const controlRadius = 11 / state.zoom;
    if (ann.type === 'curved') {
      // Single cubic: the two control handles are always grabbable (pen-tool
      // model).
      //
      // US-093: plus any interior anchor the TD added — no visibility gating
      // (ADR 0053), so every anchor's point + both handles are grabbable at
      // once, same "no crowding gate" stance the two base handles already take.
      //
      // US-093 / ADR 0053 code review, 2026-08-21: EVERY handle on a curved
      // line — start and end included — is ranked NEAREST-wins, and the whole
      // candidate set is built here rather than partly ahead of this block,
      // because a first-wins test at a WIDER radius shadows everything under
      // it. Returning the first match in declaration order cost the TD three
      // ways:
      //   * start/end were tested first of all AND at the wider 14px radius,
      //     so they shadowed every anchor and both bend handles within 14px.
      //     handleAddPointClick only gates where a NEW anchor may be inserted;
      //     nothing stops the TD dragging an existing one toward an end. A
      //     press 1px from that anchor and 13px from start then moved the POM's
      //     ENDPOINT off its landmark pin, changing the measured length, while
      //     the TD was aiming squarely at the anchor.
      //   * control1/control2, tested before the anchors, shadowed any anchor
      //     within controlRadius of them.
      //   * inside the anchor loop, all three of anchor 0's fields were tested
      //     before anchor 1 was looked at, so a press equidistant between
      //     anchor 0's small handleOut and anchor 1's point bent the handle —
      //     yet render-annotations.js paints pt.point with the same
      //     emphasized, endpoint-sized handle as start/end, so the TD aimed at
      //     the big target and silently bent a small one instead.
      //
      // This also runs on Auto-Mode DRAFTS (pointer-events.js), which carry no
      // `points`, so there the ranking is over start/end/control1/control2 —
      // the pre-US-093 set — and control1 can now take a press that used to go
      // to start. Deliberate, and not a corner case: the GEOMETRIC fallbacks do
      // seed control1 about 35% of the chord from start (pom-fixture-builder.js
      // POM 9 0.38, POM 10 0.34, POM 14 0.35, POM 17/18 0.35), but POM 17's and
      // POM 18's TRACED branch writes matchContourForCurve's solved controls
      // straight through, bounded only by a score floor, traceShapeOk's dip test
      // and traceControlSane's [-0.1, 1.1] normalized box — none of which bounds
      // |control1 - start|. On a real sketch that traces cleanly (the case
      // US-051 exists for) control1 can sit arbitrarily close to start, at ANY
      // zoom. Ranking is what makes that safe: grabbing a bend handle bows the
      // curve but leaves both ends on their landmarks, grabbing an end moves a
      // landmark pin, so distance trades the costlier mistake for the cheaper.
      let best = null;
      let bestDist = Infinity;
      // Candidates are offered in DRAW order (bottom of the stack first) and
      // `<=` lets a later one take an exact tie, so a tie resolves to whichever
      // handle the TD actually sees on top. hitTestAnyEndpoint below is the one
      // other test in this file that ranks by distance; hitTestNotes and
      // hitTestAnnotations are topmost-first with an immediate return, and
      // hitTestSelectedNoteHandles is tiered (nearest leader tip, THEN the add
      // handle), so neither is a precedent for ranking one mixed set. Spelled
      // out rather than left to iteration accident because determinism is
      // asserted: `npm run golden` requires one input to yield one result, and
      // board-interaction-check drives real mousedowns at computed coordinates.
      const considerHandle = (point, radius, part) => {
        if (!point) return;
        const dist = distance(world, point);
        if (dist <= radius && dist <= bestDist) {
          bestDist = dist;
          best = { part };
        }
      };
      considerHandle(ann.control1, controlRadius, 'control1');
      considerHandle(ann.control2, controlRadius, 'control2');
      const points = ann.points || [];
      for (let i = 0; i < points.length; i += 1) {
        const pt = points[i];
        // Per anchor, the order render-annotations.js paints it: the two small
        // bend handles, then the emphasized point on top of them. Each keeps
        // its own catch radius — the point is an endpoint-sized target, its
        // handles are control-sized — but ranking is by raw distance, so the
        // nearer candidate wins regardless of which radius admitted it.
        considerHandle(pt.handleIn, controlRadius, 'point' + i + '.handleIn');
        considerHandle(pt.handleOut, controlRadius, 'point' + i + '.handleOut');
        considerHandle(pt.point, endpointRadius, 'point' + i + '.point');
      }
      // start/end last because render-annotations.js paints them last, over the
      // whole curved block above. With the `<=` tie rule that keeps the old
      // "endpoints win a shared spot" guarantee for every OTHER handle: anything
      // sitting ON an endpoint still loses to it, which curves.js's t=0/t=1
      // guard leans on when it says a control1 collapsed onto start would be
      // ungrabbable. The one press whose answer changed is one exactly
      // equidistant from start and end: it now returns 'end' where first-wins
      // returned 'start'. Both move a landmark pin and neither is more right, so
      // the straight branch below leaves that same tie alone rather than churn
      // every press in the app for it.
      considerHandle(ann.start, endpointRadius, 'start');
      considerHandle(ann.end, endpointRadius, 'end');
      if (best) return best;
    } else {
      // US-093 / ADR 0053 code review, 2026-08-21: a straight line has exactly
      // these two handles and no others, so first-wins and nearest-wins give
      // the same answer for every press but one exactly equidistant from both
      // ends. Left byte-identical instead of folded into the ranked block
      // above — this function runs on every press in the app, and changing
      // behaviour here would buy nothing.
      if (distance(world, ann.start) <= endpointRadius) return { part: 'start' };
      if (distance(world, ann.end) <= endpointRadius) return { part: 'end' };
    }
    // US-096 / ADR 0055: only a callout that is actually PAINTED is grabbable.
    // A construction line paints no number, and its unpainted box — ~22-36 px
    // wide, offset ~18 px off the line's midpoint — would otherwise steal
    // presses in visibly empty space and route them to startLabelDrag, moving
    // something the TD can never see.
    if (annotationShowsCallout(ann)
      && pointInLabelBounds(world, ann.label, getLabelText(ann), 9 / state.zoom)) return { part: 'label' };
    return null;
  }

  // US-086: endpoint grab that does NOT require the line to be selected first.
  // hitTestSelectedHandles only ever looks at the ONE selected annotation, so
  // before this existed the first press near an endpoint fell through to the
  // line-body test and dragged the whole line — and only that accidental drag
  // left the line selected, so the SECOND endpoint the TD tried worked. From
  // the TD's seat that reads as "one end works, the other moves everything".
  //
  // Nearest endpoint wins, not topmost: POMs deliberately share endpoints
  // (POM 1's end IS POM 2's start, POM 3's end IS POM 4's start), and the
  // topmost-first rule used by hitTestAnnotations made the lower line's end
  // permanently unreachable. Ties still fall to the topmost line, which is the
  // only sensible answer when two endpoints are exactly coincident — the TD
  // disambiguates by dragging the wrong one back, or from the spec panel.
  //
  // The radius is deliberately SMALLER than hitTestSelectedHandles' 14px so the
  // line being edited keeps priority over a neighbour's endpoint.
  //
  // US-093 / ADR 0053 code review, 2026-08-21: an endpoint DEFERS to an interior
  // anchor point the press is STRICTLY closer to, scanned across all non-hidden
  // lines ONCE before any endpoint is ranked. Board-wide, not per-line, because
  // POMs share endpoints (above): a scan scoped to one line let an anchor on
  // line A lose to line B's coincident endpoint, one line over. Without the
  // deferral a press on such an anchor returned { part: 'start' } and
  // startHandleDrag moved the POM's LANDMARK PIN, changing the measured length,
  // while the anchor the TD aimed at stayed put. No Add-point insertion gate can
  // prevent it — the TD may simply DRAG an existing anchor up against an end.
  //
  // Deferring rather than returning the anchor: this runs only while the curve is
  // NOT the single selection, and render-annotations.js paints interior anchors
  // only inside drawSelectionHelpers, so the anchor is INVISIBLE here. Falling
  // through reaches hitTestAnnotations, which selects the line, after which the
  // anchor is grabbable via hitTestSelectedHandles. Two presses, no landmark
  // moved.
  function hitTestAnyEndpoint(world) {
    const radius = 10 / state.zoom;
    let best = null;
    let bestDist = Infinity;
    // Nearest interior anchor point on the board, Infinity when there is none —
    // which is every straight line and every auto-generated POM curve
    // (points: []), so on an applied board the ranking below is left exactly as
    // it was before anchors existed.
    let anchorDist = Infinity;
    for (let i = 0; i < state.annotations.length; i += 1) {
      const ann = state.annotations[i];
      if (isAnnHidden(ann.id)) continue;
      const points = ann.points || [];
      for (let k = 0; k < points.length; k += 1) {
        const pt = points[k];
        if (!pt || !pt.point) continue;
        const d = distance(world, pt.point);
        if (d < anchorDist) anchorDist = d;
      }
    }
    for (let i = 0; i < state.annotations.length; i += 1) {
      const ann = state.annotations[i];
      if (isAnnHidden(ann.id)) continue;
      for (const part of ['start', 'end']) {
        const p = ann[part];
        if (!p) continue;
        const dist = distance(world, p);
        // `<=` so a later (topmost) line wins an exact tie; `<= anchorDist` so
        // the endpoint yields only to a STRICTLY closer anchor — on a shared
        // spot the endpoint, the one of the two actually drawn here, keeps it.
        if (dist <= radius && dist <= bestDist && dist <= anchorDist) {
          bestDist = dist;
          best = { id: ann.id, part };
        }
      }
    }
    return best;
  }

  function hitTestAnnotations(world) {
    for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
      const ann = state.annotations[i];
      // Skip hidden annotations — the canvas draws nothing for them, so
      // catching a click in an empty region would confuse the reviewer.
      if (isAnnHidden(ann.id)) continue;
      // Same rule as hitTestSelectedHandles: an unpainted callout is not a
      // target. This test runs BEFORE the body test and walks topmost-first, so
      // an invisible box here shadows the real POM line underneath it.
      if (annotationShowsCallout(ann)
        && pointInLabelBounds(world, ann.label, getLabelText(ann), 8 / state.zoom)) {
        return { id: ann.id, part: 'label' };
      }
      if (isPointNearAnnotation(world, ann, 8 / state.zoom)) {
        return { id: ann.id, part: 'body' };
      }
    }
    return null;
  }

  // US-086 follow-up: is this press close enough to a line that it should read
  // as a MISS of that line rather than as intent to move the photo behind it?
  //
  // Deliberately wider than the line-body tolerance. Requiring the photo to be
  // selected before it drags only protected the FIRST mis-aimed press — the
  // press that selected the photo left it selected, so the next near-miss slid
  // the sketch again (measured: 25.5px). The band between "grabbed the line"
  // and "clearly meant the photo" is exactly where a mis-aim lands, and moving
  // the sketch is by far the costlier of the two mistakes to make silently.
  function isPointNearAnyAnnotation(world, screenTolerance) {
    const tol = (screenTolerance || 16) / state.zoom;
    for (const ann of state.annotations) {
      if (isAnnHidden(ann.id)) continue;
      if (isPointNearAnnotation(world, ann, tol)) return true;
    }
    return false;
  }

  // US-092 step 6: the SELECTED note's own small handles — the tip of each
  // leader arrow, and the handle that pulls a new one out. Selected-only, which
  // mirrors hitTestSelectedHandles for lines and, more importantly, mirrors
  // what is DRAWN: these handles appear only on the selected note, and making
  // an invisible target grabbable is worse than asking for a click first.
  //
  // Tips are tested before the add handle so a leader dropped near the box's
  // bottom-right corner stays grabbable rather than being shadowed by it.
  // Nearest tip wins, not first — two arrows pointing at nearby details is a
  // normal thing for a TD to draw.
  function hitTestSelectedNoteHandles(world, note) {
    if (!note) return null;
    const radius = 11 / state.zoom;
    const leaders = note.leaders || [];
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < leaders.length; i += 1) {
      const dist = distance(world, leaders[i]);
      // `<=` so a later (drawn-on-top) tip wins an exact tie.
      if (dist <= radius && dist <= bestDist) {
        bestDist = dist;
        best = { part: 'leader', index: i };
      }
    }
    if (best) return best;
    const add = noteLeaderAddHandle(note);
    if (add && distance(world, add) <= radius) return { part: 'leader-add', index: -1 };
    return null;
  }

  // US-092: which text note is under this point. Topmost-first, like the line
  // and photo tests — the last note in the array draws last, so it is the one
  // the TD sees on top and the one a click should take.
  //
  // No forgiving catch ribbon here, unlike a line: a note is a filled box, so
  // its visible edge IS its target, and padding it would only steal presses
  // from the sketch around it.
  function hitTestNotes(world) {
    const notes = state.notes || [];
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      const note = notes[i];
      const box = noteBounds(note);
      if (!box) continue;
      if (world.x >= box.x && world.x <= box.x + box.width
        && world.y >= box.y && world.y <= box.y + box.height) {
        return { id: note.id, part: 'box' };
      }
    }
    return null;
  }

  function hitTestImages(world) {
    for (let i = state.images.length - 1; i >= 0; i -= 1) {
      const image = state.images[i];
      if (
        world.x >= image.x &&
        world.x <= image.x + image.width &&
        world.y >= image.y &&
        world.y <= image.y + image.height
      ) {
        return { id: image.id };
      }
    }
    return null;
  }

  function hitTestSelectedImageHandles(world, image) {
    const radius = 10 / state.zoom;
    const corners = getImageCorners(image);
    for (const corner of corners) {
      if (distance(world, corner) <= radius) {
        return { corner: corner.name };
      }
    }
    return null;
  }

  function getImageCorners(image) {
    return [
      { name: 'nw', x: image.x, y: image.y },
      { name: 'ne', x: image.x + image.width, y: image.y },
      { name: 'sw', x: image.x, y: image.y + image.height },
      { name: 'se', x: image.x + image.width, y: image.y + image.height },
    ];
  }

  // Bounding box of a multi-image selection, shaped like an image so the existing
  // corner helpers (getImageCorners / hitTestSelectedImageHandles /
  // getOppositeImageCorner) work on the GROUP without duplicating their geometry.
  function getImagesGroupBox(images) {
    const list = (images || []).filter(im => im
      && Number.isFinite(im.x) && Number.isFinite(im.y)
      && Number.isFinite(im.width) && Number.isFinite(im.height));
    if (!list.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const im of list) {
      if (im.x < minX) minX = im.x;
      if (im.y < minY) minY = im.y;
      if (im.x + im.width > maxX) maxX = im.x + im.width;
      if (im.y + im.height > maxY) maxY = im.y + im.height;
    }
    if (!(maxX > minX && maxY > minY)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function getOppositeImageCorner(image, corner) {
    if (corner === 'nw') return { x: image.x + image.width, y: image.y + image.height };
    if (corner === 'ne') return { x: image.x, y: image.y + image.height };
    if (corner === 'sw') return { x: image.x + image.width, y: image.y };
    return { x: image.x, y: image.y };
  }

  function resizeImageFromCorner(image, corner, anchor, aspect, world) {
    const MIN_IMAGE_SIZE = 48;
    let localW = 0;
    let localH = 0;

    if (corner === 'nw') {
      localW = anchor.x - world.x;
      localH = anchor.y - world.y;
    } else if (corner === 'ne') {
      localW = world.x - anchor.x;
      localH = anchor.y - world.y;
    } else if (corner === 'sw') {
      localW = anchor.x - world.x;
      localH = world.y - anchor.y;
    } else {
      localW = world.x - anchor.x;
      localH = world.y - anchor.y;
    }

    localW = Math.max(MIN_IMAGE_SIZE, localW);
    localH = Math.max(MIN_IMAGE_SIZE, localH);

    let width = Math.max(localW, localH * aspect);
    let height = width / aspect;

    if (height < MIN_IMAGE_SIZE) {
      height = MIN_IMAGE_SIZE;
      width = height * aspect;
    }

    // US-091: which lines belong to this photo has to be answered against the
    // rect it had BEFORE the resize, and the incremental factor read off the
    // same pair — this runs once per mousemove, so the factor is per-frame, not
    // for the whole gesture.
    const previousBounds = getImageBounds(image);
    const factor = image.width > 0 ? width / image.width : 1;

    if (corner === 'nw') {
      image.x = anchor.x - width;
      image.y = anchor.y - height;
    } else if (corner === 'ne') {
      image.x = anchor.x;
      image.y = anchor.y - height;
    } else if (corner === 'sw') {
      image.x = anchor.x - width;
      image.y = anchor.y;
    } else {
      image.x = anchor.x;
      image.y = anchor.y;
    }

    image.width = width;
    image.height = height;

    // The photo scales about the opposite corner, so its lines and its notes do
    // too — both are absolute world geometry that nothing else would move.
    scaleAnnotationsForImageResize(previousBounds, anchor, factor);
    scaleNotesForImageResize(previousBounds, anchor, factor);
    scaleOwnedGraphicsForImageResize(image.id, anchor, factor);
  }

  function pointInLabelBounds(point, labelPos, seq, padding) {
    const fontSize = 17 / state.zoom;
    ctx.save();
    ctx.font = '700 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
    const metrics = ctx.measureText(String(seq));
    ctx.restore();
    const width = Math.max(14 / state.zoom, metrics.width) + padding * 2;
    const height = fontSize + padding * 1.6;
    return (
      point.x >= labelPos.x - width / 2 &&
      point.x <= labelPos.x + width / 2 &&
      point.y >= labelPos.y - height / 2 &&
      point.y <= labelPos.y + height / 2
    );
  }

  function isPointNearAnnotation(point, ann, tolerance) {
    const hitTolerance = Math.max(tolerance, (getLineWidth(ann) / 2 + 6) / state.zoom);
    if (ann.type === 'straight') {
      return pointToSegmentDistance(point, ann.start, ann.end) <= hitTolerance;
    }
    const pts = getAnnotationPolyline(ann, BEZIER_SAMPLES * 2);
    for (let i = 1; i < pts.length; i += 1) {
      if (pointToSegmentDistance(point, pts[i - 1], pts[i]) <= hitTolerance) return true;
    }
    return false;
  }
