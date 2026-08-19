// Measurement / spec panel orchestration.
// Source part for app.js. Run `npm run build` after editing.
//
// renderSpecPanel rebuilds the table on the right side of the board. It
// renders the Auto Mode draft review section (if drafts are present),
// then walks the 18 POM template slots in order — using a drawn
// annotation when the label matches, or a read-only template row when
// nothing has been drawn yet — pairing primary/secondary POMs into one
// row where the schema defines a pair. Every row exposes editable Size L
// and TOL inputs so the TD can enter spec-sheet targets even before a
// line is drawn; those values live on state.pomSpecs (per POM label) and
// persist through save/load + undo/redo.
//
// This file owns the assembly and the US-033 rebuild-skip fingerprint plus
// the Auto Mode status prose and draft-review rows. The pieces it assembles
// live next door: src/ui/spec-values.js (Size L / TOL value model, fraction
// math, pomSpecs read/write), src/ui/spec-row-builders.js (row + cell DOM),
// src/ui/spec-visibility.js (per-POM line visibility on the canvas), and
// src/ui/anchor-manager-panel.js (the separate floating anchor panel).
// The calibration commands the panel's note refers to (setScaleFromSelection
// / clearScale) live with their toolbar listeners in src/ui/bindings.js.

  // ---- Measurement table panel ----
  // Total column count in the spec table:
  //   POM | Description | 中文 | Value | Size L | Size L2 | TOL.
  // Value is the measured length of the drawn line (the connection back to
  // the sketch); Size L is the spec target and TOL its allowed variance.
  // Size L2 is the optional second sample base that anchors the depth tier
  // (M2–5XL2) in the Excel export — blank derives L2 = L + offset.
  const SPEC_COL_COUNT = 7;

  // ---- US-033: rebuild-skip fingerprint -----------------------------------
  // renderSpecPanel runs on every updateUI (every click), but most calls
  // change nothing the table renders from — only the selection moved. The
  // fingerprint captures the table's actual data inputs; when it matches the
  // one stored after the last full rebuild, we refresh highlight classes and
  // stop. Selection is deliberately NOT fingerprinted.
  //
  // If you add a panel feature that renders from state not listed here, add
  // its input to this fingerprint or the panel will go stale.
  let lastSpecPanelFingerprint = null;
  const specDepIds = new WeakMap();
  let specDepNext = 1;

  // Identity marker for heavyweight objects that are replaced wholesale
  // (detection) rather than mutated — cheaper than stringifying them.
  function specDepId(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    if (!specDepIds.has(obj)) specDepIds.set(obj, specDepNext++);
    return specDepIds.get(obj);
  }

  function specPanelFingerprint() {
    const r = (p) => (p ? [Math.round(p.x * 1000), Math.round(p.y * 1000)] : 0);
    const annBits = state.annotations.map(a => [
      a.id, a.seq, a.text, a.type,
      r(a.start), r(a.end), r(a.midPoint),
      r(a.control1), r(a.control2), r(a.midHandleIn), r(a.midHandleOut),
    ]);
    const draftBits = state.autoMode.draftAnnotations.map(d => [
      d.id, d.seq, d.text, !!d.tdApproved, !!d.tdEdited, !!d.tdTouched,
      d.drawability, d.confidence, d.reason, d.uncertainty, d.reviewNotes,
    ]);
    const anchors = state.autoMode.anchors;
    return JSON.stringify([
      state.appMode,
      annBits,
      draftBits,
      state.pomSpecs,
      state.customPoms,
      state.calibration.unitsPerPx, state.calibration.unit,
      state.hiddenAnnIds, state.hiddenDraftIds,
      state.images.length,
      specDepId(state.autoMode.detection),
      anchors.length, anchors.filter(a => a && a.reviewRequired).length,
      // US-038 anchor visibility lives in its OWN floating panel, not the
      // exported Measurements panel — so it is deliberately NOT fingerprinted
      // here.
    ]);
  }

  // US-035: the three numeric column headers name the board's active unit.
  // Runs before the US-033 fingerprint skip — it's three textContent sets,
  // and calibration is fingerprinted so full rebuilds stay correct too.
  function updateSpecUnitHeaders() {
    const u = '(' + (state.calibration.unit || 'in') + ')';
    document.querySelectorAll('.specPanel thead .th-unit').forEach((elm) => {
      if (elm.textContent !== u) elm.textContent = u;
    });
  }

  function renderSpecPanel() {
    renderSpecCalNote();
    updateSpecUnitHeaders();
    // Only preserve focus when the user is mid-edit in a text field inside
    // the panel — annotation rows, template rows, and paired rows all
    // qualify. Draft rows have no editable inputs, so Approve / R/O buttons
    // must always allow a full rebuild — otherwise row badges and the
    // review-header counts go stale (e.g. Approved/Edited badges, the
    // "N approved" line in the panel header).
    const active = document.activeElement;
    const editingPanelField = active
      && el.specBody.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      // The Add-POM inline form (US-011) also counts: rebuilding while the
      // TD types the new POM's name would destroy the half-typed entry.
      && !!(active.closest('tr[data-ann-id]') || active.closest('tr[data-pom-key]')
        || active.closest('tr.add-pom-row'));
    if (editingPanelField) {
      updateSpecHighlightOnly();
      return;
    }

    // US-033: nothing the table renders from changed — selection-only call.
    const fingerprint = specPanelFingerprint();
    if (fingerprint === lastSpecPanelFingerprint) {
      updateSpecHighlightOnly();
      return;
    }

    el.specBody.innerHTML = '';

    // Sticky visibility control row: renders whenever there is at least one
    // hideable line, offering "Hide all" (isolate the sketch) and, once
    // anything is hidden, "Show all" — each a one-click toggle so the TD can
    // reveal and re-hide lines while checking evidence.
    if (hideablePomCount() > 0) {
      el.specBody.appendChild(buildVisibilityControlRow());
    }

    // Auto Mode: render the 18-row draft review section first.
    const draftPomKeys = new Set();
    // Construction summary renders whenever a detection exists — the TD
    // lands in Manual mode after Apply (ADR 0008) and still needs to see
    // what the detector recognized. No-op on pure manual projects.
    renderConstructionSummary();

    if (state.appMode === 'auto') {
      renderAutoReviewHeader();
      const drafts = state.autoMode.draftAnnotations
        .slice()
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const draft of drafts) {
        el.specBody.appendChild(buildDraftRow(draft));
        const draftKey = String(draft.text != null ? draft.text : draft.seq);
        if (draftKey) draftPomKeys.add(draftKey);
      }
    }

    // Panel is now pre-populated with the 18 POM template rows, so the
    // "No measurements yet" placeholder is redundant.
    el.specEmpty.style.display = 'none';

    // Lookup by effective POM label so each slot can find its annotation.
    const anns = state.annotations.slice();
    const annByPom = new Map();
    for (const ann of anns) annByPom.set(getLabelText(ann), ann);

    // Render one row per POM slot in POM order — every POM gets its own row,
    // including the band (1 & 2) and chest (3 & 4) pairs, which each show
    // their own description, 中文, TOL and Size L. Pairing still lives in the
    // rule data (it drives the POM 2/4 extension-stub geometry) but is no
    // longer merged into a single panel row. Uses the annotation when one
    // exists, else a template row so 中文 / TOL / Size L stay editable. In
    // Auto Mode, POMs covered by an outstanding draft skip their template row
    // so the draft review section is not duplicated.
    const renderedAnnIds = new Set();
    const templateOrder = Object.keys(POM_TEMPLATE).sort((a, b) => Number(a) - Number(b));
    for (const pomKey of templateOrder) {
      const ann = annByPom.get(pomKey) || null;
      if (ann) {
        el.specBody.appendChild(buildSingleSpecRow(ann));
        renderedAnnIds.add(ann.id);
      } else if (!draftPomKeys.has(pomKey)) {
        el.specBody.appendChild(buildTemplateSpecRow(pomKey));
      }
    }

    // Registered custom POMs (19+, US-011) render template-style rows right
    // after the core 18 — with or without a drawn line — so a TD can spec them
    // before drawing. A row with a line behaves exactly like a template POM.
    const customKeys = (state.customPoms || []).map(p => String(p.pom))
      .sort((a, b) => Number(a) - Number(b));
    for (const pomKey of customKeys) {
      const ann = annByPom.get(pomKey) || null;
      if (ann) {
        el.specBody.appendChild(buildSingleSpecRow(ann));
        renderedAnnIds.add(ann.id);
      } else if (!draftPomKeys.has(pomKey)) {
        const tr = buildTemplateSpecRow(pomKey);
        decorateCustomPomRow(tr, pomKey);
        el.specBody.appendChild(tr);
      }
    }

    // Any additional user-labeled annotations that fall outside 1..18
    // (unregistered custom labels, renamed labels) render after the template
    // block in POM-numerical order.
    const extras = anns
      .filter(a => !renderedAnnIds.has(a.id))
      .sort((a, b) => labelSortKey(a) - labelSortKey(b) || a.seq - b.seq);
    for (const ann of extras) {
      if (renderedAnnIds.has(ann.id)) continue;
      el.specBody.appendChild(buildSingleSpecRow(ann));
      renderedAnnIds.add(ann.id);
    }

    el.specBody.appendChild(buildAddPomRow());

    // Stored only after a COMPLETED rebuild — the focus-guard early return
    // above must never mark a skipped rebuild as up to date.
    lastSpecPanelFingerprint = fingerprint;
  }

  function renderSpecCalNote() {
    let note = 'Label a callout with its <b>POM number</b> (e.g. 8) to auto-fill its description and standard size-L value. Values are editable per style.';
    if (state.appMode === 'auto') {
      const det = state.autoMode.detection;
      const anchors = state.autoMode.anchors;
      const drafts = state.autoMode.draftAnnotations;
      if (drafts.length > 0) {
        note = 'Auto Mode — <b>review drafts</b>: approve, mark review-only, or drag endpoints to edit. Then <i>Apply Approved Lines</i>.';
      } else if (anchors.length > 0 && state.autoMode.anchorsHidden) {
        note = '<b>Auto Mode — POM lines applied.</b> Anchors are hidden. Click <b>Reset Anchors</b> to show and re-tune them, or <b>Detect</b> to start over.';
      } else if (anchors.length > 0) {
        const edited = anchors.filter(a => !a.autoFilled).length;
        note = '<b>Auto Mode — anchors placed.</b> ' + anchors.length + ' anchors' +
          (edited > 0 ? ' (' + edited + ' adjusted)' : ' (all auto-seeded)') +
          '. Drag any that look wrong, then click <b>Generate POM Drafts</b>.';
      } else if (det) {
        const pct = (det.coverage * 100).toFixed(1);
        const features = [];
        features.push('band');
        if (det.chestY != null) features.push('chest');
        if (det.cradleY != null) features.push('cradle');
        if (det.sideLeftX != null) features.push('seam L');
        if (det.sideRightX != null) features.push('seam R');
        if (det.apexLeft) features.push('apex L');
        if (det.apexRight) features.push('apex R');
        if (det.strapTop && det.strapBottom) features.push('strap');
        if (det.back && det.back.top && det.back.bottom) features.push('back center');
        const sym = det.symmetry != null ? ' • sym ' + Math.round(det.symmetry * 100) + '%' : '';
        const fit = det.quality != null
          ? ' • fit ' + (det.quality >= 0.65 ? 'A' : (det.quality >= 0.40 ? 'B' : 'C'))
          : '';
        let views = '';
        if (det.viewBoxes && det.viewBoxes.length > 1) {
          const frontOuter = det.viewBoxes.find(v => v && (v.viewRole === 'front_outer' || v.role === 'front'));
          const frontInner = det.viewBoxes.find(v => v && v.viewRole === 'front_inner');
          const back  = det.viewBoxes.find(v => v && (v.viewRole === 'back' || v.role === 'back'));
          if (frontOuter && back && frontInner) {
            views = ' • front outer + back + front inner identified';
          } else if (frontOuter && back) {
            views = ' • front outer + back identified';
          } else if (frontOuter) {
            views = ' • ' + det.viewBoxes.length + ' views, front outer identified';
          } else {
            views = ' • ' + det.viewBoxes.length + ' views, using #' + ((det.primaryViewIndex || 0) + 1);
          }
          if (det.viewRoleReviewRequired) views += ' • roles need review';
        }
        note = '<b>Auto Mode — detected sketch.</b> ' + det.sampleWidth + '×' + det.sampleHeight +
          ' • local offline vision' + views + ' • ' + pct + '% coverage' + sym + fit +
          (det.durationMs != null ? ' • ' + det.durationMs + 'ms' : '') +
          '<br><span class="muted">Features: ' + features.join(', ') +
          '</span>. Next: drag any wrong anchors, then <i>Generate POM Drafts</i>.';
      } else {
        note = 'Auto Mode — click <b>Detect Sketch</b> to estimate the bra shape, then anchors, then POM drafts.';
      }
    }
    // Scale status applies in every mode, so append it last — the Auto Mode
    // branch above rebuilds `note` from scratch and would otherwise drop it.
    if (state.calibration.unitsPerPx != null) {
      note += ' <b>Scale set</b> — Value shown in <b>' + state.calibration.unit + '</b>.';
    } else {
      note += ' <span class="muted">Value in px — use <b>Set Scale</b> for real units.</span>';
    }
    el.specCal.innerHTML = note;
  }

  // Read-only "Detected from sketch" summary (v1). Surfaces the construction
  // facts the detector already knows — detected views, the front-closure
  // placket signature (ADR 0023 junction tier), the cup model, and how many
  // anchors are flagged for review — so the TD sees what the tool recognized
  // before reading the 18 draft rows. Display-only in this slice; confirming
  // these as library style-feature evidence (LIBRARY_CONSTRUCTION_TAXONOMY.md
  // Tier A) is a later slice. Absence of the placket signature is reported as
  // "not found", never as a claim about the back closure.
  function renderConstructionSummary() {
    const det = state.autoMode.detection;
    if (!det) return;

    const parts = [];

    const roleLabels = { front_outer: 'front outer', front_inner: 'front inner', back: 'back' };
    const seen = [];
    for (const v of (Array.isArray(det.views) ? det.views : [])) {
      const label = roleLabels[v && (v.viewRole || v.role)];
      if (label && !seen.includes(label)) seen.push(label);
    }
    if (seen.length) {
      parts.push('<b>Views:</b> ' + escapeHtml(seen.join(' + '))
        + (det.viewRoleReviewRequired
          ? ' <span style="color:#b45309;font-weight:600">— roles need review</span>' : ''));
    }

    parts.push('<b>Closure:</b> ' + (det.cradleCfTopJunction
      ? 'front-closure signature (placket interrupts the CF seam) — '
        + '<span style="color:#b45309;font-weight:600">confirm</span>'
      : 'no front-closure signature found'));

    const cm = det.cupModel;
    if (cm) {
      const bits = [cm.side === 1 ? 'right cup' : (cm.side === -1 ? 'left cup' : 'cup')];
      if (cm.visibility) bits.push(cm.visibility + ' visibility');
      if (typeof cm.contourConfidence === 'number') bits.push('contour ' + cm.contourConfidence.toFixed(2));
      if (typeof cm.seamConfidence === 'number') bits.push('seam ' + cm.seamConfidence.toFixed(2));
      parts.push('<b>Cup:</b> ' + escapeHtml(bits.join(' · ')));
    }

    const anchors = state.autoMode.anchors;
    if (anchors.length) {
      const revCount = anchors.filter(a => a && a.reviewRequired).length;
      parts.push('<b>Anchors:</b> ' + (revCount ? revCount + ' flagged for review' : 'none flagged'));
    }

    const tr = document.createElement('tr');
    tr.className = 'draft-row';
    tr.style.background = 'transparent';
    const td = document.createElement('td');
    td.colSpan = SPEC_COL_COUNT;
    td.innerHTML = '<div class="construction-summary" style="background:#f0f9ff;'
      + 'border:1px solid #bae6fd;color:#0c4a6e;border-radius:6px;padding:6px 8px;'
      + 'margin:4px 0;font-size:12px;line-height:1.5">'
      + '<b>Detected from sketch</b><br>' + parts.join('<br>')
      + '</div>';
    tr.appendChild(td);
    el.specBody.appendChild(tr);
  }

  function renderAutoReviewHeader() {
    const auto = state.autoMode;
    const drafts = auto.draftAnnotations;
    const hasDrafts = drafts.length > 0;
    const hasErrors = !!(auto.validation && auto.validation.errors && auto.validation.errors.length);
    const hasWarnings = !!(auto.validation && auto.validation.warnings && auto.validation.warnings.length);
    const hasLastError = !!auto.lastError;
    // Nothing to review and nothing to report — skip the section entirely so
    // the applied board isn't cluttered with an empty "0 rows" header.
    if (!hasDrafts && !hasErrors && !hasWarnings && !hasLastError) return;

    const approvable = drafts.filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
    const highApprovable = approvable.filter(d => d.confidence === 'high');
    const approved = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const reviewOnly = drafts.filter(d => isReviewOnlyDraft(d)).length;

    const headerTr = document.createElement('tr');
    headerTr.className = 'draft-row';
    headerTr.style.background = 'transparent';
    const headerTd = document.createElement('td');
    headerTd.colSpan = SPEC_COL_COUNT;
    // Draft-review summary + bulk actions only when drafts are outstanding;
    // the error / warning blocks below render on their own.
    let html = '';
    if (hasDrafts) {
      html += '<div class="auto-review-head">' +
        '<b>Auto Mode draft review</b> — ' + drafts.length + ' row' + (drafts.length === 1 ? '' : 's') + ' • ' +
        approved + ' approved • ' + reviewOnly + ' review-only' +
        (auto.runId ? '<br><span style="font-weight:400">Run: ' + auto.runId + '</span>' : '') +
        '<div class="auto-review-bulk">' +
          '<button type="button" class="auto-bulk-btn" data-bulk="approve-all"' +
            (approvable.length === 0 ? ' disabled' : '') + '>' +
            'Approve all (' + approvable.length + ')' +
          '</button>' +
          '<button type="button" class="auto-bulk-btn" data-bulk="approve-high"' +
            (highApprovable.length === 0 ? ' disabled' : '') + '>' +
            'Approve high-confidence (' + highApprovable.length + ')' +
          '</button>' +
        '</div>' +
        '</div>';
    }

    if (auto.validation && auto.validation.errors && auto.validation.errors.length) {
      html += '<div class="auto-review-errors"><b>Validation errors</b><ul>' +
        auto.validation.errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.validation && auto.validation.warnings && auto.validation.warnings.length) {
      html += '<div class="auto-review-errors" style="background:#fffbeb;border-color:#fde68a;color:#854d0e"><b>Warnings</b><ul>' +
        auto.validation.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.lastError) {
      html += '<div class="auto-review-errors"><b>Last error</b><br>' +
        escapeHtml(auto.lastError) + '</div>';
    }
    headerTd.innerHTML = html;
    headerTd.querySelectorAll('[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.getAttribute('data-bulk');
        const targets = mode === 'approve-high' ? highApprovable : approvable;
        if (targets.length === 0) return;
        for (const d of targets) approveDraftAnnotation(d);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        showToast('Approved ' + targets.length + ' draft' + (targets.length === 1 ? '' : 's') + '.');
      });
    });
    headerTr.appendChild(headerTd);
    el.specBody.appendChild(headerTr);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildDraftRow(draft) {
    const tr = document.createElement('tr');
    tr.dataset.draftId = draft.id;
    tr.classList.add('draft-row');
    if (isReviewOnlyDraft(draft)) tr.classList.add('review-only');
    if (draft.tdApproved) tr.classList.add('approved');
    if (state.selection.kind === 'draft' && state.selection.id === draft.id) {
      tr.classList.add('selected');
    }
    if (isDraftHidden(draft.id)) tr.classList.add('pom-hidden');
    tr.addEventListener('click', () => setSelection('draft', draft.id));

    const pomTd = document.createElement('td');
    const pomLabel = document.createElement('span');
    const draftKey = draft.text != null ? String(draft.text) : String(draft.seq);
    pomLabel.textContent = draftKey;
    pomLabel.style.fontWeight = '700';
    pomLabel.title = getPomTooltip(draftKey);
    pomTd.appendChild(pomLabel);
    appendVisibilityToggle(pomTd, {
      hidden: isDraftHidden(draft.id),
      onToggle: () => toggleDraftHidden(draft.id),
    });
    const status = document.createElement('span');
    status.className = 'draft-status';
    if (isReviewOnlyDraft(draft)) status.textContent = 'Review-only';
    else if (draft.tdApproved) status.textContent = 'Approved';
    else if (draft.tdEdited) status.textContent = 'Edited';
    else status.textContent = draft.drawability === 'APPROXIMATE' ? 'Approx' : 'Draft';
    pomTd.appendChild(status);

    const descTd = document.createElement('td');
    const descBody = document.createElement('div');
    descBody.className = 'spec-desc-text';
    const standardDesc = getPomInfo(draft.text || draft.seq).desc || '—';
    descBody.textContent = standardDesc;
    descBody.title = standardDesc;
    descTd.appendChild(descBody);
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10.5px;color:#6b7280;margin-top:2px;line-height:1.35';
    const metaBits = [];
    if (draft.confidence) metaBits.push('conf: ' + draft.confidence);
    if (draft.reason) metaBits.push(draft.reason);
    if (draft.uncertainty && isReviewOnlyDraft(draft)) metaBits.push(draft.uncertainty);
    // Phase 7: the landmark-QA explanations behind a review-only demotion
    // (missing seam, no back view, inferred cup, …) so the TD sees the "why"
    // without opening the debug payload.
    if (isReviewOnlyDraft(draft) && Array.isArray(draft.reviewNotes)) {
      for (const note of draft.reviewNotes) metaBits.push(note);
    }
    if (metaBits.length) meta.textContent = metaBits.join(' • ');
    descTd.appendChild(meta);

    const actionsTd = document.createElement('td');
    actionsTd.colSpan = SPEC_COL_COUNT - 2;
    actionsTd.style.cssText = 'white-space:nowrap';

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.textContent = draft.tdApproved ? 'Approved' : 'Approve';
    approveBtn.disabled = isReviewOnlyDraft(draft) || draft.tdApproved;
    approveBtn.style.cssText = 'padding:3px 8px;font-size:11px;margin-right:4px';
    approveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      approveDraftAnnotation(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(approveBtn);

    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.textContent = 'R/O';
    reviewBtn.title = 'Mark this row REVIEW_ONLY';
    reviewBtn.disabled = isReviewOnlyDraft(draft);
    reviewBtn.style.cssText = 'padding:3px 8px;font-size:11px';
    reviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      markDraftReviewOnly(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(reviewBtn);

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(actionsTd);
    return tr;
  }

  function blurActivePanelField() {
    // Drop focus off any input/button inside the spec panel so the next
    // renderSpecPanel pass is free to rebuild rows (Approve / R/O state).
    const active = document.activeElement;
    if (active && el.specBody.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
  }

  // US-028: live measured value. While an endpoint is dragged or key-nudged,
  // replace just that line's Value cell — a full renderSpecPanel rebuild per
  // mousemove/keystroke would steal focus from other panel fields and is
  // needlessly heavy. buildMeasuredValueCell keeps value, tolerance chip,
  // tooltip, and the 📏 re-calibrate button in one code path. The commit-time
  // renderSpecPanel (via pushHistoryIfChanged → updateUI) stays the backstop.
  function refreshMeasuredValueForAnnotation(annId) {
    const ann = state.annotations.find(a => a.id === annId) || null;
    if (!ann) return; // Auto-Mode drafts have no annotation spec row — no-op.
    const tr = el.specBody.querySelector('tr[data-ann-id="' + ann.id + '"]');
    if (!tr) return;
    const oldTd = tr.querySelector('.spec-td-value');
    if (!oldTd) return;
    tr.replaceChild(buildMeasuredValueCell(ann, getLabelText(ann)), oldTd);
  }

  function updateSpecHighlightOnly() {
    const rows = el.specBody.querySelectorAll('tr');
    rows.forEach((tr) => {
      const selId = state.selection.kind === 'annotation' ? String(state.selection.id) : null;
      const isAnnSel = selId != null
        && (selId === tr.dataset.annId || selId === tr.dataset.pairAnnId);
      const isDraftSel = state.selection.kind === 'draft' && String(state.selection.id) === tr.dataset.draftId;
      tr.classList.toggle('selected', isAnnSel || isDraftSel);
    });
  }
