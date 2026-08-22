// Stitch-pattern rendering: zigzag, cover, and bartack stitches
// rendered along an annotation polyline, plus the polyline sampling
// helpers they share. Source part for app.js. Run `npm run build`
// after editing.

  function drawZigzagStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const step = Math.max(3 / state.zoom, (4.5 + lineWidth * 0.5) / state.zoom);
    const amplitude = Math.max(3.5 / state.zoom, (lineWidth * 1.7 + 2) / state.zoom);
    const count = Math.max(2, Math.ceil(length / step));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, lineWidth * 0.72) / state.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= count; i += 1) {
      const sample = samplePolylineAt(points, length * (i / count));
      const side = i % 2 === 0 ? -1 : 1;
      const x = sample.point.x + sample.normal.x * amplitude * side;
      const y = sample.point.y + sample.normal.y * amplitude * side;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawCoverStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const railOffset = Math.max(3.5 / state.zoom, (lineWidth * 1.35 + 2) / state.zoom);
    const stitchStep = Math.max(8 / state.zoom, (12 + lineWidth) / state.zoom);
    const stitchLength = stitchStep * 0.55;
    const stitchWidth = Math.max(1, lineWidth * 0.62) / state.zoom;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stitchWidth;
    drawStitchRow(points, length, railOffset, stitchStep, stitchLength);
    drawStitchRow(points, length, -railOffset, stitchStep, stitchLength);
    ctx.restore();
  }

  function drawBartackStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const barLength = length;
    const zigzagHalfWidth = Math.max(5 / state.zoom, (lineWidth * 2.3 + 4) / state.zoom);
    const stitchStep = Math.max(1.8 / state.zoom, (2.6 + lineWidth * 0.12) / state.zoom);
    const stitchWidth = Math.max(1, lineWidth * 0.58) / state.zoom;
    const startAlong = 0;
    const count = Math.max(4, Math.ceil(barLength / stitchStep));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.8, lineWidth * 0.38) / state.zoom;
    ctx.globalAlpha *= 0.26;
    drawAnnotationPath(ann);
    ctx.stroke();

    ctx.globalAlpha /= 0.26;
    ctx.lineWidth = stitchWidth;
    ctx.beginPath();
    for (let i = 0; i <= count; i += 1) {
      const distanceAlong = clamp(startAlong + (barLength * i / count), 0, length);
      const sample = samplePolylineAt(points, distanceAlong);
      const side = i % 2 === 0 ? -1 : 1;
      const x = sample.point.x + sample.normal.x * zigzagHalfWidth * side;
      const y = sample.point.y + sample.normal.y * zigzagHalfWidth * side;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawStitchRow(points, length, offset, step, stitchLength) {
    for (let distanceAlong = 0; distanceAlong < length; distanceAlong += step) {
      const start = samplePolylineAt(points, distanceAlong);
      const end = samplePolylineAt(points, Math.min(length, distanceAlong + stitchLength));
      ctx.beginPath();
      ctx.moveTo(
        start.point.x + start.normal.x * offset,
        start.point.y + start.normal.y * offset
      );
      ctx.lineTo(
        end.point.x + end.normal.x * offset,
        end.point.y + end.normal.y * offset
      );
      ctx.stroke();
    }
  }

  function getAnnotationPolyline(ann, samples) {
    if (ann.type === 'straight') return [ann.start, ann.end];
    const segs = getCurveBeziers(ann);
    const basePer = Math.max(2, Math.round(samples / segs.length));
    // Before US-093 every annotation reaching this helper had one cubic (or
    // the retired legacy midpoint pair), so `samples` was a whole-curve
    // budget. Keep that path byte-identical: existing 2-handle curves must not
    // change their measured value, hit shape, stitches, or label placement.
    //
    // `points[]` changes the contract: it can grow the curve to any number of
    // cubics. Dividing the same fixed budget across that chain eventually left
    // only two chords per segment (25/50 samples reaches that floor at about
    // 10/20 segments). A strong S-bend then collapses to its endpoint chord,
    // severely under-counting length and making the bulge unhittable. Give
    // every added-anchor segment its own curvature-driven budget instead. The
    // shared curveChordSampleCount bound is deterministic and zoom-independent,
    // floors each segment at the old 24-chord precision, and caps corrupt or
    // extreme geometry at 512 evaluations per segment.
    const adaptivePerSegment = Array.isArray(ann.points) && ann.points.length > 0;
    const points = [ann.start];
    for (const s of segs) {
      const per = adaptivePerSegment
        ? Math.min(CURVE_CHORD_MAX_SAMPLES, Math.max(basePer, curveChordSampleCount(s)))
        : basePer;
      for (let i = 1; i <= per; i += 1) {
        points.push(bezierPoint(s.p0, s.p1, s.p2, s.p3, i / per));
      }
    }
    return points;
  }

  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    return total;
  }

  function samplePolylineAt(points, targetDistance) {
    let walked = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const segLen = distance(a, b);
      if (segLen <= 0) continue;
      if (walked + segLen >= targetDistance) {
        const t = clamp((targetDistance - walked) / segLen, 0, 1);
        const tangent = { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen };
        return {
          point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
          tangent,
          normal: { x: -tangent.y, y: tangent.x },
        };
      }
      walked += segLen;
    }
    const last = points.length - 1;
    const normal = polylineVertexNormal(points, last);
    const prev = points[Math.max(0, last - 1)];
    const len = Math.max(0.0001, distance(prev, points[last]));
    const tangent = {
      x: (points[last].x - prev.x) / len,
      y: (points[last].y - prev.y) / len,
    };
    return { point: points[last], tangent, normal };
  }

  function polylineVertexNormal(points, index) {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const len = Math.max(0.0001, distance(prev, next));
    const tx = (next.x - prev.x) / len;
    const ty = (next.y - prev.y) / len;
    return { x: -ty, y: tx };
  }
