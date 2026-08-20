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
    if (distance(world, ann.start) <= endpointRadius) return { part: 'start' };
    if (distance(world, ann.end) <= endpointRadius) return { part: 'end' };
    if (ann.type === 'curved') {
      // Single cubic: the two control handles are always grabbable (pen-tool
      // model). Endpoints are checked first (above) so they win a shared spot.
      if (ann.control1 && distance(world, ann.control1) <= controlRadius) return { part: 'control1' };
      if (ann.control2 && distance(world, ann.control2) <= controlRadius) return { part: 'control2' };
    }
    if (pointInLabelBounds(world, ann.label, getLabelText(ann), 9 / state.zoom)) return { part: 'label' };
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
  function hitTestAnyEndpoint(world) {
    const radius = 10 / state.zoom;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < state.annotations.length; i += 1) {
      const ann = state.annotations[i];
      if (isAnnHidden(ann.id)) continue;
      for (const part of ['start', 'end']) {
        const p = ann[part];
        if (!p) continue;
        const dist = distance(world, p);
        // `<=` so a later (topmost) line wins an exact tie.
        if (dist <= radius && dist <= bestDist) {
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
      if (pointInLabelBounds(world, ann.label, getLabelText(ann), 8 / state.zoom)) {
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

    // The photo scales about the opposite corner, so its lines do too.
    scaleAnnotationsForImageResize(previousBounds, anchor, factor);
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
