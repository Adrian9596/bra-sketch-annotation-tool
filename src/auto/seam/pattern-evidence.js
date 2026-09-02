// US-118 Auto Seam — source-pixel appearance evidence for non-zigzag lines
// in the technical-flat lane. A proportional Semantic ROI only says where to
// inspect; every accepted appearance must still form a coherent source-pixel
// path. Pure. Source part for app.js.

  function autoSeamBinaryRuns(sequence) {
    const runs = [];
    let start = null;
    for (let index = 0; index <= sequence.length; index += 1) {
      const active = index < sequence.length && sequence[index];
      if (active && start === null) start = index;
      if (!active && start !== null) {
        runs.push({ start, end: index - 1, length: index - start });
        start = null;
      }
    }
    return runs;
  }

  function autoSeamMedian(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function autoSeamPatternSequenceEvidence(sequence) {
    const runs = autoSeamBinaryRuns(sequence);
    const gaps = [];
    for (let index = 1; index < runs.length; index += 1) {
      gaps.push(runs[index].start - runs[index - 1].end - 1);
    }
    const occupancy = sequence.filter(Boolean).length / Math.max(1, sequence.length);
    const runLengths = runs.map(run => run.length);
    const medianRun = autoSeamMedian(runLengths);
    const medianGap = autoSeamMedian(gaps);
    const dispersion = values => {
      if (values.length < 2) return 1;
      const median = Math.max(1, autoSeamMedian(values));
      return values.reduce((sum, value) => sum + Math.abs(value - median), 0) / values.length / median;
    };
    const periodicity = autoSeamClamp01(1 - (dispersion(runLengths) + dispersion(gaps)) / 2);
    return { occupancy, runCount: runs.length, medianRun, medianGap, periodicity };
  }

  function autoSeamInkNear(model, point, inkCut) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (autoSeamSampleAt(model.luma, model.width, model.height,
          { x: point.x + dx, y: point.y + dy }) <= inkCut) return true;
      }
    }
    return false;
  }

  function autoSeamTechnicalPatternEvidence(model, seed, refined) {
    const rules = AUTO_SEAM_THRESHOLDS.technicalFlat.pattern;
    const points = autoSeamSmoothedStationPoints(seed, refined);
    const inkCut = model.bgLuma - rules.inkCutBelowBackground;
    const radius = Math.max(rules.minimumRadius,
      Math.round(Math.min(model.width, model.height) * rules.normalRadius));
    const sequences = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sequence = points.map((point, index) => {
        const before = points[Math.max(0, index - 1)];
        const after = points[Math.min(points.length - 1, index + 1)];
        const tx = after.x - before.x;
        const ty = after.y - before.y;
        const length = Math.max(0.0001, Math.hypot(tx, ty));
        return autoSeamInkNear(model, {
          x: point.x - ty / length * offset,
          y: point.y + tx / length * offset,
        }, inkCut);
      });
      sequences.push({ offset, sequence, ...autoSeamPatternSequenceEvidence(sequence) });
    }

    const solid = sequences
      .filter(item => item.occupancy >= rules.solid.occupancy)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0] || null;
    const dashed = sequences
      .filter(item => item.occupancy >= rules.dashed.occupancyMin
        && item.occupancy <= rules.dashed.occupancyMax
        && item.runCount >= rules.dashed.runCount
        && item.medianRun >= rules.dashed.medianRunMin
        && item.medianGap >= rules.dashed.medianGapMin
        && item.periodicity >= rules.dashed.periodicity)
      .sort((a, b) => b.periodicity - a.periodicity || Math.abs(a.offset) - Math.abs(b.offset));

    let pair = null;
    for (let leftIndex = 0; leftIndex < dashed.length && !pair; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < dashed.length; rightIndex += 1) {
        const first = dashed[leftIndex];
        const second = dashed[rightIndex];
        const spacing = Math.abs(first.offset - second.offset);
        if (spacing < rules.parallel.spacingMin || spacing > rules.parallel.spacingMax) continue;
        let union = 0;
        let overlap = 0;
        for (let index = 0; index < first.sequence.length; index += 1) {
          if (first.sequence[index] || second.sequence[index]) union += 1;
          if (first.sequence[index] && second.sequence[index]) overlap += 1;
        }
        const alignment = overlap / Math.max(1, union);
        if (alignment >= rules.parallel.alignmentMin) {
          pair = { first, second, spacing, alignment };
          break;
        }
      }
    }

    let appearanceType = null;
    let selected = null;
    if (pair) {
      appearanceType = 'parallel_dashed';
      selected = pair.first;
    } else if (dashed.length) {
      appearanceType = 'single_dashed';
      selected = dashed[0];
    } else if (solid) {
      appearanceType = 'solid_plain';
      selected = solid;
    }
    return {
      appearanceType,
      selectedOffset: selected?.offset ?? 0,
      patternInkOccupancy: selected?.occupancy ?? 0,
      patternRunCount: autoSeamClamp01((selected?.runCount ?? 0) / 16),
      patternPeriodicity: selected?.periodicity ?? 0,
      patternPairSpacing: pair ? autoSeamClamp01(pair.spacing / Math.max(1, radius * 2)) : 0,
      patternPairAlignment: pair?.alignment ?? 0,
    };
  }
