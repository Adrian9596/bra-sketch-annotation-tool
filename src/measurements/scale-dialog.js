// Set Scale dialog: calibrate board units-per-pixel from one known line.
// Source part for app.js. Run `npm run build` after editing.

  // refLabel is optional. When calibrating from a spec-panel row it names the
  // POM ("POM 1 — 1/2 Bottom Band, Relax"); the Set Scale button passes nothing
  // and the copy falls back to "selected line".
  //
  // annId is optional (round 9, Codex follow-up on US-104). The spec-panel 📏
  // shortcut (spec-row-builders.js) opens this dialog for a POM's line without
  // ever selecting it on the board, so with several look-alike DXF/Template
  // segments a TD had no way to tell which physical line the dialog was
  // about. Selecting it here makes the board's own selection rendering
  // (handles, active colour) highlight exactly that segment for as long as
  // the dialog is open — setScaleFromSelection's caller is already the
  // primary selection, so this is a no-op there.
  function openScaleDialog(px, refLabel, annId) {
    if (annId != null && (state.selection.kind !== 'annotation' || state.selection.id !== annId)) {
      setSelection('annotation', annId);
    }
    const cal = state.calibration;
    const currentUnit = cal && cal.unit ? cal.unit : 'in';
    const currentValue = cal && cal.unitsPerPx != null
      ? +(px * cal.unitsPerPx).toFixed(3)
      : '';
    const refText = refLabel ? refLabel : 'the selected line';
    const pxText = Math.round(px);

    const dialog = buildDialog({
      title: 'Set scale',
      sub: 'Calibrate the board from one known length.',
    });

    const body = document.createElement('div');
    body.className = 'scale-body';
    body.innerHTML = `
      <p class="scale-lead">Type the real length of <b>${refText}</b> (now highlighted on the board) — measured as <b>${pxText} px</b>. Every other line on the board is then estimated from it.</p>
      <div class="scale-field">
        <input type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 14" aria-label="Real length" />
        <select aria-label="Unit">
          <option value="in">in</option>
          <option value="cm">cm</option>
          <option value="mm">mm</option>
          <option value="m">m</option>
        </select>
      </div>
      <p class="scale-note">Tip: choose a line whose true measurement you know — a band, a strap, or a ruler shown in the photo.</p>`;
    dialog.panel.appendChild(body);

    const input = body.querySelector('input');
    const select = body.querySelector('select');
    input.value = currentValue === '' ? '' : String(currentValue);
    select.value = currentUnit;

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'picker-btn primary';
    applyBtn.textContent = 'Set scale';
    footer.appendChild(spacer);
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    dialog.panel.appendChild(footer);

    function apply() {
      const value = parseFloat(input.value);
      if (!isFinite(value) || value <= 0) {
        input.focus();
        input.select();
        showToast('Enter a length greater than zero, e.g. 70.');
        return;
      }
      const unit = select.value;
      state.calibration = { unitsPerPx: value / px, unit };
      pushHistoryIfChanged();
      showToast('Scale set: the table now estimates every line in ' + unit + '.');
      updateUI();
      requestRender();
      dialog.close();
    }

    cancelBtn.addEventListener('click', dialog.close);
    applyBtn.addEventListener('click', apply);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
    });

    dialog.open();
    input.focus();
    input.select();
  }
