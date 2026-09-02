// US-109 Auto Seam — corridor machinery shared by both lanes: the quadratic
// seed path, the per-station strongest-edge refinement, the median-offset
// centerline, path and corridor evidence features, the ROI corridor polygon
// and the averaged knot helper. Pure. Source part for app.js.

  function autoSeamQuadraticPoint(points, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * points[0].x + 2 * mt * t * points[1].x + t * t * points[2].x,
      y: mt * mt * points[0].y + 2 * mt * t * points[1].y + t * t * points[2].y,
    };
  }

  function autoSeamQuadraticTangent(points, t) {
    return {
      x: 2 * (1 - t) * (points[1].x - points[0].x) + 2 * t * (points[2].x - points[1].x),
      y: 2 * (1 - t) * (points[1].y - points[0].y) + 2 * t * (points[2].y - points[1].y),
    };
  }

  function autoSeamRefinePath(model, seed, gradientThreshold, sampleCount = 49) {
    const samples = [];
    const searchRadius = Math.max(2, Math.round(Math.min(model.width, model.height) * 0.018));
    let previousOffset = 0;
    const count = sampleCount;
    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const base = autoSeamQuadraticPoint(seed.points, t);
      const tangent = autoSeamQuadraticTangent(seed.points, t);
      const length = Math.max(0.0001, Math.hypot(tangent.x, tangent.y));
      const normal = { x: -tangent.y / length, y: tangent.x / length };
      let best = null;
      let rawBest = null;
      for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
        const point = { x: base.x + normal.x * offset, y: base.y + normal.y * offset };
        const gradient = autoSeamSampleAt(model.gradient, model.width, model.height, point);
        const rawScore = gradient - Math.abs(offset) * 0.05;
        const continuityPenalty = Math.abs(offset - previousOffset) * Math.max(0.3, gradientThreshold * 0.035);
        const score = gradient - continuityPenalty - Math.abs(offset) * 0.05;
        if (!rawBest || rawScore > rawBest.score) rawBest = { offset, score: rawScore };
        if (!best || score > best.score) best = { point, gradient, offset, score };
      }
      previousOffset = best.offset * 0.72 + previousOffset * 0.28;
      samples.push({
        x: best.point.x,
        y: best.point.y,
        gradient: best.gradient,
        gradientX: autoSeamSampleAt(model.gradientX, model.width, model.height, best.point),
        gradientY: autoSeamSampleAt(model.gradientY, model.width, model.height, best.point),
        luma: autoSeamSampleAt(model.luma, model.width, model.height, best.point),
        rawOffset: rawBest.offset,
        searchRadius,
      });
    }
    return samples;
  }

  // A local median of the per-station strongest-edge offset. On a zigzag this
  // cancels the individual tooth-to-tooth jumps and leaves the corridor's true
  // centerline; used both as the alternation baseline below and, on the
  // technical-flat lane, as the actual drawn geometry (see
  // autoSeamSmoothedStationPoints in src/auto/seam/technical-flat.js).
  function autoSeamMedianOffsets(samples, halfWindow = 4) {
    const offsets = samples.map(sample => sample.rawOffset || 0);
    return offsets.map((offset, index) => {
      const from = Math.max(0, index - halfWindow);
      const to = Math.min(offsets.length, index + halfWindow + 1);
      const local = offsets.slice(from, to).sort((a, b) => a - b);
      return local[Math.floor(local.length / 2)] || 0;
    });
  }

  function autoSeamEvidence(samples, lowGradient, highGradient) {
    const gradients = samples.map(sample => sample.gradient);
    const meanGradient = gradients.reduce((sum, value) => sum + value, 0) / gradients.length;
    const support = gradients.filter(value => value >= highGradient).length / gradients.length;
    const continuity = gradients.filter(value => value >= lowGradient).length / gradients.length;
    const highPass = samples.map((sample, index) => {
      if (index === 0 || index === samples.length - 1) return 0;
      return sample.luma - (samples[index - 1].luma + samples[index + 1].luma) / 2;
    });
    const hpScale = Math.max(2, autoSeamPercentile(highPass.map(Math.abs), 0.65));
    let changes = 0, activePairs = 0, previousSign = 0;
    const peaks = [];
    for (let index = 1; index < highPass.length - 1; index += 1) {
      const value = highPass[index];
      if (Math.abs(value) >= hpScale) {
        const sign = Math.sign(value);
        if (previousSign && sign !== previousSign) changes += 1;
        if (previousSign) activePairs += 1;
        previousSign = sign;
      }
      if (Math.abs(value) >= hpScale && Math.abs(value) >= Math.abs(highPass[index - 1])
          && Math.abs(value) >= Math.abs(highPass[index + 1])) peaks.push(index);
    }
    const alternation = activePairs ? changes / activePairs : 0;
    let diagonalSum = 0, diagonalCount = 0, diagonalChanges = 0, diagonalPairs = 0, previousDiagonalSign = 0;
    for (let index = 1; index < samples.length - 1; index += 1) {
      const before = samples[index - 1], current = samples[index], after = samples[index + 1];
      const txRaw = after.x - before.x, tyRaw = after.y - before.y;
      const tangentLength = Math.max(0.0001, Math.hypot(txRaw, tyRaw));
      const tx = txRaw / tangentLength, ty = tyRaw / tangentLength;
      const nx = -ty, ny = tx;
      const along = current.gradientX * tx + current.gradientY * ty;
      const normal = current.gradientX * nx + current.gradientY * ny;
      const major = Math.max(Math.abs(along), Math.abs(normal));
      const diagonalRatio = major > 0 ? Math.min(Math.abs(along), Math.abs(normal)) / major : 0;
      if (current.gradient >= lowGradient) {
        diagonalSum += diagonalRatio;
        diagonalCount += 1;
        if (diagonalRatio >= 0.22) {
          const sign = Math.sign(along);
          if (previousDiagonalSign && sign !== previousDiagonalSign) diagonalChanges += 1;
          if (previousDiagonalSign) diagonalPairs += 1;
          previousDiagonalSign = sign;
        }
      }
    }
    const diagonalEnergy = diagonalCount ? diagonalSum / diagonalCount : 0;
    const diagonalAlternation = diagonalPairs ? diagonalChanges / diagonalPairs : 0;
    // A smooth seam edge can have strong, continuous gradients and still not
    // be a Zigzag stitch. Track the strongest source edge independently at
    // each station, remove slow seed/path drift, then require repeated lateral
    // reversals. This is a source-pixel signal; it does not use fixture labels.
    const offsets = samples.map(sample => sample.rawOffset || 0);
    const medianOffsets = autoSeamMedianOffsets(samples);
    const residuals = offsets.map((offset, index) => offset - medianOffsets[index]);
    const radius = Math.max(1, samples[0]?.searchRadius || 1);
    const lateralThreshold = Math.max(1, radius * 0.16);
    let lateralChanges = 0, lateralPairs = 0, previousLateralSign = 0, activeLateral = 0;
    for (const residual of residuals) {
      if (Math.abs(residual) < lateralThreshold) continue;
      activeLateral += 1;
      const sign = Math.sign(residual);
      if (previousLateralSign && sign !== previousLateralSign) lateralChanges += 1;
      if (previousLateralSign) lateralPairs += 1;
      previousLateralSign = sign;
    }
    const lateralAlternation = lateralPairs ? lateralChanges / lateralPairs : 0;
    const lateralActivity = activeLateral / residuals.length;
    const lateralAmplitude = autoSeamClamp01(
      residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length / Math.max(1, radius * 0.42));
    const spacings = peaks.slice(1).map((peak, index) => peak - peaks[index]);
    let periodicity = 0;
    if (spacings.length >= 2) {
      const mean = spacings.reduce((sum, value) => sum + value, 0) / spacings.length;
      const deviation = Math.sqrt(spacings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / spacings.length);
      periodicity = autoSeamClamp01(1 - deviation / Math.max(1, mean));
    }
    const strength = autoSeamClamp01(meanGradient / Math.max(1, highGradient * 1.55));
    const overall = 0.18 * support + 0.14 * continuity + 0.08 * alternation + 0.08 * periodicity
      + 0.08 * strength + 0.10 * diagonalEnergy + 0.08 * diagonalAlternation
      + 0.12 * lateralActivity + 0.08 * lateralAmplitude + 0.06 * lateralAlternation;
    return {
      pathSupport: support, continuity, periodicity, alternation, diagonalEnergy, diagonalAlternation,
      lateralActivity, lateralAmplitude, lateralAlternation, strength, overall,
    };
  }

  function autoSeamCorridorEvidence(model, seed, lowGradient) {
    const searchRadius = Math.max(2, Math.round(Math.min(model.width, model.height) * 0.018));
    let totalEnergy = 0, diagonalEnergy = 0, positiveEnergy = 0, negativeEnergy = 0;
    let twoSidedStations = 0;
    let diagonalStations = 0, dominantStations = 0, dominantChanges = 0, previousDominant = 0;
    const stationCount = 49;
    for (let index = 0; index < stationCount; index += 1) {
      const t = index / (stationCount - 1);
      const base = autoSeamQuadraticPoint(seed.points, t);
      const tangent = autoSeamQuadraticTangent(seed.points, t);
      const length = Math.max(0.0001, Math.hypot(tangent.x, tangent.y));
      const tx = tangent.x / length, ty = tangent.y / length;
      const nx = -ty, ny = tx;
      let stationPositive = 0, stationNegative = 0;
      for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
        const point = { x: base.x + nx * offset, y: base.y + ny * offset };
        const gx = autoSeamSampleAt(model.gradientX, model.width, model.height, point);
        const gy = autoSeamSampleAt(model.gradientY, model.width, model.height, point);
        const magnitude = Math.hypot(gx, gy);
        if (magnitude < lowGradient) continue;
        const along = gx * tx + gy * ty;
        const normal = gx * nx + gy * ny;
        const major = Math.max(Math.abs(along), Math.abs(normal));
        const ratio = major ? Math.min(Math.abs(along), Math.abs(normal)) / major : 0;
        totalEnergy += magnitude;
        if (ratio < 0.28) continue;
        diagonalEnergy += magnitude;
        if (along * normal >= 0) {
          positiveEnergy += magnitude;
          stationPositive += magnitude;
        } else {
          negativeEnergy += magnitude;
          stationNegative += magnitude;
        }
      }
      if (stationPositive >= lowGradient && stationNegative >= lowGradient) twoSidedStations += 1;
      const stationDiagonal = stationPositive + stationNegative;
      if (stationDiagonal >= lowGradient * 1.5) diagonalStations += 1;
      if (stationDiagonal > 0
          && Math.abs(stationPositive - stationNegative) / stationDiagonal >= 0.14) {
        const dominant = stationPositive > stationNegative ? 1 : -1;
        if (previousDominant && dominant !== previousDominant) dominantChanges += 1;
        previousDominant = dominant;
        dominantStations += 1;
      }
    }
    return {
      corridorDiagonalShare: totalEnergy ? diagonalEnergy / totalEnergy : 0,
      corridorDiagonalBalance: Math.max(positiveEnergy, negativeEnergy)
        ? Math.min(positiveEnergy, negativeEnergy) / Math.max(positiveEnergy, negativeEnergy) : 0,
      corridorTwoSidedCoverage: twoSidedStations / stationCount,
      corridorDiagonalCoverage: diagonalStations / stationCount,
      corridorDominantCoverage: dominantStations / stationCount,
      corridorDominantChangeDensity: dominantChanges / Math.max(1, stationCount - 1),
    };
  }

  function autoSeamCorridorPolygon(model, seed) {
    const radius = Math.max(3, Math.min(model.width, model.height) * 0.035);
    const left = [], right = [];
    for (const t of [0, 0.5, 1]) {
      const point = autoSeamQuadraticPoint(seed.points, t);
      const tangent = autoSeamQuadraticTangent(seed.points, t);
      const length = Math.max(0.0001, Math.hypot(tangent.x, tangent.y));
      const normal = { x: -tangent.y / length, y: tangent.x / length };
      left.push(autoSeamNormalizePoint(model, { x: point.x + normal.x * radius, y: point.y + normal.y * radius }));
      right.push(autoSeamNormalizePoint(model, { x: point.x - normal.x * radius, y: point.y - normal.y * radius }));
    }
    return left.concat(right.reverse());
  }

  function autoSeamRefinedKnot(model, refined, index) {
    const from = Math.max(0, index - 2);
    const to = Math.min(refined.length, index + 3);
    const samples = refined.slice(from, to);
    const average = samples.reduce((point, sample) => ({ x: point.x + sample.x, y: point.y + sample.y }), { x: 0, y: 0 });
    return autoSeamNormalizePoint(model, { x: average.x / samples.length, y: average.y / samples.length });
  }
