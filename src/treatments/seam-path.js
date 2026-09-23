// US-125 / ADR 0092-0098: Semantic Seam Path + Treatment Run model.
//
// The annotation's existing start/control/points/end fields remain the ONE
// centerline geometry authority. `seamPath` is additive metadata: stable node
// identity, topology/evidence, and exhaustive treatment ownership. Treatment
// Runs reference node ids and never duplicate cubic geometry.
// Source part for app.js. Run `npm run build` after editing.

  function seamPathSchemaVersion() { return 'seam-path/1'; }
  function seamPathTraceVersion() { return 'normalized-detection-trace/1'; }

  function seamPathStableValue(value) {
    if (Array.isArray(value)) return value.map(seamPathStableValue);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = seamPathStableValue(value[key]);
    return out;
  }

  function seamPathStableStringify(value) {
    return JSON.stringify(seamPathStableValue(value));
  }

  function seamPathHash(prefix, value) {
    const text = seamPathStableStringify(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return prefix + '-' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function seamPathFinitePoint(point) {
    return !!point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
  }

  function seamPathCleanPoint(point) {
    return { x: Number(point.x), y: Number(point.y) };
  }

  function seamPathNormalizedTrace(raw, sourceImageId, sourceSha256) {
    if (!raw || raw.version !== seamPathTraceVersion() || !Array.isArray(raw.points)) return null;
    const points = raw.points.filter(seamPathFinitePoint).map(point => ({
      x: clamp(Number(point.x), 0, 1),
      y: clamp(Number(point.y), 0, 1),
    }));
    if (points.length < 2) return null;
    return {
      version: seamPathTraceVersion(),
      coordinateSpace: 'source-normalized',
      sourceImageId: raw.sourceImageId != null ? raw.sourceImageId : sourceImageId,
      sourceSha256: String(raw.sourceSha256 || sourceSha256 || ''),
      points,
    };
  }

  function seamPathNodeIds(ann) {
    if (!ann || !ann.seamPath) return [];
    return [ann.seamPath.startNodeId]
      .concat((ann.points || []).map(point => point.nodeId))
      .concat([ann.seamPath.endNodeId]);
  }

  function seamPathNodePoints(ann) {
    return [ann.start].concat((ann.points || []).map(point => point.point)).concat([ann.end]);
  }

  function seamPathNodeIndex(ann, nodeId) {
    return seamPathNodeIds(ann).indexOf(nodeId);
  }

  function seamPathNewNodeId(ann, seam, used) {
    let sequence = Math.max(1, Number.isInteger(seam.nextNodeSequence) ? seam.nextNodeSequence : 1);
    let id;
    do {
      id = 'spn-' + String(ann.id) + '-' + sequence;
      sequence += 1;
    } while (used.has(id));
    seam.nextNodeSequence = sequence;
    used.add(id);
    return id;
  }

  function seamPathNewRunId(ann, seam, used) {
    let sequence = Math.max(1, Number.isInteger(seam.nextRunSequence) ? seam.nextRunSequence : 1);
    let id;
    do {
      id = 'str-' + String(ann.id) + '-' + sequence;
      sequence += 1;
    } while (used.has(id));
    seam.nextRunSequence = sequence;
    used.add(id);
    return id;
  }

  function seamPathLegacyTreatment(ann) {
    const existing = normalizeLineTreatment(ann && ann.lineTreatment);
    if (existing) return existing;
    return normalizeLineTreatment(null, {
      name: 'Existing ' + (normalizeLineStyle(ann && ann.style) || 'plain') + ' appearance',
      style: normalizeLineStyle(ann && ann.style),
      color: normalizeColorKey(ann && ann.color),
      lineWidth: normalizeLineWidth(ann && ann.lineWidth),
    });
  }

  function seamPathGeometryPayload(ann) {
    if (!ann || !ann.start || !ann.end) return null;
    const point = value => seamPathCleanPoint(value);
    return {
      version: seamPathSchemaVersion(),
      type: ann.type === 'straight' ? 'straight' : 'curved',
      closed: !!ann.seamPath?.closed,
      start: point(ann.start),
      control1: ann.type === 'curved' && ann.control1 ? point(ann.control1) : null,
      points: ann.type === 'curved' ? (ann.points || []).map(node => ({
        point: point(node.point),
        handleIn: point(node.handleIn),
        handleOut: point(node.handleOut),
      })) : [],
      control2: ann.type === 'curved' && ann.control2 ? point(ann.control2) : null,
      end: point(ann.end),
    };
  }

  function seamPathGeometryFingerprint(ann) {
    return seamPathHash('spg1', seamPathGeometryPayload(ann));
  }

  function seamPathTechnicalPayload(ann) {
    const ids = seamPathNodeIds(ann);
    const indexById = new Map(ids.map((id, index) => [id, index]));
    return {
      version: seamPathSchemaVersion(),
      geometryFingerprint: seamPathGeometryFingerprint(ann),
      treatmentRuns: (ann.seamPath?.treatmentRuns || []).map(run => ({
        startNodeIndex: indexById.get(run.startNodeId),
        endNodeIndex: indexById.get(run.endNodeId),
        wrap: !!run.wrap,
        treatment: normalizeLineTreatment(run.treatment),
      })),
    };
  }

  function seamPathTechnicalContentFingerprint(ann) {
    return seamPathHash('spt1', seamPathTechnicalPayload(ann));
  }

  function seamPathRefreshFingerprints(ann, invalidateApproval = true) {
    if (!ann || !ann.seamPath) return { geometryChanged: false, technicalChanged: false };
    const beforeGeometry = ann.seamPath.geometryFingerprint || null;
    const beforeTechnical = ann.seamPath.technicalContentFingerprint || null;
    const geometryFingerprint = seamPathGeometryFingerprint(ann);
    const technicalContentFingerprint = seamPathTechnicalContentFingerprint(ann);
    const geometryChanged = !!beforeGeometry && beforeGeometry !== geometryFingerprint;
    const technicalChanged = !!beforeTechnical && beforeTechnical !== technicalContentFingerprint;
    ann.seamPath.geometryFingerprint = geometryFingerprint;
    ann.seamPath.technicalContentFingerprint = technicalContentFingerprint;
    if (invalidateApproval && (geometryChanged || technicalChanged)) {
      ann.tdApproved = false;
      ann.tdApprovalRequired = true;
      ann.approvedAt = null;
      if (isTDReviewDraft(ann)) ann.tdEdited = true;
      if (geometryChanged && ann.seamPath.fidelityReceipt) {
        ann.seamPath.fidelityReceipt = {
          ...ann.seamPath.fidelityReceipt,
          status: 'review',
          invalidatedReason: 'td_geometry_changed',
        };
      }
    }
    return { geometryChanged, technicalChanged, geometryFingerprint, technicalContentFingerprint };
  }

  function seamPathRefreshAllFingerprints() {
    for (const ann of state.annotations || []) {
      if (ann && ann.seamPath) seamPathRefreshFingerprints(ann, true);
    }
  }

  function seamPathNormalizeRunList(ann, seam, fallbackTreatment) {
    const nodeIds = seamPathNodeIds(ann);
    const indexById = new Map(nodeIds.map((id, index) => [id, index]));
    const rawRuns = Array.isArray(seam.treatmentRuns) ? seam.treatmentRuns : [];
    const usedRunIds = new Set();
    if (!rawRuns.length) {
      seam.validationStatus = 'pass';
      seam.validationReasons = [];
      return [{
        id: seamPathNewRunId(ann, seam, usedRunIds),
        startNodeId: nodeIds[0],
        endNodeId: nodeIds[nodeIds.length - 1],
        wrap: false,
        treatment: clone(fallbackTreatment),
      }];
    }
    const normalized = [];
    let malformed = false;
    for (const raw of rawRuns) {
      const startIndex = indexById.get(raw && raw.startNodeId);
      const endIndex = indexById.get(raw && raw.endNodeId);
      const wrap = raw && raw.wrap === true;
      const treatment = normalizeLineTreatment(raw && raw.treatment);
      if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)
          || !treatment
          || (!seam.closed && (wrap || startIndex >= endIndex))
          || (seam.closed && (startIndex === endIndex
            || (wrap ? startIndex < endIndex : startIndex > endIndex)))) {
        malformed = true;
        continue;
      }
      let id = typeof raw.id === 'string' && raw.id && !usedRunIds.has(raw.id) ? raw.id : null;
      if (!id) id = seamPathNewRunId(ann, seam, usedRunIds);
      else usedRunIds.add(id);
      normalized.push({ id, startNodeId: nodeIds[startIndex], endNodeId: nodeIds[endIndex], wrap, treatment });
    }
    normalized.sort((left, right) => indexById.get(left.startNodeId) - indexById.get(right.startNodeId));
    let exhaustive = false;
    if (seam.closed && normalized.length) {
      const segmentCount = nodeIds.length - 1;
      const ownership = Array(segmentCount).fill(0);
      for (const run of normalized) {
        const startIndex = indexById.get(run.startNodeId);
        const endIndex = indexById.get(run.endNodeId);
        if (run.wrap) {
          for (let index = startIndex; index < segmentCount; index += 1) ownership[index] += 1;
          for (let index = 0; index < endIndex; index += 1) ownership[index] += 1;
        } else {
          for (let index = startIndex; index < endIndex; index += 1) ownership[index] += 1;
        }
      }
      exhaustive = ownership.length > 0 && ownership.every(count => count === 1);
    } else {
      exhaustive = normalized.length > 0
        && normalized[0].startNodeId === nodeIds[0]
        && normalized[normalized.length - 1].endNodeId === nodeIds[nodeIds.length - 1]
        && normalized.every((run, index) => !index
          || normalized[index - 1].endNodeId === run.startNodeId);
    }
    if (!exhaustive || malformed) {
      const runId = normalized.length === 1 ? normalized[0].id
        : seamPathNewRunId(ann, seam, usedRunIds);
      seam.validationStatus = 'review';
      seam.validationReasons = ['invalid_or_non_exhaustive_treatment_runs'];
      return [{
        id: runId,
        startNodeId: nodeIds[0],
        endNodeId: nodeIds[nodeIds.length - 1],
        wrap: false,
        treatment: clone(fallbackTreatment),
      }];
    }
    seam.validationStatus = 'pass';
    seam.validationReasons = [];
    return normalized;
  }

  function normalizeSeamPathAnnotation(ann) {
    if (!ann || !ann.seamPath || !ann.start || !ann.end
        || !['straight', 'curved'].includes(ann.type)) return null;
    if (ann.type === 'curved') ensureCurveControls(ann);
    const source = ann.seamPath && typeof ann.seamPath === 'object' ? ann.seamPath : {};
    const seam = {
      version: seamPathSchemaVersion(),
      closed: source.closed === true,
      startNodeId: typeof source.startNodeId === 'string' ? source.startNodeId : null,
      endNodeId: typeof source.endNodeId === 'string' ? source.endNodeId : null,
      nextNodeSequence: Number.isInteger(source.nextNodeSequence) ? source.nextNodeSequence : 1,
      nextRunSequence: Number.isInteger(source.nextRunSequence) ? source.nextRunSequence : 1,
      treatmentRuns: Array.isArray(source.treatmentRuns) ? clone(source.treatmentRuns) : [],
      detectionTrace: seamPathNormalizedTrace(source.detectionTrace,
        ann.sourceImageId, ann.sourceSha256),
      endpointTopology: source.endpointTopology ? clone(source.endpointTopology) : null,
      pathCompleteness: source.pathCompleteness ? clone(source.pathCompleteness) : null,
      fidelityReceipt: source.fidelityReceipt ? clone(source.fidelityReceipt) : null,
      geometryFingerprint: source.geometryFingerprint || null,
      technicalContentFingerprint: source.technicalContentFingerprint || null,
      validationStatus: source.validationStatus || 'pass',
      validationReasons: Array.isArray(source.validationReasons) ? source.validationReasons.slice() : [],
    };
    ann.seamPath = seam;
    const usedNodeIds = new Set();
    if (!seam.startNodeId || usedNodeIds.has(seam.startNodeId)) {
      seam.startNodeId = seamPathNewNodeId(ann, seam, usedNodeIds);
    } else usedNodeIds.add(seam.startNodeId);
    for (const point of ann.points || []) {
      if (!point.nodeId || usedNodeIds.has(point.nodeId)) {
        point.nodeId = seamPathNewNodeId(ann, seam, usedNodeIds);
      } else usedNodeIds.add(point.nodeId);
    }
    if (!seam.endNodeId || usedNodeIds.has(seam.endNodeId)) {
      seam.endNodeId = seamPathNewNodeId(ann, seam, usedNodeIds);
    } else usedNodeIds.add(seam.endNodeId);

    const fallbackTreatment = seamPathLegacyTreatment(ann);
    seam.treatmentRuns = seamPathNormalizeRunList(ann, seam, fallbackTreatment);
    if (seam.closed && distance(ann.start, ann.end) > 1e-6) {
      seam.validationStatus = 'review';
      if (!seam.validationReasons.includes('closed_path_endpoints_not_coincident')) {
        seam.validationReasons.push('closed_path_endpoints_not_coincident');
      }
    }
    ann.lineTreatment = clone(seam.treatmentRuns[0].treatment);
    ann.purpose = 'sketch-element';
    seamPathRefreshFingerprints(ann, !!(source.geometryFingerprint || source.technicalContentFingerprint));
    return seam;
  }

  function ensureSeamPathAnnotation(ann, options = {}) {
    if (!ann || !ann.start || !ann.end || !['straight', 'curved'].includes(ann.type)) return null;
    if (!ann.seamPath) {
      ann.seamPath = {
        version: seamPathSchemaVersion(),
        closed: options.closed === true,
        startNodeId: null,
        endNodeId: null,
        nextNodeSequence: 1,
        nextRunSequence: 1,
        treatmentRuns: [],
        detectionTrace: options.detectionTrace || null,
        endpointTopology: options.endpointTopology || null,
        pathCompleteness: options.pathCompleteness || null,
        fidelityReceipt: options.fidelityReceipt || null,
        geometryFingerprint: null,
        technicalContentFingerprint: null,
      };
    }
    return normalizeSeamPathAnnotation(ann);
  }

  function seamPathBreakEligibility(ann = getSelectedAnnotation()) {
    if (state.appMode !== 'manual') return { ok: false, reason: 'Switch to Manual Mode first.' };
    if (!state.sketchMode) return { ok: false, reason: 'Break Treatment is available in Sketch Focus.' };
    if (!ann || state.selection.kind !== 'annotation') return { ok: false, reason: 'Select one seam path first.' };
    if (getSelectedAnnotationIds().length !== 1) return { ok: false, reason: 'Select exactly one seam path.' };
    if (!['straight', 'curved'].includes(ann.type)) return { ok: false, reason: 'Select a straight or curved seam path.' };
    if (ann.templateGroupId) return { ok: false, reason: 'Template members are not eligible for Treatment Breaks.' };
    if (hasManualPomLabel(ann)) return { ok: false, reason: 'POM lines cannot own Treatment Breaks.' };
    // ADR 0101 removed Auto Detect Seam. A project saved before that can
    // still hold an accepted seam annotation, and it keeps its Treatment
    // Break eligibility — legacy saved data, not a live producer.
    const acceptedAutoSeam = ann.sourceMode === 'auto-seam'
      && (ann.candidateTier !== 'review' || ann.reviewDecision === 'accepted');
    if (!ann.seamPath && !acceptedAutoSeam && !hasLineTreatment(ann)) {
      return { ok: false, reason: 'Apply a Line Treatment to this manual path first.' };
    }
    if (ann.seamPath?.closed && ann.seamPath.treatmentRuns.length > 1) {
      return { ok: false, reason: 'This closed Seam Path already has a mixed-treatment interval.' };
    }
    return { ok: true, reason: null, annotation: ann };
  }

  function seamPathCanRemoveSelectedBreak(ann = getSelectedAnnotation()) {
    if (!ann || !ann.seamPath || getSelectedAnnotationIds().length !== 1) return false;
    const anchor = parseCurveAnchorPart(state.selection.part);
    if (!anchor || anchor.field !== 'point' || !(ann.points || [])[anchor.index]) return false;
    const nodeId = ann.points[anchor.index].nodeId;
    const runs = ann.seamPath.treatmentRuns || [];
    return runs.some(run => run.endNodeId === nodeId)
      && runs.some(run => run.startNodeId === nodeId);
  }

  function seamPathConvertStraightToCurved(ann) {
    if (!ann || ann.type !== 'straight') return;
    const start = ann.start;
    const end = ann.end;
    ann.type = 'curved';
    ann.control1 = {
      x: start.x + (end.x - start.x) / 3,
      y: start.y + (end.y - start.y) / 3,
    };
    ann.control2 = {
      x: start.x + (end.x - start.x) * 2 / 3,
      y: start.y + (end.y - start.y) * 2 / 3,
    };
    ann.points = [];
  }

  function seamPathRunContainingNodeInterior(ann, nodeId) {
    const boundaryIndex = seamPathNodeIndex(ann, nodeId);
    return (ann.seamPath?.treatmentRuns || []).find(run => {
      const startIndex = seamPathNodeIndex(ann, run.startNodeId);
      const endIndex = seamPathNodeIndex(ann, run.endNodeId);
      return startIndex < boundaryIndex && boundaryIndex < endIndex;
    }) || null;
  }

  function seamPathRunAfterBoundary(ann, nodeId) {
    return (ann.seamPath?.treatmentRuns || []).find(run => run.startNodeId === nodeId) || null;
  }

  function seamPathPartitionRunAtNode(ann, nodeId) {
    const seam = ann && ann.seamPath;
    const owner = seam && seamPathRunContainingNodeInterior(ann, nodeId);
    if (!owner) return { status: 'already_boundary_or_invalid' };
    const runIndex = seam.treatmentRuns.indexOf(owner);
    const usedRunIds = new Set(seam.treatmentRuns.map(run => run.id));
    const following = {
      id: seamPathNewRunId(ann, seam, usedRunIds),
      startNodeId: nodeId,
      endNodeId: owner.endNodeId,
      wrap: false,
      treatment: clone(owner.treatment),
    };
    owner.endNodeId = nodeId;
    owner.wrap = false;
    seam.treatmentRuns.splice(runIndex + 1, 0, following);
    seam.validationStatus = 'pass';
    seam.validationReasons = [];
    seamPathRefreshFingerprints(ann, true);
    state.selection.part = seamPathTreatmentPart(following.id);
    if (!ann.labelManual) ann.label = computeDefaultLabelPosition(ann);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    return { status: 'inserted', nodeId, runId: following.id };
  }

  function seamPathTreatmentPart(runId) {
    return 'treatmentRun:' + String(runId);
  }

  function seamPathSelectedRun(ann = getSelectedAnnotation()) {
    if (!ann || !ann.seamPath || typeof state.selection.part !== 'string'
        || !state.selection.part.startsWith('treatmentRun:')) return null;
    const id = state.selection.part.slice('treatmentRun:'.length);
    return (ann.seamPath.treatmentRuns || []).find(run => run.id === id) || null;
  }

  function seamPathInsertTreatmentBreakAt(ann, segIndex, t) {
    const seam = ensureSeamPathAnnotation(ann);
    if (!seam || seam.closed) return { status: seam && seam.closed ? 'closed_requires_two_boundaries' : 'ineligible' };
    seamPathConvertStraightToCurved(ann);
    ensureCurveControls(ann);
    const index = insertCurveAnchorAt(ann, segIndex, t);
    if (index < 0) return { status: 'invalid_location' };
    const usedNodeIds = new Set(seamPathNodeIds(ann).filter(Boolean));
    const point = ann.points[index];
    point.nodeId = seamPathNewNodeId(ann, seam, usedNodeIds);
    const result = seamPathPartitionRunAtNode(ann, point.nodeId);
    if (result.status !== 'inserted') {
      deleteCurveAnchorAt(ann, index);
      return result;
    }
    return { ...result, anchorIndex: index };
  }

  function seamPathClosedLocation(ann, nearest, existingIndex, existingDistance, tolerance) {
    if (existingIndex >= 0 && existingDistance <= tolerance / 2) {
      const nodeIds = seamPathNodeIds(ann);
      // start/end are the same visible closure point. Canonicalize that click
      // to the start node so no invisible duplicate endpoint decides ownership.
      const index = existingIndex === nodeIds.length - 1 ? 0 : existingIndex;
      return {
        nodeId: nodeIds[index],
        position: index,
        point: seamPathCleanPoint(seamPathNodePoints(ann)[index]),
      };
    }
    return {
      nodeId: null,
      segIndex: nearest.segIndex,
      t: nearest.t,
      position: nearest.segIndex + nearest.t,
      point: seamPathCleanPoint(nearest.point),
    };
  }

  function seamPathInsertClosedBoundaryLocations(ann, locations) {
    const seam = ann.seamPath;
    const resolved = locations.map((location, sourceIndex) => ({ ...location, sourceIndex }));
    const inserts = resolved.filter(location => !location.nodeId)
      .sort((left, right) => right.position - left.position);
    let higherInSameSegment = null;
    const usedNodeIds = new Set(seamPathNodeIds(ann).filter(Boolean));
    for (const location of inserts) {
      let localT = location.t;
      if (higherInSameSegment && higherInSameSegment.segIndex === location.segIndex) {
        localT = location.t / higherInSameSegment.t;
      }
      const pointIndex = insertCurveAnchorAt(ann, location.segIndex, localT);
      if (pointIndex < 0) return null;
      const point = ann.points[pointIndex];
      point.nodeId = seamPathNewNodeId(ann, seam, usedNodeIds);
      location.nodeId = point.nodeId;
      higherInSameSegment = location;
    }
    const first = resolved.find(location => location.sourceIndex === 0);
    const second = resolved.find(location => location.sourceIndex === 1);
    return first && second ? [first.nodeId, second.nodeId] : null;
  }

  function seamPathCommitClosedBoundaries(ann, first, second) {
    if (!ann?.seamPath?.closed || ann.seamPath.treatmentRuns.length !== 1) {
      return { status: 'closed_run_partition_unsupported' };
    }
    if (distance(first.point, second.point) <= 1e-6
        || Math.abs(first.position - second.position) <= 1e-6) {
      return { status: 'coincident_boundaries' };
    }
    const nodeIds = seamPathInsertClosedBoundaryLocations(ann, [first, second]);
    if (!nodeIds || nodeIds[0] === nodeIds[1]) return { status: 'invalid_location' };
    const [firstNodeId, secondNodeId] = nodeIds;
    const firstIndex = seamPathNodeIndex(ann, firstNodeId);
    const secondIndex = seamPathNodeIndex(ann, secondNodeId);
    const oldRun = ann.seamPath.treatmentRuns[0];
    const usedRunIds = new Set([oldRun.id]);
    const selected = {
      id: seamPathNewRunId(ann, ann.seamPath, usedRunIds),
      startNodeId: firstNodeId,
      endNodeId: secondNodeId,
      wrap: firstIndex > secondIndex,
      treatment: clone(oldRun.treatment),
    };
    const complementary = {
      id: oldRun.id,
      startNodeId: secondNodeId,
      endNodeId: firstNodeId,
      wrap: secondIndex > firstIndex,
      treatment: clone(oldRun.treatment),
    };
    ann.seamPath.treatmentRuns = [selected, complementary]
      .sort((left, right) => seamPathNodeIndex(ann, left.startNodeId) - seamPathNodeIndex(ann, right.startNodeId));
    ann.seamPath.validationStatus = 'pass';
    ann.seamPath.validationReasons = [];
    ann.lineTreatment = clone(ann.seamPath.treatmentRuns[0].treatment);
    seamPathRefreshFingerprints(ann, true);
    state.selection.part = seamPathTreatmentPart(selected.id);
    if (!ann.labelManual) ann.label = computeDefaultLabelPosition(ann);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    return { status: 'inserted', nodeIds, runId: selected.id };
  }

  function handleClosedTreatmentBreakClick(ann, nearest, existingIndex, existingDistance, tolerance) {
    const location = seamPathClosedLocation(ann, nearest, existingIndex, existingDistance, tolerance);
    const pending = state.treatmentBreakPending;
    if (!pending || pending.annotationId !== ann.id) {
      state.treatmentBreakPending = { annotationId: ann.id, location };
      updateUI();
      requestRender();
      showToast('First loop boundary set. Click the second boundary, or press Escape to cancel.');
      return;
    }
    if (distance(pending.location.point, location.point) <= tolerance / 2) {
      showToast('Choose a different second boundary on the closed Seam Path.');
      return;
    }
    const result = seamPathCommitClosedBoundaries(ann, pending.location, location);
    if (result.status !== 'inserted') {
      showToast('Could not partition the closed Seam Path at those boundaries.');
      return;
    }
    state.treatmentBreakPending = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Closed-loop Treatment Run created between the two boundaries.');
  }

  function handleTreatmentBreakClick(world) {
    const eligibility = seamPathBreakEligibility();
    if (!eligibility.ok) {
      showToast(eligibility.reason);
      return;
    }
    const ann = eligibility.annotation;
    const seam = ensureSeamPathAnnotation(ann);
    seamPathConvertStraightToCurved(ann);
    const nearest = nearestPointOnCurve(ann, world);
    const tolerance = Math.max(8, getLineWidth(ann) / 2 + 6) / state.zoom;
    if (!nearest || nearest.distance > tolerance) {
      showToast('Click on the selected seam path to break its Treatment.');
      return;
    }
    const points = seamPathNodePoints(ann);
    let existingIndex = -1;
    let existingDistance = Infinity;
    points.forEach((point, index) => {
      const value = distance(point, nearest.point);
      if (value < existingDistance) { existingDistance = value; existingIndex = index; }
    });
    if (seam.closed) {
      handleClosedTreatmentBreakClick(ann, nearest, existingIndex, existingDistance, tolerance);
      return;
    }
    if (existingDistance <= tolerance / 2) {
      const nodeId = seamPathNodeIds(ann)[existingIndex];
      const following = seamPathRunAfterBoundary(ann, nodeId);
      if (following) {
        state.selection.part = seamPathTreatmentPart(following.id);
        updateUI();
        requestRender();
        showToast('That Treatment Break already exists; the following run is selected.');
      } else {
        const result = seamPathPartitionRunAtNode(ann, nodeId);
        if (result.status === 'inserted') {
          pushHistoryIfChanged();
          updateUI();
          requestRender();
          showToast('Treatment Break added at the existing path point. The following run is selected.');
        } else {
          showToast('Choose a point inside a Treatment Run, away from the path endpoints.');
        }
      }
      return;
    }
    const preview = previewCurveAnchorInsertion(ann, nearest.segIndex, nearest.t);
    if (!preview || preview.minHandleSpan < tolerance / 2) {
      showToast('Too close to an existing point. Zoom in to place the Treatment Break.');
      return;
    }
    const result = seamPathInsertTreatmentBreakAt(ann, nearest.segIndex, nearest.t);
    if (result.status !== 'inserted') {
      showToast('Could not place a Treatment Break there.');
      return;
    }
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Treatment Break added. The following run is selected.');
  }

  function activateTreatmentBreakTool() {
    const eligibility = seamPathBreakEligibility();
    if (!eligibility.ok) {
      showToast(eligibility.reason);
      return false;
    }
    ensureSeamPathAnnotation(eligibility.annotation);
    state.treatmentBreakPending = null;
    setTool('break-treatment');
    closeLineStyleMenu();
    return true;
  }

  function seamPathApplyTreatmentToRun(ann, runId, recipe) {
    if (!ann || !ann.seamPath) return false;
    const run = ann.seamPath.treatmentRuns.find(item => item.id === runId);
    const treatment = normalizeLineTreatment(recipe);
    if (!run || !treatment) return false;
    if (seamPathStableStringify(normalizeLineTreatment(run.treatment))
        === seamPathStableStringify(treatment)) return false;
    run.treatment = clone(treatment);
    if (ann.seamPath.treatmentRuns.length === 1) ann.lineTreatment = clone(treatment);
    seamPathRefreshFingerprints(ann, true);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    return true;
  }

  function seamPathApplyTreatmentToAllRuns(ann, recipe) {
    if (!ann || !ann.seamPath) return false;
    const treatment = normalizeLineTreatment(recipe);
    if (!treatment) return false;
    let changed = false;
    for (const run of ann.seamPath.treatmentRuns) {
      if (seamPathStableStringify(normalizeLineTreatment(run.treatment))
          === seamPathStableStringify(treatment)) continue;
      run.treatment = clone(treatment);
      changed = true;
    }
    if (!changed) return false;
    ann.lineTreatment = clone(treatment);
    seamPathRefreshFingerprints(ann, true);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    return true;
  }

  function applyTreatmentRecipeToSelectedRun(recipe) {
    const ann = getSelectedAnnotation();
    const run = seamPathSelectedRun(ann);
    if (!ann || !run) return false;
    const before = snapshotFingerprint(makeSnapshot());
    const changed = seamPathApplyTreatmentToRun(ann, run.id, recipe);
    if (!changed) return false;
    if (before !== snapshotFingerprint(makeSnapshot())) pushHistoryIfChanged();
    updateUI();
    requestRender();
    return true;
  }

  function seamPathTreatmentsEquivalent(left, right) {
    return seamPathStableStringify(normalizeLineTreatment(left))
      === seamPathStableStringify(normalizeLineTreatment(right));
  }

  function removeSelectedTreatmentBreak(preferredSide) {
    const ann = getSelectedAnnotation();
    if (!seamPathCanRemoveSelectedBreak(ann)) {
      showToast('Select the path point that owns a Treatment Break first.');
      return false;
    }
    const anchor = parseCurveAnchorPart(state.selection.part);
    const nodeId = ann.points[anchor.index].nodeId;
    const runs = ann.seamPath.treatmentRuns;
    const leftIndex = runs.findIndex(run => run.endNodeId === nodeId);
    const rightIndex = runs.findIndex(run => run.startNodeId === nodeId);
    const adjacent = ann.seamPath.closed
      ? rightIndex === (leftIndex + 1) % runs.length
      : rightIndex === leftIndex + 1;
    if (leftIndex < 0 || !adjacent) return false;
    const left = runs[leftIndex];
    const right = runs[rightIndex];
    let choice = preferredSide;
    if (!seamPathTreatmentsEquivalent(left.treatment, right.treatment)) {
      if (!['preceding', 'following'].includes(choice)) {
        const answer = window.prompt(
          'The adjacent Treatments differ. Type PRECEDING or FOLLOWING to choose which Treatment the merged run keeps. Cancel makes no change.',
          'FOLLOWING'
        );
        if (answer == null) return false;
        choice = String(answer).trim().toLowerCase();
      }
      if (!['preceding', 'following'].includes(choice)) {
        showToast('No change: choose PRECEDING or FOLLOWING.');
        return false;
      }
    }
    const keptTreatment = choice === 'following' ? right.treatment : left.treatment;
    if (ann.seamPath.closed && runs.length === 2) {
      left.startNodeId = ann.seamPath.startNodeId;
      left.endNodeId = ann.seamPath.endNodeId;
      left.wrap = false;
      left.treatment = clone(keptTreatment);
      ann.seamPath.treatmentRuns = [left];
    } else {
      left.endNodeId = right.endNodeId;
      left.wrap = !!(ann.seamPath.closed
        && seamPathNodeIndex(ann, left.startNodeId) > seamPathNodeIndex(ann, left.endNodeId));
      left.treatment = clone(keptTreatment);
      runs.splice(rightIndex, 1);
    }
    state.selection.part = seamPathTreatmentPart(left.id);
    ann.lineTreatment = clone(ann.seamPath.treatmentRuns[0].treatment);
    seamPathRefreshFingerprints(ann, true);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Treatment Break removed; the path point was kept.');
    return true;
  }

  function seamPathNodeOwnsTreatmentBreak(ann, pointIndex) {
    if (!ann || !ann.seamPath || !(ann.points || [])[pointIndex]) return false;
    const nodeId = ann.points[pointIndex].nodeId;
    return ann.seamPath.treatmentRuns.some(run => run.endNodeId === nodeId)
      && ann.seamPath.treatmentRuns.some(run => run.startNodeId === nodeId);
  }

  function seamPathSliceRange(ann, startIndex, endIndex) {
    if (!ann || startIndex < 0 || endIndex <= startIndex) return null;
    if (ann.type === 'straight') return startIndex === 0 && endIndex === 1 ? ann : null;
    const segments = getCurveBeziers(ann).slice(startIndex, endIndex);
    if (!segments.length) return null;
    const first = segments[0];
    const last = segments[segments.length - 1];
    const points = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      points.push({
        point: clonePoint(segments[index].p3),
        handleIn: clonePoint(segments[index].p2),
        handleOut: clonePoint(segments[index + 1].p1),
      });
    }
    return {
      ...ann,
      seamPath: null,
      start: clonePoint(first.p0),
      control1: clonePoint(first.p1),
      points,
      control2: clonePoint(last.p2),
      end: clonePoint(last.p3),
    };
  }

  function seamPathSliceAnnotations(ann, run) {
    if (!ann || !run || !ann.seamPath) return [];
    const startIndex = seamPathNodeIndex(ann, run.startNodeId);
    const endIndex = seamPathNodeIndex(ann, run.endNodeId);
    if (startIndex < 0 || endIndex < 0) return [];
    const lastIndex = seamPathNodeIds(ann).length - 1;
    const ranges = run.wrap
      ? [[startIndex, lastIndex], [0, endIndex]]
      : [[startIndex, endIndex]];
    return ranges.map(range => seamPathSliceRange(ann, range[0], range[1]))
      .filter(Boolean)
      .map(slice => ({ ...slice, lineTreatment: clone(run.treatment) }));
  }

  function seamPathTreatmentSegments(ann) {
    if (!ann || !ann.seamPath) return [];
    return ann.seamPath.treatmentRuns.flatMap(run =>
      seamPathSliceAnnotations(ann, run).map((annotation, pieceIndex) => ({
        run, annotation, pieceIndex, treatment: run.treatment,
      }))).filter(item => item.annotation && normalizeLineTreatment(item.treatment));
  }

  function seamPathVisualExtent(ann) {
    if (!ann || !ann.seamPath || !Array.isArray(ann.seamPath.treatmentRuns)) return 0;
    return ann.seamPath.treatmentRuns.reduce((maximum, run) =>
      Math.max(maximum, lineTreatmentVisualExtent(run.treatment)), 0);
  }

  function seamPathNearestRun(ann, world) {
    let best = null;
    for (const item of seamPathTreatmentSegments(ann)) {
      const polyline = getAnnotationPolyline(item.annotation, item.annotation.type === 'straight' ? 1 : 96);
      for (let index = 1; index < polyline.length; index += 1) {
        const score = pointToSegmentDistance(world, polyline[index - 1], polyline[index]);
        if (!best || score < best.score) best = { run: item.run, score };
      }
    }
    return best ? best.run : null;
  }

  function seamPathSelectRunAtWorld(ann, world) {
    const run = seamPathNearestRun(ann, world);
    if (!run) return null;
    state.selection.part = seamPathTreatmentPart(run.id);
    return run;
  }

  function drawSelectedTreatmentRunHighlight(ann) {
    const run = seamPathSelectedRun(ann);
    const slices = run ? seamPathSliceAnnotations(ann, run) : [];
    if (!slices.length) return;
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 7 / Math.max(0.0001, state.zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const slice of slices) appendAnnotationPathSegment(slice);
    ctx.stroke();
    ctx.restore();
  }

  function drawTreatmentBreakMarkers(ann) {
    if (!ann || !ann.seamPath) return;
    const nodeIds = seamPathNodeIds(ann);
    const points = seamPathNodePoints(ann);
    const boundaryRuns = ann.seamPath.treatmentRuns.length < 2 ? []
      : ann.seamPath.closed
        ? ann.seamPath.treatmentRuns
        : ann.seamPath.treatmentRuns.slice(1);
    const boundaries = new Set(boundaryRuns.map(run => run.startNodeId));
    ctx.save();
    ctx.lineWidth = 2 / Math.max(0.0001, state.zoom);
    ctx.strokeStyle = '#f59e0b';
    ctx.fillStyle = '#fff7ed';
    for (const boundary of boundaries) {
      const index = nodeIds.indexOf(boundary);
      const point = points[index];
      if (!point) continue;
      const radius = 5 / Math.max(0.0001, state.zoom);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const pending = state.treatmentBreakPending;
    if (pending?.annotationId === ann.id && pending.location?.point) {
      const point = pending.location.point;
      const radius = 7 / Math.max(0.0001, state.zoom);
      ctx.setLineDash([3 / Math.max(0.0001, state.zoom), 3 / Math.max(0.0001, state.zoom)]);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function seamPathCloneForNewAnnotation(source, target) {
    if (!source || !source.seamPath || !target) return null;
    const sourceIds = seamPathNodeIds(source);
    target.seamPath = {
      version: seamPathSchemaVersion(),
      closed: !!source.seamPath.closed,
      startNodeId: null,
      endNodeId: null,
      nextNodeSequence: 1,
      nextRunSequence: 1,
      treatmentRuns: [],
      detectionTrace: null,
      endpointTopology: null,
      pathCompleteness: null,
      fidelityReceipt: null,
      geometryFingerprint: null,
      technicalContentFingerprint: null,
    };
    normalizeSeamPathAnnotation(target);
    const targetIds = seamPathNodeIds(target);
    const sourceIndex = new Map(sourceIds.map((id, index) => [id, index]));
    target.seamPath.treatmentRuns = source.seamPath.treatmentRuns.map(run => ({
      id: null,
      startNodeId: targetIds[sourceIndex.get(run.startNodeId)],
      endNodeId: targetIds[sourceIndex.get(run.endNodeId)],
      treatment: clone(run.treatment),
    }));
    normalizeSeamPathAnnotation(target);
    return target.seamPath;
  }
