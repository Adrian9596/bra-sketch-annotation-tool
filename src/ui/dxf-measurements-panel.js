// US-113: Pattern Measurements list panel — ADR 0062's own "tabular output"
// Follow-Up, landed as a session-only VIEW over state.dxfMeasureSession.
// measurements. Every mutation (rename/select/delete/clear) goes through the
// same session functions the canvas interaction already uses
// (dxf-measure-session.js) — this file only builds rows and reacts to
// clicks, mirroring src/ui/pattern-pieces-panel.js's shape. Unlike that
// panel's one-shot "review then Apply" model, this one is a LIVE view:
// measurements are created/deleted from the CANVAS as often as from here, so
// renderDxfMeasurementsPanel() is called from updateUI() (ui-status.js) on
// every app-state refresh and fingerprint-skips when nothing it displays
// changed — same convention as src/ui/spec-panel.js's renderSpecPanel.
// Source part for app.js. Run `npm run build` after editing.

  let lastDxfMeasurementsFingerprint = null;
  // US-111: the measurement id currently armed for "Match with…", or null.
  // Panel-local UI state (like Pattern Pieces' own `keep` set) — never part
  // of the session, never undo-able, cleared on cancel/complete/Escape/close.
  let pendingSeamMatchSourceId = null;

  function isDxfMeasurementsPanelOpen() {
    return !!(el.dxfMeasurementsPanel && !el.dxfMeasurementsPanel.hidden);
  }

  function openDxfMeasurementsPanel() {
    if (!el.dxfMeasurementsPanel) return;
    if (!state.dxfMeasureSession) {
      showToast('Import a DXF file first (Tools → Open DXF file…).');
      return;
    }
    el.dxfMeasurementsPanel.hidden = false;
    lastDxfMeasurementsFingerprint = null; // force a real rebuild on open
    renderDxfMeasurementsPanel();
  }

  function closeDxfMeasurementsPanel() {
    if (!el.dxfMeasurementsPanel) return;
    el.dxfMeasurementsPanel.hidden = true;
    pendingSeamMatchSourceId = null;
  }

  function dxfMeasurementDisplayName(measurement) {
    return measurement.name || ('M' + measurement.id);
  }

  function dxfMeasurementModeLabel(measurement) {
    return measurement.mode === 'out-of-path' ? 'Out of Path' : 'Along Path';
  }

  function selectDxfMeasurement(session, id) {
    if (!dxfMeasureGetMeasurement(session, id)) return;
    session.selectedMeasurementId = id;
    updateUI();
    requestRender();
  }

  // Frames the measurement's route/endpoints in the viewport — the same
  // fitBoundsToViewport used by "Fit board" (src/manual/viewport.js), so pan/
  // zoom math has exactly one implementation. A fixed world-space pad keeps a
  // degenerate (near-zero extent, e.g. two very close points) bound from
  // zooming in absurdly tight.
  function focusDxfMeasurementOnBoard(session, measurement) {
    const pts = dxfMeasureRouteWorldPoints(session, measurement, 8);
    if (!pts.length || typeof fitBoundsToViewport !== 'function') return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 40;
    fitBoundsToViewport({
      x: minX - pad, y: minY - pad,
      width: Math.max(1, maxX - minX) + pad * 2,
      height: Math.max(1, maxY - minY) + pad * 2,
    });
  }

  function deleteDxfMeasurementFromPanel(session, id) {
    if (!dxfMeasureDeleteMeasurement(session, id)) return;
    updateUI();
    requestRender();
  }

  function clearAllDxfMeasurementsFromPanel(session) {
    const count = dxfMeasureClearAllMeasurements(session);
    if (!count) { showToast('No measurements to clear.'); return; }
    updateUI();
    requestRender();
    showToast('Cleared ' + count + (count === 1 ? ' measurement' : ' measurements') + ' — ⌘Z to undo.');
  }

  // ---- US-111: seam match (Match with… / Cancel / Unlink / ease) -----------

  function startSeamMatch(measurementId) {
    pendingSeamMatchSourceId = measurementId;
    lastDxfMeasurementsFingerprint = null; // force a rebuild — picking-mode is UI-only, not in the fingerprint
    renderDxfMeasurementsPanel();
    showToast('Click another Along Path row to match it with — Escape to cancel.');
  }

  function cancelSeamMatch() {
    if (pendingSeamMatchSourceId == null) return;
    pendingSeamMatchSourceId = null;
    lastDxfMeasurementsFingerprint = null;
    renderDxfMeasurementsPanel();
  }

  function completeSeamMatch(session, aId, bId) {
    pendingSeamMatchSourceId = null;
    const pair = dxfMeasureCreateSeamPair(session, aId, bId);
    if (!pair) { showToast('Could not match those two measurements.'); return; }
    session.selectedMeasurementId = aId;
    updateUI();
    requestRender();
  }

  function unlinkSeamPairFromPanel(session, pairId) {
    if (!dxfMeasureDeleteSeamPair(session, pairId)) return;
    updateUI();
    requestRender();
  }

  function setSeamPairEaseFromPanel(session, pairId, rawValue) {
    const parsed = parseFloat(rawValue);
    dxfMeasureSetSeamEase(session, pairId, Number.isFinite(parsed) ? parsed : 0);
    updateUI();
    requestRender();
  }

  function dxfMeasurementMiniBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pattern-piece-mini-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // The plain (non-editing) name cell — its own builder because three call
  // sites need to (re)produce it: the normal row render, an Escape-cancel
  // revert, and a no-op-rename revert (see startRenameDxfMeasurementRow).
  function buildDxfMeasurementNameSpan(row, session, measurement) {
    const span = document.createElement('span');
    span.className = 'dxf-measurement-name';
    span.textContent = dxfMeasurementDisplayName(measurement);
    span.title = 'Double-click to rename';
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameDxfMeasurementRow(row, session, measurement);
    });
    return span;
  }

  // Commit-on-blur, matching this app's existing label-editor convention
  // (never swallow a value silently). Escape reverts WITHOUT going through
  // the fingerprint-gated renderDxfMeasurementsPanel() — the name hasn't
  // changed, so that render would no-op and leave the <input> stuck in the
  // DOM forever; the revert here is a direct, local DOM swap instead.
  function startRenameDxfMeasurementRow(row, session, measurement) {
    const nameSpan = row.querySelector('.dxf-measurement-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dxf-measurement-name-input';
    input.value = measurement.name || '';
    input.placeholder = 'M' + measurement.id;
    input.addEventListener('click', (e) => e.stopPropagation());
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const changed = dxfMeasureRenameMeasurement(session, measurement.id, input.value);
      if (changed) {
        // A real change pushes history and calls updateUI() below, which
        // re-enters renderDxfMeasurementsPanel() through the normal
        // fingerprint-changed path (document.activeElement has already
        // moved off `input` by the time a blur event fires, so the
        // "still editing" guard there does not block this rebuild).
        updateUI();
        requestRender();
      } else if (input.isConnected) {
        input.replaceWith(buildDxfMeasurementNameSpan(row, session, measurement));
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        settled = true;
        if (input.isConnected) input.replaceWith(buildDxfMeasurementNameSpan(row, session, measurement));
      }
    });
  }

  function dxfMeasurementsFingerprint(session) {
    if (!session) return 'none';
    return JSON.stringify({
      sel: session.selectedMeasurementId,
      rows: session.measurements.map(m => [m.id, m.name, m.mode, dxfMeasureValueInches(session, m)]),
      pairs: session.seamPairs.map(p => [p.id, p.aId, p.bId, p.ease]),
    });
  }

  // One measurement row. Its mini-button set depends on match state:
  //  - mid-pick, this row is the source: [Cancel] [⌖] [✕]
  //  - mid-pick, this row is a valid target (unpaired Along Path, not the
  //    source): no buttons — the WHOLE ROW is the "click to match" control
  //    (see the click handler below), so a stray ⌖/✕ click can't be mistaken
  //    for a match pick.
  //  - unpaired Along Path, no pick in progress: [Match] [⌖] [✕]
  //  - everything else (Out of Path, or already paired): [⌖] [✕]
  function buildDxfMeasurementRow(session, measurement) {
    const row = document.createElement('div');
    const picking = pendingSeamMatchSourceId != null;
    const isSource = pendingSeamMatchSourceId === measurement.id;
    const pairId = dxfMeasureFindSeamPairId(session, measurement.id);
    const isTarget = picking && !isSource && pairId == null && measurement.mode === 'along-path';
    row.className = 'dxf-measurement-row'
      + (measurement.id === session.selectedMeasurementId ? ' active' : '')
      + (isTarget ? ' match-target' : '');
    row.addEventListener('click', () => {
      if (isTarget) { completeSeamMatch(session, pendingSeamMatchSourceId, measurement.id); return; }
      selectDxfMeasurement(session, measurement.id);
    });
    if (isTarget) row.title = 'Click to match with ' + dxfMeasurementDisplayName(dxfMeasureGetMeasurement(session, pendingSeamMatchSourceId));

    row.appendChild(buildDxfMeasurementNameSpan(row, session, measurement));

    const mode = document.createElement('span');
    mode.className = 'dxf-measurement-mode';
    mode.textContent = dxfMeasurementModeLabel(measurement);
    row.appendChild(mode);

    const value = document.createElement('span');
    value.className = 'dxf-measurement-value';
    value.textContent = dxfMeasureFormatInches(dxfMeasureValueInches(session, measurement)) || '—';
    row.appendChild(value);

    if (isTarget) return row; // whole row is the control; no mini-buttons
    if (isSource) {
      row.appendChild(dxfMeasurementMiniBtn('Cancel', 'Cancel matching', () => cancelSeamMatch()));
    } else if (!picking && measurement.mode === 'along-path' && pairId == null) {
      row.appendChild(dxfMeasurementMiniBtn('Match', 'Match with another Along Path measurement to compare their lengths',
        () => startSeamMatch(measurement.id)));
    }
    row.appendChild(dxfMeasurementMiniBtn('⌖', 'Frame this measurement in the viewport',
      () => focusDxfMeasurementOnBoard(session, measurement)));
    row.appendChild(dxfMeasurementMiniBtn('✕', 'Delete this measurement',
      () => deleteDxfMeasurementFromPanel(session, measurement.id)));
    return row;
  }

  // The Δ/ease/Unlink row directly beneath a matched pair's two member rows.
  // Delta is recomputed here, not stored — see dxfMeasureSeamPairDelta.
  function buildSeamPairSummaryRow(session, pair) {
    const row = document.createElement('div');
    const delta = dxfMeasureSeamPairDelta(session, pair);
    const status = dxfMeasureSeamPairStatus(delta);
    row.className = 'dxf-seam-summary-row dxf-seam-' + status;

    const label = document.createElement('span');
    label.className = 'dxf-seam-summary-label';
    const deltaText = delta ? (dxfMeasureFormatInches(Math.abs(delta.raw)) || '0"') : '—';
    label.textContent = 'Δ ' + deltaText + (pair.ease ? ' (ease ' + (dxfMeasureFormatInches(Math.abs(pair.ease)) || pair.ease) + ')' : '');
    label.title = status === 'match' ? 'Within 1/16" of expected — match'
      : status === 'review' ? 'Within 3/16" of expected — review'
      : status === 'mismatch' ? 'Over 3/16" from expected — mismatch'
      : 'Could not compute a delta for this pair';
    row.appendChild(label);

    const easeLabel = document.createElement('label');
    easeLabel.className = 'dxf-seam-ease-label';
    easeLabel.textContent = 'Ease';
    const easeInput = document.createElement('input');
    easeInput.type = 'number';
    easeInput.step = '0.01';
    easeInput.className = 'dxf-seam-ease-input';
    easeInput.value = pair.ease || 0;
    easeInput.title = 'Expected difference (first minus second) between the two seams — subtracted before judging the threshold';
    easeInput.addEventListener('click', (e) => e.stopPropagation());
    easeInput.addEventListener('change', () => setSeamPairEaseFromPanel(session, pair.id, easeInput.value));
    easeLabel.appendChild(easeInput);
    row.appendChild(easeLabel);

    row.appendChild(dxfMeasurementMiniBtn('Unlink', 'Remove this seam match (keeps both measurements)',
      () => unlinkSeamPairFromPanel(session, pair.id)));
    return row;
  }

  function renderDxfMeasurementsPanel() {
    const panel = el.dxfMeasurementsPanel, body = el.dxfMeasurementsBody;
    if (!panel || !body || panel.hidden) return;
    const session = state.dxfMeasureSession;
    if (!session) { closeDxfMeasurementsPanel(); return; }
    const active = document.activeElement;
    if (active && body.contains(active) && active.classList.contains('dxf-measurement-name-input')) return;
    const fingerprint = dxfMeasurementsFingerprint(session);
    if (fingerprint === lastDxfMeasurementsFingerprint) return;
    lastDxfMeasurementsFingerprint = fingerprint;

    if (el.dxfMeasurementsCount) {
      const n = session.measurements.length;
      el.dxfMeasurementsCount.textContent = n + (n === 1 ? ' measurement' : ' measurements');
    }
    body.innerHTML = '';
    const rendered = new Set();
    for (const measurement of session.measurements) {
      if (rendered.has(measurement.id)) continue;
      const pairId = dxfMeasureFindSeamPairId(session, measurement.id);
      const pair = pairId != null ? dxfMeasureGetSeamPair(session, pairId) : null;
      if (pair) {
        const a = dxfMeasureGetMeasurement(session, pair.aId);
        const b = dxfMeasureGetMeasurement(session, pair.bId);
        if (a) { body.appendChild(buildDxfMeasurementRow(session, a)); rendered.add(a.id); }
        if (b) { body.appendChild(buildDxfMeasurementRow(session, b)); rendered.add(b.id); }
        body.appendChild(buildSeamPairSummaryRow(session, pair));
        continue;
      }
      body.appendChild(buildDxfMeasurementRow(session, measurement));
      rendered.add(measurement.id);
    }
    if (!session.measurements.length) {
      const empty = document.createElement('div');
      empty.className = 'dxf-measurement-row';
      empty.textContent = 'No measurements yet — use Along Path or Out of Path on the pattern.';
      body.appendChild(empty);
    }
  }

  function bindDxfMeasurementsPanel() {
    if (el.dxfMeasurementsListBtn) {
      el.dxfMeasurementsListBtn.addEventListener('click', () => openDxfMeasurementsPanel());
    }
    if (el.dxfMeasurementsCloseBtn) el.dxfMeasurementsCloseBtn.addEventListener('click', closeDxfMeasurementsPanel);
    if (el.dxfMeasurementsClearAllBtn) {
      el.dxfMeasurementsClearAllBtn.addEventListener('click', () => {
        const session = state.dxfMeasureSession;
        if (session) clearAllDxfMeasurementsFromPanel(session);
      });
    }
    makeDraggablePanel(el.dxfMeasurementsPanel, el.dxfMeasurementsHead, '.anchor-panel-close');
    // US-111: Escape cancels an in-progress "Match with…" pick — additive to
    // whatever else already listens for Escape (dxfMeasureCancelInteraction
    // reads session.interaction, a completely different piece of state, so
    // the two never fight over the same keypress).
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && pendingSeamMatchSourceId != null) cancelSeamMatch();
    });
  }
