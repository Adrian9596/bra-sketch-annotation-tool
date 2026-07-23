// Image and erase-stroke rendering: photo frame, lock badge, eraser
// strokes (and the live in-progress stroke), image selection chrome and
// resize handles, and the drawing preview shown during click-twice-draw.
// Source part for app.js. Run `npm run build` after editing.

  function drawImageItem(image) {
    if (!image.img) return;
    ctx.drawImage(image.img, image.x, image.y, image.width, image.height);
    if (image.locked) drawLockBadge(image);
  }

  // Small lock chip pinned to an image's top-right corner so the user can
  // always see at a glance which images are protected.
  function drawLockBadge(image) {
    const z = Math.max(state.zoom, 0.15);
    const w = 22 / z;
    const h = 22 / z;
    const pad = 6 / z;
    const x = image.x + image.width - w - pad;
    const y = image.y + pad;
    ctx.save();
    ctx.fillStyle = 'rgba(31, 41, 55, 0.85)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 1.2 / z;
    const r = 4 / z;
    // Rounded rect background
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Padlock glyph centered in the badge
    const cx = x + w / 2;
    const cy = y + h / 2;
    const bw = w * 0.46;
    const bh = h * 0.36;
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.4 / z;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Body
    ctx.beginPath();
    ctx.rect(cx - bw / 2, cy - bh / 2 + bh * 0.18, bw, bh);
    ctx.fill();
    // Shackle
    ctx.beginPath();
    ctx.arc(cx, cy - bh * 0.18, bw * 0.34, Math.PI, 0, false);
    ctx.stroke();
    ctx.restore();
  }
  function drawEraseStroke(stroke) {
    const image = getImageById(stroke.imageId);
    if (!image || !image.img) return;
    drawEraseStrokeAt(image, stroke.size, stroke.points);
  }

  function drawEraseStrokeSession(session) {
    const image = getImageById(session.imageId);
    if (!image || !image.img) return;
    drawEraseStrokeAt(image, session.size, session.points);
  }

  // Render a single stroke clipped to its parent image. Points are stored in
  // the image's natural-pixel coordinate space, so a transform from local →
  // world is applied before stroking.
  function drawEraseStrokeAt(image, size, points) {
    if (!points || !points.length) return;
    const naturalW = image.img.naturalWidth || image.width;
    const naturalH = image.img.naturalHeight || image.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(image.x, image.y, image.width, image.height);
    ctx.clip();
    ctx.translate(image.x, image.y);
    ctx.scale(image.width / naturalW, image.height / naturalH);
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawImageSelection(image, showHandles = true) {
    ctx.save();
    ctx.lineWidth = 2 / state.zoom;
    // Use a muted outline when the image is locked so the user sees the
    // selection but doesn't expect to drag corners that won't respond.
    ctx.strokeStyle = image.locked ? 'rgba(107, 114, 128, 0.85)' : SELECT_COLOR;
    ctx.setLineDash([10 / state.zoom, 6 / state.zoom]);
    ctx.strokeRect(image.x, image.y, image.width, image.height);
    ctx.setLineDash([]);
    // Resize handles only when a single image is selected. A multi-selection
    // (Cmd/Ctrl+click) is a move-together group, so it shows outlines only.
    if (!image.locked && showHandles) {
      for (const corner of getImageCorners(image)) {
        drawImageResizeHandle(corner);
      }
    }
    ctx.restore();
  }

  function drawImageResizeHandle(point) {
    const r = 6.5 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.stroke();
    ctx.restore();
  }

  function drawPreview() {
    const preview = state.drawSession;
    const seq = state.nextSequence;
    if (!preview || !preview.current) return;

    if (preview.type === 'extension-followup') {
      const proj = projectionOnAxis(preview.current, preview.prevEnd, preview.prevDir);
      if (!proj.qualifies) return;
      const tip = {
        x: preview.prevEnd.x + preview.prevDir.x * proj.distance,
        y: preview.prevEnd.y + preview.prevDir.y * proj.distance,
      };
      const temp = {
        type: 'straight',
        style: 'dashed',
        color: preview.color,
        arrowType: 'single',
        lineWidth: preview.lineWidth,
        start: preview.prevEnd,
        end: tip,
        label: computeDefaultLabelPosition({
          type: 'straight',
          start: preview.prevEnd,
          end: tip,
        }),
        seq,
      };
      drawLineCore(temp, 0.6);
      drawLabel(temp.label, seq, false, 0.75, getAnnotationColor(temp));
      return;
    }

    if (preview.type === 'straight') {
      const temp = {
        type: 'straight',
        style: preview.style,
        color: preview.color,
        arrowType: preview.arrowType,
        lineWidth: preview.lineWidth,
        start: preview.start,
        end: preview.current,
        label: computeDefaultLabelPosition({
          type: 'straight',
          start: preview.start,
          end: preview.current
        }),
        seq
      };
      drawLineCore(temp, 0.78);
      drawLabel(temp.label, seq, false, 0.9, getAnnotationColor(temp));
      return;
    }

    // Curved preview. Before the middle is placed, show a light dashed guide to
    // the cursor (you're about to click the middle); afterwards preview the real
    // curve through start → mid → cursor.
    if (preview.mid == null) {
      drawLineCore({
        type: 'straight',
        style: 'dashed',
        color: preview.color,
        arrowType: 'none',
        lineWidth: preview.lineWidth,
        start: preview.start,
        end: preview.current,
      }, 0.4);
      return;
    }
    const m = curveControlsThroughThreePoints(preview.start, preview.mid, preview.current);
    const temp = {
      type: 'curved',
      style: preview.style,
      color: preview.color,
      arrowType: preview.arrowType,
      lineWidth: preview.lineWidth,
      start: preview.start,
      end: preview.current,
      midPoint: m.midPoint,
      midHandleIn: m.midHandleIn,
      midHandleOut: m.midHandleOut,
      control1: m.control1,
      control2: m.control2,
      label: computeDefaultLabelPosition({
        type: 'curved',
        start: preview.start,
        end: preview.current,
        midPoint: m.midPoint,
        midHandleIn: m.midHandleIn,
        midHandleOut: m.midHandleOut,
        control1: m.control1,
        control2: m.control2,
      }),
      seq
    };
    drawLineCore(temp, 0.78);
    drawLabel(temp.label, seq, false, 0.9, getAnnotationColor(temp));
  }
