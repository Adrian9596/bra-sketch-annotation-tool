// US-121 — TD Review loop for Auto Detect Seam (Phase C first slice, see
// docs/stories/epics/E07-measurement-detection/US-109-photo-zigzag-detection/
// {NEXT_ARCHITECTURE_SPEC,PHASE_PLAN}_2026-09-03.md §3/§4). Lets the TD open
// the last Auto Detect Seam result, see every Automatic ROI the detector
// searched, mark each zone/side correct or wrong, drag a wrong ROI to the
// right place, and export the result as a ground-truth JSON file.
//
// Built in this slice: the overlay, per-row verdicts, drag-to-correct ROI
// polygons (whole-polygon translate or single-vertex drag), and export.
// NOT built yet (left for a later Phase C pass): writing straight into
// scripts/groundtruth (the browser cannot touch the filesystem — the TD
// downloads the JSON and commits it by hand, same pattern as
// maybeShowGroundTruthLabeler in src/dev/url-bootstrap.js), gating the pilot
// suites on td_confirmed data, and "rerun highlights already-confirmed
// entries". A TD's drag is recorded as TRUTH ONLY — it never feeds back into
// the detector's own output; only a developer editing a rule and rerunning
// the whole corpus changes what the detector produces (spec §3/§4).
// Source part for app.js. Run `npm run build` after editing.

  const AUTO_SEAM_REVIEW_REASONS = Object.freeze([
    { code: 'roi_misplaced', label: 'ROI misplaced' },
    { code: 'false_positive', label: 'False positive — no zigzag here' },
    { code: 'false_negative', label: 'False negative — zigzag exists, no candidate' },
    { code: 'wrong_geometry', label: 'Right zone, wrong pixels' },
    { code: 'not_visible', label: 'Not visible / cannot judge' },
  ]);

  const AUTO_SEAM_REVIEW_ZONE_LABELS = Object.freeze({
    shoulder_strap: 'Shoulder strap', neckline: 'Neckline', armhole: 'Armhole',
    cup_edge: 'Cup edge', cup_seam: 'Cup seam', underbust_band: 'Underbust band',
    side_seam: 'Side seam', center_front: 'Center front',
  });

  function autoSeamReviewZoneLabel(zone) {
    return AUTO_SEAM_REVIEW_ZONE_LABELS[zone] || zone;
  }

  function autoSeamReviewSideLabel(side) {
    if (side === 'left') return 'L';
    if (side === 'right') return 'R';
    if (side === 'bilateral') return 'both';
    return side || '';
  }

  // The ONLY way this file reads review state. Self-healing: if anything ever
  // replaces state.autoSeam with a shape that lacks `review` (project-load.js
  // did exactly that until the 2026-09-03 recheck), rebuild it from the same
  // factory state.js uses instead of throwing inside a click handler.
  function autoSeamReviewState() {
    const seam = state.autoSeam;
    if (!seam.review) seam.review = autoSeamReviewInitialState();
    return seam.review;
  }

  // Called from the board toolbar's updateUI pass. Keeps panel, button and
  // state coherent no matter which path changed them:
  //   - open, but the run or its image is gone (Open project, image deleted,
  //     board reset) -> close;
  //   - open, and Auto Detect Seam re-ran meanwhile -> the old corrections
  //     described a result that no longer exists: drop them, re-sync to the
  //     new run, re-render;
  //   - closed, but stale chrome survived a state reset -> hide it.
  function syncAutoSeamReviewChrome() {
    const review = autoSeamReviewState();
    const run = autoSeamReviewLastRun();
    if (review.active) {
      // Review ROI is a Manual Mode · Sketch Focus tool (its button lives
      // there and the overlay only paints there); leaving either closes it
      // rather than leaving a panel floating over a mode that cannot use it.
      if (state.appMode !== 'manual' || !state.sketchMode
          || !run || !run.result || !autoSeamReviewSourceImage()) {
        closeAutoSeamReview();
        return;
      }
      if (review.runId !== run.runId) {
        review.corrections = {};
        review.runId = run.runId;
        review.selectedRoiId = null;
        review.editingRoiId = null;
        autoSeamReviewDrag = null;
        renderAutoSeamReviewPanel();
        requestRender();
      }
      return;
    }
    if (el.autoSeamReviewPanel && !el.autoSeamReviewPanel.hidden) el.autoSeamReviewPanel.hidden = true;
    if (el.autoSeamReviewBtn) el.autoSeamReviewBtn.classList.remove('active');
  }

  function isAutoSeamReviewOpen() {
    return !!(autoSeamReviewState() && autoSeamReviewState().active);
  }

  function isAutoSeamReviewEditing() {
    return isAutoSeamReviewOpen() && !!autoSeamReviewState().editingRoiId;
  }

  function autoSeamReviewLastRun() {
    return state.autoSeam.lastRun || null;
  }

  function autoSeamReviewSourceImage() {
    const run = autoSeamReviewLastRun();
    return run ? getImageById(run.sourceImageId) : null;
  }

  // ---- Open / close ------------------------------------------------------

  function toggleAutoSeamReview() {
    if (isAutoSeamReviewOpen()) closeAutoSeamReview();
    else openAutoSeamReview();
  }

  function openAutoSeamReview() {
    const run = autoSeamReviewLastRun();
    if (!run || !run.result) {
      showToast('Run Auto Detect Seam first, then Review ROI.');
      return;
    }
    if (!autoSeamReviewSourceImage()) {
      showToast('The reviewed image is no longer on the board.');
      return;
    }
    const review = autoSeamReviewState();
    if (review.runId !== run.runId) {
      // A new run invalidates prior corrections: they were drawn against a
      // different result (different geometry/evidence behind the same ids).
      review.corrections = {};
    }
    review.runId = run.runId;
    review.active = true;
    review.selectedRoiId = null;
    review.editingRoiId = null;
    if (el.autoSeamReviewBtn) el.autoSeamReviewBtn.classList.add('active');
    renderAutoSeamReviewPanel();
    requestRender();
  }

  function closeAutoSeamReview() {
    const review = autoSeamReviewState();
    review.active = false;
    review.editingRoiId = null;
    autoSeamReviewDrag = null;
    if (el.autoSeamReviewBtn) el.autoSeamReviewBtn.classList.remove('active');
    if (el.autoSeamReviewPanel) el.autoSeamReviewPanel.hidden = true;
    requestRender();
  }

  // ---- Rows (one per Automatic ROI) --------------------------------------

  function autoSeamReviewRows() {
    const run = autoSeamReviewLastRun();
    if (!run || !run.result) return [];
    const result = run.result;
    const corrections = autoSeamReviewState().corrections || {};
    return (result.automaticRois || []).map(roi => {
      const candidate = result.candidates.find(c =>
        c.roiId === roi.id || (Array.isArray(c.roiIds) && c.roiIds.includes(roi.id)));
      const abstention = result.abstentions.find(a =>
        a.scope === 'zone' && a.zone === roi.zone && a.side === roi.side);
      const correction = corrections[roi.id] || null;
      return {
        roi, candidate: candidate || null, abstention: abstention || null,
        verdict: correction ? correction.verdict : null,
        reasonCode: correction ? correction.reasonCode : null,
        correctedPolygon: correction ? correction.correctedPolygon : null,
      };
    });
  }

  function autoSeamReviewRowById(roiId) {
    if (!roiId) return null;
    return autoSeamReviewRows().find(row => row.roi.id === roiId) || null;
  }

  function autoSeamReviewEnsureCorrection(roiId) {
    const review = autoSeamReviewState();
    if (!review.corrections[roiId]) {
      review.corrections[roiId] = { verdict: null, reasonCode: null, correctedPolygon: null };
    }
    return review.corrections[roiId];
  }

  function autoSeamReviewSetVerdict(roiId, verdict) {
    const correction = autoSeamReviewEnsureCorrection(roiId);
    correction.verdict = verdict;
    if (verdict === 'correct') {
      // Confirmed as-is — discard any half-made correction and stop editing.
      correction.reasonCode = null;
      correction.correctedPolygon = null;
      if (autoSeamReviewState().editingRoiId === roiId) autoSeamReviewState().editingRoiId = null;
    }
    renderAutoSeamReviewPanel();
    requestRender();
  }

  function autoSeamReviewSetReason(roiId, reasonCode) {
    autoSeamReviewEnsureCorrection(roiId).reasonCode = reasonCode || null;
  }

  function autoSeamReviewStartEditing(roiId) {
    const row = autoSeamReviewRowById(roiId);
    if (!row) return;
    const correction = autoSeamReviewEnsureCorrection(roiId);
    correction.verdict = 'wrong';
    if (!correction.correctedPolygon) correction.correctedPolygon = clone(row.roi.polygon);
    autoSeamReviewState().editingRoiId = roiId;
    autoSeamReviewState().selectedRoiId = roiId;
    renderAutoSeamReviewPanel();
    requestRender();
  }

  function autoSeamReviewStopEditing() {
    autoSeamReviewState().editingRoiId = null;
    autoSeamReviewDrag = null;
    renderAutoSeamReviewPanel();
    requestRender();
  }

  function autoSeamReviewResetPolygon(roiId) {
    const correction = autoSeamReviewEnsureCorrection(roiId);
    correction.correctedPolygon = null;
    if (autoSeamReviewState().editingRoiId === roiId) autoSeamReviewState().editingRoiId = null;
    renderAutoSeamReviewPanel();
    requestRender();
  }

  function autoSeamReviewSelectRow(roiId) {
    autoSeamReviewState().selectedRoiId = roiId;
    renderAutoSeamReviewPanel();
    requestRender();
  }

  // ---- Panel --------------------------------------------------------------

  function autoSeamReviewStatusText(row) {
    if (row.candidate) return 'candidate: ' + (row.candidate.appearanceType || 'zigzag');
    if (row.abstention) return 'abstained: ' + row.abstention.code;
    return 'no result';
  }

  function renderAutoSeamReviewPanel() {
    const panel = el.autoSeamReviewPanel;
    const body = el.autoSeamReviewBody;
    if (!panel || !body) return;
    if (!isAutoSeamReviewOpen()) { panel.hidden = true; return; }
    panel.hidden = false;
    const rows = autoSeamReviewRows();
    const reviewed = rows.filter(r => r.verdict).length;
    if (el.autoSeamReviewCount) el.autoSeamReviewCount.textContent = reviewed + '/' + rows.length + ' reviewed';
    const selectedId = autoSeamReviewState().selectedRoiId;
    const editingId = autoSeamReviewState().editingRoiId;

    body.innerHTML = '';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'auto-seam-review-row';
      if (row.roi.id === selectedId) item.classList.add('auto-seam-review-row-selected');
      item.addEventListener('click', (e) => {
        if (e.target.closest('button, select')) return;
        autoSeamReviewSelectRow(row.roi.id);
      });

      const head = document.createElement('div');
      head.className = 'auto-seam-review-row-head';
      const title = document.createElement('span');
      title.className = 'auto-seam-review-row-title';
      title.textContent = autoSeamReviewZoneLabel(row.roi.zone) + ' · ' + autoSeamReviewSideLabel(row.roi.side);
      const status = document.createElement('span');
      status.className = 'auto-seam-review-row-status';
      status.textContent = autoSeamReviewStatusText(row);
      head.append(title, status);
      item.appendChild(head);

      const actions = document.createElement('div');
      actions.className = 'auto-seam-review-row-actions';
      actions.appendChild(anchorMiniBtn('Correct', 'Confirm the detector got this right',
        () => autoSeamReviewSetVerdict(row.roi.id, 'correct'),
        row.verdict === 'correct' ? 'background:#dcfce7;border-color:#16a34a;color:#166534;' : ''));
      actions.appendChild(anchorMiniBtn('Wrong', 'Mark this wrong and drag the ROI to the right place',
        () => autoSeamReviewStartEditing(row.roi.id),
        row.verdict === 'wrong' ? 'background:#fee2e2;border-color:#dc2626;color:#991b1b;' : ''));
      if (row.correctedPolygon) {
        actions.appendChild(anchorMiniBtn('Revert', 'Discard the drag, go back to the detected ROI',
          () => autoSeamReviewResetPolygon(row.roi.id)));
      }
      if (editingId === row.roi.id) {
        actions.appendChild(anchorMiniBtn('Done', 'Stop dragging this ROI', () => autoSeamReviewStopEditing(),
          'background:#e0e7ff;border-color:#4f46e5;color:#3730a3;'));
      }
      item.appendChild(actions);

      if (row.verdict === 'wrong') {
        const select = document.createElement('select');
        select.className = 'auto-seam-review-reason';
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = 'Why is it wrong?';
        select.appendChild(blank);
        for (const reason of AUTO_SEAM_REVIEW_REASONS) {
          const opt = document.createElement('option');
          opt.value = reason.code; opt.textContent = reason.label;
          if (row.reasonCode === reason.code) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener('click', (e) => e.stopPropagation());
        select.addEventListener('change', () => autoSeamReviewSetReason(row.roi.id, select.value));
        item.appendChild(select);
      }

      body.appendChild(item);
    }
  }

  // ---- Canvas hit-testing + drag-to-correct -------------------------------

  const AUTO_SEAM_REVIEW_VERTEX_RADIUS_PX = 7;

  function autoSeamReviewNormalizedFromWorld(world, image) {
    return { x: clamp((world.x - image.x) / image.width, 0, 1), y: clamp((world.y - image.y) / image.height, 0, 1) };
  }

  function autoSeamReviewPointInPolygon(point, polygonWorld) {
    let inside = false;
    for (let i = 0, j = polygonWorld.length - 1; i < polygonWorld.length; j = i, i += 1) {
      const a = polygonWorld[i], b = polygonWorld[j];
      const crosses = (a.y > point.y) !== (b.y > point.y);
      if (!crosses) continue;
      const xIntersect = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (point.x < xIntersect) inside = !inside;
    }
    return inside;
  }

  function autoSeamReviewHitTest(world) {
    const review = autoSeamReviewState();
    const row = autoSeamReviewRowById(review.editingRoiId);
    const image = autoSeamReviewSourceImage();
    if (!row || !image) return null;
    const polygon = row.correctedPolygon || row.roi.polygon;
    const polygonWorld = polygon.map(p => worldFromNormalized(p, image));
    const radiusWorld = AUTO_SEAM_REVIEW_VERTEX_RADIUS_PX / Math.max(state.zoom, 0.1);
    for (let i = 0; i < polygonWorld.length; i += 1) {
      if (Math.hypot(polygonWorld[i].x - world.x, polygonWorld[i].y - world.y) <= radiusWorld) {
        return { mode: 'vertex', index: i };
      }
    }
    if (autoSeamReviewPointInPolygon(world, polygonWorld)) return { mode: 'translate' };
    return null;
  }

  // { roiId, mode, index, startWorld, startPolygon } while a drag is live.
  let autoSeamReviewDrag = null;

  function autoSeamReviewOnMouseDown(world) {
    const hit = autoSeamReviewHitTest(world);
    if (!hit) return false;
    const review = autoSeamReviewState();
    const row = autoSeamReviewRowById(review.editingRoiId);
    autoSeamReviewDrag = {
      roiId: review.editingRoiId,
      mode: hit.mode,
      index: hit.index,
      startWorld: world,
      startPolygon: clone(row.correctedPolygon || row.roi.polygon),
    };
    return true;
  }

  function autoSeamReviewOnMouseMove(world) {
    if (!autoSeamReviewDrag) return false;
    const image = autoSeamReviewSourceImage();
    if (!image) return true;
    const correction = autoSeamReviewEnsureCorrection(autoSeamReviewDrag.roiId);
    if (autoSeamReviewDrag.mode === 'vertex') {
      const next = clone(autoSeamReviewDrag.startPolygon);
      next[autoSeamReviewDrag.index] = autoSeamReviewNormalizedFromWorld(world, image);
      correction.correctedPolygon = next;
    } else {
      const dxNorm = (world.x - autoSeamReviewDrag.startWorld.x) / image.width;
      const dyNorm = (world.y - autoSeamReviewDrag.startWorld.y) / image.height;
      correction.correctedPolygon = autoSeamReviewDrag.startPolygon.map(p => ({
        x: clamp(p.x + dxNorm, 0, 1), y: clamp(p.y + dyNorm, 0, 1),
      }));
    }
    requestRender();
    return true;
  }

  function autoSeamReviewOnMouseUp() {
    if (!autoSeamReviewDrag) return false;
    autoSeamReviewDrag = null;
    renderAutoSeamReviewPanel();
    return true;
  }

  // ---- Export --------------------------------------------------------------

  // Builds and downloads a technical-flat-stitch-groundtruth/1 file (plus the
  // additive `roiReview` field the pilot's validator ignores, since it only
  // checks the fields it cares about — see scripts/photo-stitch-technical-
  // flat-pilot.mjs's validateGroundTruth). The TD moves the downloaded file
  // into scripts/groundtruth/technical-flat-stitch/ by hand; nothing here
  // touches the filesystem or the network.
  async function autoSeamReviewExport() {
    const run = autoSeamReviewLastRun();
    const image = autoSeamReviewSourceImage();
    if (!run || !image) { showToast('Nothing to export — run Auto Detect Seam first.'); return null; }
    const rows = autoSeamReviewRows();
    const reviewed = rows.filter(r => r.verdict);
    if (!reviewed.length) { showToast('Review at least one zone before exporting.'); return null; }

    const observedZigzagZones = [];
    const confirmedNoZigzagZones = [];
    const roiReview = [];
    for (const row of reviewed) {
      const candidateIsZigzag = !!(row.candidate && row.candidate.appearanceType === 'zigzag');
      if (row.verdict === 'correct' && candidateIsZigzag) observedZigzagZones.push({ zone: row.roi.zone, side: row.roi.side });
      else if (row.verdict === 'correct') confirmedNoZigzagZones.push({ zone: row.roi.zone, side: row.roi.side });
      else if (row.reasonCode === 'false_negative') observedZigzagZones.push({ zone: row.roi.zone, side: row.roi.side });
      else if (row.reasonCode === 'false_positive') confirmedNoZigzagZones.push({ zone: row.roi.zone, side: row.roi.side });
      roiReview.push({
        zone: row.roi.zone, side: row.roi.side, roiId: row.roi.id,
        verdict: row.verdict, reasonCode: row.reasonCode || null,
        detected: clone(row.roi.polygon),
        corrected: row.correctedPolygon ? clone(row.correctedPolygon) : null,
      });
    }

    const sourceSha256 = await autoSeamSourceSha256(image);
    const naturalWidth = image.img ? (image.img.naturalWidth || image.img.width) : null;
    const naturalHeight = image.img ? (image.img.naturalHeight || image.img.height) : null;
    const suggested = (window.__braGroundTruthName || 'seam-review') + '.json';
    const name = window.prompt('Ground-truth file name (match the image, e.g. image6.png.json):', suggested);
    if (!name) return null;
    const labeledBy = window.prompt('Your name (labeledBy):', window.__braGroundTruthLabeler || '') || null;
    if (labeledBy) window.__braGroundTruthLabeler = labeledBy;

    const gt = {
      schemaVersion: 'technical-flat-stitch-groundtruth/1',
      image: name.replace(/\.json$/i, ''),
      source: 'td_confirmed',
      corpusVersion: 'us109-technical-flat-pilot-1',
      sourceSha256,
      width: naturalWidth,
      height: naturalHeight,
      labeledAt: new Date().toISOString(),
      labeledBy,
      unjudgeable: false,
      unjudgeableReason: null,
      visualCharacter: null,
      observedZigzagZones,
      confirmedNoZigzagZones,
      knownGaps: [],
      roiReview,
      notes: 'TD Review Loop export (Auto Detect Seam · Review ROI). '
        + reviewed.length + '/' + rows.length + ' ROI rows reviewed. Rows marked "wrong" for a reason other than '
        + 'false_positive/false_negative (roi_misplaced, wrong_geometry, not_visible) affect neither '
        + 'observedZigzagZones nor confirmedNoZigzagZones — see roiReview for detail. Move this file into '
        + 'scripts/groundtruth/technical-flat-stitch/ to add it to npm run photo-stitch-technical-flat-pilot.',
    };

    const safe = String(name).replace(/[^\w.\-]+/g, '_');
    const fileName = /\.json$/i.test(safe) ? safe : safe + '.json';
    try {
      const blob = new Blob([JSON.stringify(gt, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Saved TD review: ' + fileName + ' (' + reviewed.length + '/' + rows.length + ' reviewed).', 5000);
    } catch (err) {
      console.warn('[Auto Seam Review] export failed:', err);
      showToast('Could not save the review JSON.', 4200);
    }
    return gt;
  }

  if (el.autoSeamReviewPanel && el.autoSeamReviewHead) {
    makeDraggablePanel(el.autoSeamReviewPanel, el.autoSeamReviewHead, '.anchor-panel-close');
  }
