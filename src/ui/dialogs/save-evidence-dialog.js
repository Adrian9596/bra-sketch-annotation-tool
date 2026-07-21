// Save-time style-evidence prompt shown when saveProject() sees TD-edited
// auto-applied lines (or other evidence candidates).
// Source part for app.js. Run `npm run build` after editing.
//
// The dialog has two inline editing surfaces so the TD can teach the
// store without leaving the save flow:
//   - A Style code input that updates state.styleId on accept, so
//     evidence lands in the right bucket instead of __default__.
//   - A per-row meaning picker pre-filled with the top-3 ranked
//     suggestions for that POM's geometry plus a "Show all meanings"
//     escape hatch. Confirming a row stamps the candidate with the
//     chosen meaningId and writes it into the style's meaning catalog
//     so future Auto runs on this style resolve POM N silently.
// A bulk "Confirm all suggested" button applies the top suggestion to
// every unconfirmed row at once when the TD trusts the ranking.

  // Save-time evidence prompt. Triggered by saveProject() when the
  // project contains TD-edited Auto-applied lines that are eligible to
  // become style evidence. Resolves with one of:
  //   { action: 'cancel' }                        — close save flow
  //   { action: 'project-only' }                  — save without evidence
  //   { action: 'save-with-evidence', commit: true } — save + commit candidates
  // The caller (project-io.js) owns the actual file write so the dialog
  // stays pure UI.
  function openSaveEvidenceDialog({ styleId, candidates }) {
    const dialog = buildDialog({
      title: 'Save style evidence?',
      sub: 'TD corrections can teach this style next time.',
    });

    const initialStyleId = (styleId && styleId !== '__default__') ? String(styleId) : '';
    // Local dialog state. Style code + meaning confirmations stay
    // un-committed until the user clicks one of the Save buttons; Cancel
    // throws everything away so the rest of the app sees no side effect.
    let pendingStyleId = initialStyleId;
    const pendingMeanings = new Map(); // pom -> { meaningId, label }

    const body = document.createElement('div');
    body.className = 'dialog-body save-evidence-body';

    // --- Style code input ---------------------------------------------
    const styleSection = document.createElement('div');
    styleSection.className = 'se-style-section';
    const styleLabel = document.createElement('label');
    styleLabel.className = 'se-style-label';
    styleLabel.textContent = 'Style code';
    const styleInput = document.createElement('input');
    styleInput.type = 'text';
    styleInput.className = 'se-style-input';
    styleInput.placeholder = 'e.g. AF-123 — leave empty to use the default bucket';
    styleInput.autocomplete = 'off';
    styleInput.spellcheck = false;
    styleInput.maxLength = 40;
    styleInput.value = pendingStyleId;
    styleSection.appendChild(styleLabel);
    styleSection.appendChild(styleInput);
    body.appendChild(styleSection);

    const styleHint = document.createElement('p');
    styleHint.className = 'se-hint';
    styleSection.appendChild(styleHint);

    // --- Candidate rows ----------------------------------------------
    const heading = document.createElement('p');
    heading.className = 'se-heading';
    body.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'se-candidate-list';
    body.appendChild(list);

    const bulkBar = document.createElement('div');
    bulkBar.className = 'se-bulk-bar';
    const bulkBtn = document.createElement('button');
    bulkBtn.type = 'button';
    bulkBtn.className = 'picker-btn se-bulk-btn';
    bulkBtn.textContent = 'Confirm all suggested';
    bulkBar.appendChild(bulkBtn);
    body.appendChild(bulkBar);

    const note = document.createElement('p');
    note.className = 'se-note';
    body.appendChild(note);

    dialog.panel.appendChild(body);

    // --- Footer -------------------------------------------------------
    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const onlyBtn = document.createElement('button');
    onlyBtn.type = 'button';
    onlyBtn.className = 'picker-btn';
    onlyBtn.textContent = 'Save project only';
    const bothBtn = document.createElement('button');
    bothBtn.type = 'button';
    bothBtn.className = 'picker-btn primary';
    footer.appendChild(spacer);
    footer.appendChild(cancelBtn);
    footer.appendChild(onlyBtn);
    footer.appendChild(bothBtn);
    dialog.panel.appendChild(footer);

    // --- Per-row rendering -------------------------------------------
    const rowControllers = []; // each: { candidate, refresh(), confirmTop() }
    for (const c of candidates) {
      const ctrl = buildCandidateRow(c, pendingMeanings, list, updateAll);
      rowControllers.push(ctrl);
    }

    function buildCandidateRow(candidate, pendingMap, parent, onChange) {
      const row = document.createElement('div');
      row.className = 'se-row';
      const pomEl = document.createElement('span');
      pomEl.className = 'se-pom';
      pomEl.textContent = 'POM ' + (candidate.pom || '?');
      const labelEl = document.createElement('span');
      labelEl.className = 'se-label';
      const metaEl = document.createElement('span');
      metaEl.className = 'se-meta';
      metaEl.textContent = candidate.viewRole ? '· ' + candidate.viewRole : '';
      row.appendChild(pomEl);
      row.appendChild(labelEl);
      row.appendChild(metaEl);
      parent.appendChild(row);

      const isAbsent = candidate.tdStatus === 'absent-confirmed';
      const initialMeaningId = candidate.meaningId || null;

      let suggestionIds = [];
      if (!isAbsent && !initialMeaningId) {
        suggestionIds = computeMeaningSuggestionIds(candidate);
      }

      // Renders the row in the right state — already-confirmed (catalog
      // hit), TD-confirmed-in-dialog, absent, or picker. Called once at
      // build time and again when pendingMeanings flips.
      function render() {
        // Reset row to a known state.
        row.classList.remove('is-confirmed', 'is-absent', 'is-pending');
        const dialogConfirmed = pendingMap.get(String(candidate.pom));
        if (isAbsent) {
          row.classList.add('is-absent');
          labelEl.textContent = (candidate.meaningLabel || candidate.meaningId || 'Measurement')
            + ' is absent in this style';
          // Wipe any prior picker controls.
          stripExtras();
          return;
        }
        if (initialMeaningId) {
          row.classList.add('is-confirmed');
          labelEl.textContent = candidate.meaningLabel || candidate.meaningId;
          stripExtras();
          return;
        }
        if (dialogConfirmed) {
          row.classList.add('is-confirmed');
          labelEl.innerHTML = '<span class="se-check">✓</span> '
            + escapeHtml(dialogConfirmed.label);
          stripExtras();
          // Offer an undo so a mis-click can be reversed before save.
          const undoBtn = document.createElement('button');
          undoBtn.type = 'button';
          undoBtn.className = 'se-undo';
          undoBtn.textContent = 'Change';
          undoBtn.addEventListener('click', () => {
            pendingMap.delete(String(candidate.pom));
            render();
            onChange();
          });
          row.appendChild(undoBtn);
          return;
        }
        // Unconfirmed → show picker.
        row.classList.add('is-pending');
        labelEl.textContent = '(meaning not confirmed)';
        stripExtras();
        const picker = buildPicker();
        row.appendChild(picker);
      }

      function stripExtras() {
        const extras = row.querySelectorAll('.se-picker, .se-undo');
        extras.forEach(el => el.remove());
      }

      function buildPicker() {
        const wrap = document.createElement('div');
        wrap.className = 'se-picker';
        const select = document.createElement('select');
        select.className = 'se-picker-select';
        const seen = new Set();
        for (const id of suggestionIds) {
          const entry = (typeof getCatalogEntry === 'function') ? getCatalogEntry(id) : null;
          if (!entry || seen.has(entry.id)) continue;
          seen.add(entry.id);
          const opt = document.createElement('option');
          opt.value = entry.id;
          opt.textContent = entry.label;
          select.appendChild(opt);
        }
        // Always include an "Other…" option that swaps the dropdown for
        // the full catalog, so a missed suggestion is still reachable
        // without leaving the dialog.
        const otherOpt = document.createElement('option');
        otherOpt.value = '__other__';
        otherOpt.textContent = seen.size ? '— Show all meanings —' : 'Pick a meaning…';
        select.appendChild(otherOpt);
        if (!seen.size) select.value = '__other__';

        select.addEventListener('change', () => {
          if (select.value === '__other__') swapToFullCatalog(select, seen);
        });
        // If no suggestions came back, open the full catalog immediately.
        if (!seen.size) swapToFullCatalog(select, seen);

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'picker-btn primary se-confirm';
        confirmBtn.textContent = 'Confirm';
        confirmBtn.addEventListener('click', () => {
          const id = select.value;
          if (!id || id === '__other__') return;
          const entry = (typeof getCatalogEntry === 'function') ? getCatalogEntry(id) : null;
          if (!entry) return;
          pendingMap.set(String(candidate.pom), { meaningId: entry.id, label: entry.label });
          render();
          onChange();
        });
        wrap.appendChild(select);
        wrap.appendChild(confirmBtn);
        return wrap;
      }

      // First render.
      render();

      return {
        candidate,
        hasSuggestion: () => suggestionIds.length > 0 || initialMeaningId != null,
        isUnconfirmed: () => {
          if (isAbsent || initialMeaningId) return false;
          return !pendingMap.has(String(candidate.pom));
        },
        confirmTop() {
          if (isAbsent || initialMeaningId) return false;
          if (pendingMap.has(String(candidate.pom))) return false;
          const id = suggestionIds[0];
          if (!id) return false;
          const entry = (typeof getCatalogEntry === 'function') ? getCatalogEntry(id) : null;
          if (!entry) return false;
          pendingMap.set(String(candidate.pom), { meaningId: entry.id, label: entry.label });
          render();
          return true;
        },
        refresh: render,
      };
    }

    function swapToFullCatalog(select, seen) {
      const all = (typeof getAllCatalogMeanings === 'function') ? getAllCatalogMeanings() : [];
      // Preserve the already-seen suggestion entries at the top so the
      // ranking signal isn't lost when the TD wants to browse further.
      const top = Array.from(seen);
      select.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Pick a meaning…';
      placeholder.disabled = true;
      placeholder.selected = true;
      select.appendChild(placeholder);
      for (const id of top) {
        const entry = (typeof getCatalogEntry === 'function') ? getCatalogEntry(id) : null;
        if (!entry) continue;
        const opt = document.createElement('option');
        opt.value = entry.id;
        opt.textContent = '★ ' + entry.label;
        select.appendChild(opt);
      }
      for (const m of all) {
        if (seen.has(m.id)) continue;
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        select.appendChild(opt);
      }
    }

    // Rank suggestions for a candidate by handing the live annotation back
    // to rankCatalogForLine — same engine that drives the meaning popover.
    function computeMeaningSuggestionIds(candidate) {
      if (typeof rankCatalogForLine !== 'function') return [];
      if (!state || !Array.isArray(state.annotations)) return [];
      const ann = state.annotations.find(a => a && a.id === candidate.annotationId);
      if (!ann) return [];
      const image = (typeof pickImageForAnnotation === 'function') ? pickImageForAnnotation(ann) : null;
      if (!image) return [];
      const ranked = rankCatalogForLine(image, ann, 3);
      return ranked.map(m => m.id).filter(Boolean);
    }

    // ---- Reactive bits ----------------------------------------------
    function effectiveStyleId() {
      return pendingStyleId || '__default__';
    }

    function isDefaultBucket() {
      return !pendingStyleId;
    }

    function unconfirmedRowsWithSuggestion() {
      return rowControllers.filter(c => c.isUnconfirmed() && c.hasSuggestion());
    }

    function updateAll() {
      const styleIsDefault = isDefaultBucket();
      const unconfirmed = unconfirmedRowsWithSuggestion();

      styleHint.textContent = styleIsDefault
        ? 'Evidence will land in the default bucket. Type a code (e.g. style number on the spec) to keep this style separate from others.'
        : 'Evidence will be saved under style code "' + pendingStyleId + '".';

      heading.textContent = candidates.length === 1
        ? 'The project has 1 TD correction ready to remember:'
        : 'The project has ' + candidates.length + ' TD corrections ready to remember:';

      const noteParts = [
        styleIsDefault
          ? 'You can still save the project. Evidence will only attach to a real style code once one is set.'
          : 'Saving evidence stores confirmed lines and confirmed missing POMs in the browser so Detect can compare next time.',
      ];
      const confirmedInDialog = pendingMeanings.size;
      if (confirmedInDialog > 0) {
        noteParts.push(confirmedInDialog === 1
          ? '1 meaning will be remembered for this style.'
          : confirmedInDialog + ' meanings will be remembered for this style.');
      }
      note.textContent = noteParts.join(' ');

      bulkBar.style.display = unconfirmed.length >= 2 ? '' : 'none';
      bulkBtn.textContent = 'Confirm top suggestion for '
        + unconfirmed.length + ' POM' + (unconfirmed.length === 1 ? '' : 's');

      bothBtn.textContent = styleIsDefault
        ? 'Save project + evidence (default bucket)'
        : 'Save project + evidence';
    }

    styleInput.addEventListener('input', () => {
      pendingStyleId = styleInput.value.trim();
      updateAll();
    });
    bulkBtn.addEventListener('click', () => {
      let confirmed = 0;
      for (const ctrl of rowControllers) {
        if (ctrl.confirmTop()) confirmed += 1;
      }
      if (confirmed > 0) updateAll();
    });

    updateAll();

    return new Promise(resolve => {
      let settled = false;
      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      function applyPendingStyleId() {
        const next = pendingStyleId.trim();
        if (next === (state.styleId || '').trim()) return;
        state.styleId = next;
        if (typeof updateUI === 'function') updateUI();
      }

      function applyPendingMeanings() {
        if (typeof confirmPomMeaning !== 'function') return;
        for (const [pom, value] of pendingMeanings.entries()) {
          confirmPomMeaning(pom, value.meaningId);
          // Stamp the candidate so the evidence record carries the
          // newly-confirmed meaning into addStyleEvidence.
          const candidate = candidates.find(c => String(c.pom) === String(pom));
          if (candidate) {
            candidate.meaningId = value.meaningId;
            candidate.meaningLabel = value.label;
          }
        }
      }

      const observer = new MutationObserver(() => {
        if (!document.body.contains(dialog.overlay)) {
          observer.disconnect();
          settle({ action: 'cancel' });
        }
      });
      observer.observe(document.body, { childList: true });

      cancelBtn.addEventListener('click', () => {
        dialog.close();
        settle({ action: 'cancel' });
      });
      onlyBtn.addEventListener('click', () => {
        // Project-only still applies the typed style code — it's a
        // project-level field the TD just edited explicitly. Pending
        // meaning confirmations stay un-committed, matching the user's
        // intent to skip the learning step this round.
        applyPendingStyleId();
        dialog.close();
        settle({ action: 'project-only' });
      });
      bothBtn.addEventListener('click', () => {
        applyPendingStyleId();
        applyPendingMeanings();
        dialog.close();
        settle({ action: 'save-with-evidence', commit: true });
      });
      dialog.open();
      // Focus the style input first when none is set so the TD can type
      // a code immediately; otherwise jump to the primary Save button.
      if (!pendingStyleId) styleInput.focus();
      else bothBtn.focus();
    });
  }
