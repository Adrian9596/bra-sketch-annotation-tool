#!/usr/bin/env node
// Regression contract for US-093 multi-anchor curve sampling.
//
// Loads the real source parts into a small Node VM so the production
// getAnnotationPolyline implementation is tested without adding a browser-only
// debug hook. The synthetic 30-segment S curve is a negative control for the
// old whole-curve budget: 50 / 30 rounded down to two chords per cubic, which
// aliases every S bend into a nearly straight line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const context = vm.createContext({ console, Math, Number, JSON });

vm.runInContext(`
  var BEZIER_SAMPLES = 25;
  var state = { zoom: 1 };
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function bezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
  }
  function bezierTangent(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      x: 3*u*u*(p1.x-p0.x) + 6*u*t*(p2.x-p1.x) + 3*t*t*(p3.x-p2.x),
      y: 3*u*u*(p1.y-p0.y) + 6*u*t*(p2.y-p1.y) + 3*t*t*(p3.y-p2.y),
    };
  }
  function pointToSegmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : clamp(((p.x-a.x)*dx + (p.y-a.y)*dy) / l2, 0, 1);
    return Math.hypot(p.x - (a.x + dx*t), p.y - (a.y + dy*t));
  }
  function getLineWidth() { return 1; }
`, context);

for (const relative of [
  'src/curves.js',
  'src/render/render-stitches.js',
  'src/render/hit-testing.js',
  'src/manual/selection.js',
  'src/manual/annotation-factory.js',
  'src/manual/annotation-lookup.js',
]) {
  vm.runInContext(readFileSync(path.join(appDir, relative), 'utf8'), context, { filename: relative });
}

const api = vm.runInContext(`({
  getAnnotationPolyline,
  polylineLength,
  samplePolylineAt,
  insertCurveAnchorAt,
  isPointNearAnnotation,
  annotationTouchesRect,
  computeDefaultLabelPosition,
  lineLength,
  bezierPoint,
})`, context);

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function curveSegments(ann) {
  const points = Array.isArray(ann.points) ? ann.points : [];
  const out = [];
  let p0 = ann.start, p1 = ann.control1;
  for (const point of points) {
    out.push([p0, p1, point.handleIn, point.point]);
    p0 = point.point;
    p1 = point.handleOut;
  }
  out.push([p0, p1, ann.control2, ann.end]);
  return out;
}

function legacyPolyline(ann, samples) {
  const segs = curveSegments(ann);
  const per = Math.max(2, Math.round(samples / segs.length));
  const out = [ann.start];
  for (const seg of segs) {
    for (let i = 1; i <= per; i += 1) out.push(api.bezierPoint(...seg, i / per));
  }
  return out;
}

function densePolyline(ann, perSegment = 4096) {
  const out = [ann.start];
  for (const seg of curveSegments(ann)) {
    for (let i = 1; i <= perSegment; i += 1) out.push(api.bezierPoint(...seg, i / perSegment));
  }
  return out;
}

function makeSingleCurve() {
  return {
    type: 'curved',
    start: { x: 0, y: 0 },
    control1: { x: 80, y: 180 },
    control2: { x: 220, y: -130 },
    end: { x: 320, y: 20 },
  };
}

function makeSCurve(segmentCount) {
  const endpoints = Array.from({ length: segmentCount + 1 }, (_, i) => ({ x: i * 10, y: 0 }));
  const controls = Array.from({ length: segmentCount }, (_, i) => {
    const amplitude = 45 + (i % 7) * 18;
    return {
      c1: { x: endpoints[i].x + 3, y: amplitude },
      c2: { x: endpoints[i + 1].x - 3, y: -amplitude },
    };
  });
  return {
    type: 'curved',
    start: endpoints[0],
    control1: controls[0].c1,
    points: endpoints.slice(1, -1).map((point, i) => ({
      point,
      handleIn: controls[i].c2,
      handleOut: controls[i + 1].c1,
    })),
    control2: controls[segmentCount - 1].c2,
    end: endpoints[segmentCount],
  };
}

function nearestPolylineDistance(point, polyline) {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1], b = polyline[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
}

function touchesRect(polyline, point, halfSize) {
  const minX = point.x - halfSize, minY = point.y - halfSize;
  const maxX = point.x + halfSize, maxY = point.y + halfSize;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1], b = polyline[i];
    for (let j = 0; j <= 100; j += 1) {
      const t = j / 100;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
    }
  }
  return false;
}

// Existing straight and single-cubic paths retain the pre-fix result exactly.
const straight = { type: 'straight', start: { x: 2, y: 3 }, end: { x: 8, y: 13 } };
assert.deepEqual(plain(api.getAnnotationPolyline(straight, 50)), [straight.start, straight.end]);
passed += 1;

const single = makeSingleCurve();
const legacySingle = legacyPolyline(single, 50);
assert.deepEqual(plain(api.getAnnotationPolyline(single, 50)), plain(legacySingle));
assert.deepEqual(plain(api.getAnnotationPolyline({ ...single, points: [] }, 50)), plain(legacySingle));
passed += 2;

// De Casteljau-added anchors do not change the shape or meaningfully move the
// measured value for the original one-to-four-anchor cases.
const singleLength = api.polylineLength(legacySingle);
for (let count = 1; count <= 4; count += 1) {
  const split = makeSingleCurve();
  split.points = [];
  for (let i = 0; i < count; i += 1) api.insertCurveAnchorAt(split, split.points.length, 0.5);
  const splitLength = api.polylineLength(api.getAnnotationPolyline(split, 50));
  check(Math.abs(splitLength - singleLength) < 0.08,
    `${count} shape-preserving anchor(s) changed length by ${(splitLength - singleLength).toFixed(4)}px`);
}

const many = makeSCurve(30);
const adaptive = api.getAnnotationPolyline(many, 50);
const old = legacyPolyline(many, 50);
const dense = densePolyline(many);
const adaptiveLength = api.polylineLength(adaptive);
const oldLength = api.polylineLength(old);
const denseLength = api.polylineLength(dense);
const adaptiveError = Math.abs(adaptiveLength - denseLength) / denseLength;
const oldUndercount = (denseLength - oldLength) / denseLength;

check(adaptive.length >= 30 * 24 + 1,
  `30 segments received only ${adaptive.length - 1} chords; every segment needs its own adaptive floor`);
check(adaptive.length <= 30 * 512 + 1,
  '30 segments exceeded the 512-evaluation per-segment safety cap');
check(api.getAnnotationPolyline(many, 20000).length <= 30 * 512 + 1,
  'an oversized caller budget bypassed the 512-evaluation per-segment safety cap');
check(adaptiveError < 0.001,
  `adaptive length drifted ${(adaptiveError * 100).toFixed(3)}% from dense truth`);
check(oldUndercount > 0.75,
  `negative control is too weak: old two-chord sampling under-counted only ${(oldUndercount * 100).toFixed(1)}%`);

// Measurement scale uses the corrected drawn length, while the polyline is
// independent of zoom/device state.
check(Math.abs(api.lineLength({ ...many, measureScale: 2 }) - adaptiveLength / 2) < 1e-9,
  'lineLength did not apply measureScale to the adaptively sampled curve');
context.state.zoom = 4;
assert.deepEqual(plain(api.getAnnotationPolyline(many, 50)), plain(adaptive));
passed += 1;
context.state.zoom = 1;

// A point on the first S-bend sits far from the two-chord alias. Production
// hit-testing and marquee selection must see the drawn bulge, not its chord.
const highBendSeg = curveSegments(many)[6];
const bulge = api.bezierPoint(...highBendSeg, 0.25);
check(nearestPolylineDistance(bulge, old) > 20,
  'negative control no longer aliases the S-bend far enough to prove the hit-test regression');
check(api.isPointNearAnnotation(bulge, many, 0.5),
  'hit-testing missed a point on the multi-anchor curve bulge');
check(api.annotationTouchesRect(many, bulge.x - 1, bulge.y - 1, bulge.x + 1, bulge.y + 1),
  'marquee selection missed a 2px box crossed by the multi-anchor curve');
check(!touchesRect(old, bulge, 1),
  'negative-control marquee unexpectedly touches the S-bend box');

// Stitches and default callout placement both consume the same polyline. Their
// arc-length samples stay close to a dense reference, including the tangent
// used to offset the label.
const denseQuarter = api.samplePolylineAt(dense, denseLength * 0.25);
const adaptiveQuarter = api.samplePolylineAt(adaptive, adaptiveLength * 0.25);
check(Math.hypot(adaptiveQuarter.point.x - denseQuarter.point.x,
  adaptiveQuarter.point.y - denseQuarter.point.y) < 0.2,
  'stitch arc-length sampling drifted from the dense curve');

const denseHalf = api.samplePolylineAt(dense, denseLength / 2);
const expectedLabel = {
  x: denseHalf.point.x - denseHalf.normal.x * 20,
  y: denseHalf.point.y - denseHalf.normal.y * 20,
};
const actualLabel = api.computeDefaultLabelPosition(many);
check(Math.hypot(actualLabel.x - expectedLabel.x, actualLabel.y - expectedLabel.y) < 0.5,
  'default curve label did not stay at the dense half-arc position');

// The work stays linear and bounded even for an intentionally excessive
// 100-segment annotation. This is a generous smoke guard, not a microbenchmark.
const hundred = makeSCurve(100);
const started = performance.now();
const hundredPolyline = api.getAnnotationPolyline(hundred, 50);
const elapsedMs = performance.now() - started;
check(hundredPolyline.length <= 100 * 512 + 1,
  '100-segment sampling exceeded its structural cap');
check(elapsedMs < 250,
  `100-segment sampling took ${elapsedMs.toFixed(1)}ms (expected <250ms)`);

console.log(`curve-polyline-tests: PASS (${passed} checks; 30-segment length ${adaptiveLength.toFixed(2)} vs dense ${denseLength.toFixed(2)}, old ${oldLength.toFixed(2)}; 100 segments ${elapsedMs.toFixed(1)}ms)`);
