// US-109 Automatic Semantic ROI metrics. Numeric release thresholds do not
// live here; this module only computes evidence for TD calibration.

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i], b = polygon[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < ((b.x - a.x) * (point.y - a.y)) / Math.max(1e-12, b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator))
    : 0;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function boundaryDistances(fromPolygon, toPolygon) {
  return fromPolygon.map(point => {
    let best = Infinity;
    for (let index = 0; index < toPolygon.length; index += 1) {
      best = Math.min(best, pointSegmentDistance(point, toPolygon[index], toPolygon[(index + 1) % toPolygon.length]));
    }
    return best;
  });
}

export function scoreSemanticRoiPair(oraclePolygon, predictedPolygon, gridSize = 192) {
  let oraclePixels = 0, predictedPixels = 0, intersection = 0, union = 0;
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const point = { x: (x + 0.5) / gridSize, y: (y + 0.5) / gridSize };
      const inOracle = pointInPolygon(point, oraclePolygon);
      const inPredicted = pointInPolygon(point, predictedPolygon);
      if (inOracle) oraclePixels += 1;
      if (inPredicted) predictedPixels += 1;
      if (inOracle && inPredicted) intersection += 1;
      if (inOracle || inPredicted) union += 1;
    }
  }
  const distances = boundaryDistances(oraclePolygon, predictedPolygon)
    .concat(boundaryDistances(predictedPolygon, oraclePolygon));
  return {
    polygonIou: union ? intersection / union : 1,
    missedCoverage: oraclePixels ? (oraclePixels - intersection) / oraclePixels : 0,
    excessCoverage: predictedPixels ? (predictedPixels - intersection) / predictedPixels : 0,
    meanBoundaryError: distances.reduce((sum, value) => sum + value, 0) / Math.max(1, distances.length),
    maxBoundaryError: Math.max(0, ...distances),
  };
}

export function scoreAutomaticRoiImage(oracleRecords, predictedRecords) {
  const confirmed = oracleRecords.filter(record => record.source === 'td_confirmed');
  const oracleByIdentity = new Map(confirmed.map(record => [`${record.zone}:${record.side}`, record]));
  const predictedByIdentity = new Map(predictedRecords.map(record => [`${record.zone}:${record.side}`, record]));
  const pairs = [];
  let falseRois = 0;
  for (const predicted of predictedRecords) {
    const oracle = oracleByIdentity.get(`${predicted.zone}:${predicted.side}`);
    if (!oracle || oracle.availability !== 'available') {
      falseRois += 1;
      continue;
    }
    pairs.push({
      zone: oracle.zone,
      side: oracle.side,
      ...scoreSemanticRoiPair(oracle.polygon, predicted.polygon),
    });
  }
  const available = confirmed.filter(record => record.availability === 'available');
  const exactMatches = available.filter(record => predictedByIdentity.has(`${record.zone}:${record.side}`)).length;
  const mean = key => pairs.length ? pairs.reduce((sum, pair) => sum + pair[key], 0) / pairs.length : null;
  return {
    confirmedOracleCount: confirmed.length,
    availableOracleCount: available.length,
    exactZoneSideMatches: exactMatches,
    exactZoneSideRecall: available.length ? exactMatches / available.length : null,
    falseRoisPerImage: falseRois,
    meanPolygonIou: mean('polygonIou'),
    meanBoundaryError: mean('meanBoundaryError'),
    meanMissedCoverage: mean('missedCoverage'),
    meanExcessCoverage: mean('excessCoverage'),
    pairs,
  };
}
