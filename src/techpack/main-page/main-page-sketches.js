// MAIN PAGE sheet — version sketches (US-080, ADR 0047).
// Source part for app.js. Run `npm run build` after editing.
//
// The two fixed slots per version: the byte store that lives outside
// state.mainPage, the save/open round trip for those bytes, the upload/paste
// slot menu, and mpSketchRowHtml — the one markup builder shared with the
// Preview & Export sheet. The slot roster itself (MP_SKETCH_VARIANTS /
// MP_SKETCH_SLOTS) is in main-page-data.js; state.mainPage.sketches is seeded
// by ensureMainPage() in main-page.js, which also wires the slot clicks.

  /* Bytes deliberately live outside state.mainPage, like BOM board images:
     history clones state.mainPage on every field edit, and four
     full-resolution flats cloned 120 deep is a different order of memory.
     Every import mints a NEW id and nothing is ever evicted, so undo across a
     replaced slot still finds the previous image's bytes here. */
  const mpSketchDataById = new Map();
  let mpSketchSeq = 0;

  /* ---- Version sketches -------------------------------------------------- */

  function mpSketchVariant(variant) {
    return String(variant || '').toLowerCase() === 'lace' ? 'lace' : 'solid';
  }

  function mpSketchSlot(variant, i) {
    const mp = state.mainPage;
    if (!mp || !mp.sketches) return null;
    const slots = mp.sketches[mpSketchVariant(variant)] || [];
    return slots[i] || null;
  }

  function mpSketchDataURL(variant, i) {
    const slot = mpSketchSlot(variant, i);
    return (slot && mpSketchDataById.get(slot.id)) || '';
  }

  // Injects the bytes back for save; the runtime state stays byte-free.
  function mpSerializeForProject() {
    const out = state.mainPage ? clone(state.mainPage) : null;
    if (!out || !out.sketches) return out;
    MP_SKETCH_VARIANTS.forEach(v => {
      out.sketches[v] = (out.sketches[v] || []).map(slot => (slot && slot.id
        ? { ...slot, dataURL: mpSketchDataById.get(slot.id) || null }
        : null));
    });
    return out;
  }

  // The mirror of the above, on open: bytes into the map, state left clean.
  function mpLoadProjectState(rawMainPage) {
    state.mainPage = rawMainPage && typeof rawMainPage === 'object' ? clone(rawMainPage) : null;
    mpSketchDataById.clear();
    const raw = (rawMainPage && rawMainPage.sketches) || {};
    MP_SKETCH_VARIANTS.forEach(v => {
      (raw[v] || []).forEach(slot => {
        if (slot && slot.id && slot.dataURL) mpSketchDataById.set(String(slot.id), slot.dataURL);
      });
    });
    return ensureMainPage();   // drops the injected dataURLs from state again
  }

  async function mpSetSketch(variant, i, dataURL) {
    const mp = ensureMainPage();
    const key = mpSketchVariant(variant);
    if (!dataURL) {
      mp.sketches[key][i] = null;
    } else {
      /* aspect is measured once here, not at render time: the preview sheet
         and the workbook both need it before an <img> exists. */
      let aspect = 1;
      try {
        const img = await loadImageFromDataURL(dataURL);
        aspect = Math.max(0.01, (img.naturalWidth || 1) / (img.naturalHeight || 1));
      } catch (err) { /* unreadable image still gets a slot, at 1:1 */ }
      const id = 'mp-sk-' + key + '-' + i + '-' + (++mpSketchSeq);
      mpSketchDataById.set(id, dataURL);
      mp.sketches[key][i] = { id, aspect };
    }
    mpCloseSketchMenu();
    mpRenderSketches();
    // The Preview & Export sheet shows the same slots; repaint it if that is
    // the page in view (same rule restoreSnapshot follows).
    if (state.activePage === 'preview' && typeof renderPreviewPage === 'function') renderPreviewPage();
    pushHistoryIfChanged();
  }

  /* One builder for the page and the Preview & Export sheet, so the two can
     never disagree about what a version panel shows (ADR 0046 rule 5).
     `editable` adds the screen-only clear button and the empty-slot prompt. */
  function mpSketchRowHtml(variant, editable) {
    const key = mpSketchVariant(variant);
    return MP_SKETCH_SLOTS.map((slot, i) => {
      const dataURL = mpSketchDataURL(key, i);
      const ref = key + ':' + i;
      const body = dataURL
        ? '<img class="mp-sk-img" src="' + escapeHtml(dataURL) + '" alt="' + slot.label + ' sketch">'
        : '<span class="mp-sk-empty">' + (editable ? '＋ ' : '') + slot.label + '</span>';
      return '<div class="mp-sketch' + (dataURL ? ' mp-sk-filled' : '') + '"'
        + (editable ? ' data-mp-sk="' + ref + '" role="button" tabindex="0" title="Upload or paste the '
          + slot.label.toLowerCase() + ' technical flat"' : '')
        + '>' + body
        + '<span class="mp-sk-tag">' + slot.label + '</span>'
        + (editable && dataURL
          ? '<button type="button" class="mp-sk-x mp-screen-only" data-mp-sk-clear="' + ref
            + '" title="Remove this sketch">×</button>'
          : '')
        + '</div>';
    }).join('');
  }

  function mpRenderSketches() {
    Array.from(document.querySelectorAll('#mainPageOverlay .mp-sketchrow')).forEach(row => {
      row.innerHTML = mpSketchRowHtml(row.dataset.mpVariant, true);
    });
  }

  /* ---- Sketch slot menu (forked from the BOM material-photo trigger) ------
     Upload or paste only: offline, no catalog, no auto-adoption. */

  let mpSketchOpen = null;   // 'lace:0' while a slot menu is open

  function mpSketchMenuEl() {
    let menu = document.getElementById('mpSketchMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'mpSketchMenu';
    menu.className = 'mp-menu mp-sketch-menu';
    menu.hidden = true;
    menu.innerHTML = '<div class="mp-sk-hint">Technical flat for this version — prints on the MAIN PAGE sheet.</div>'
      + '<div class="mp-sk-actions">'
      + '<button type="button" data-mp-sk-upload title="Or Cmd/Ctrl+V to paste a copied image">Upload&hellip; / Paste</button>'
      + '<button type="button" data-mp-sk-remove>Remove</button></div>';
    document.body.appendChild(menu);
    const filePick = document.createElement('input');
    filePick.type = 'file';
    filePick.accept = 'image/*';
    filePick.hidden = true;
    menu.appendChild(filePick);
    const applyFile = (f, ref) => {
      if (!f || !ref || !/^image\//i.test(f.type)) return;
      const [variant, i] = ref.split(':');
      const rd = new FileReader();
      rd.onload = () => mpSetSketch(variant, +i, rd.result);
      rd.readAsDataURL(f);
    };
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      const ref = mpSketchOpen;
      filePick.value = '';
      applyFile(f, ref);
    });
    menu.addEventListener('click', e => {
      if (!mpSketchOpen) return;
      if (e.target.closest('[data-mp-sk-upload]')) { filePick.click(); return; }
      if (e.target.closest('[data-mp-sk-remove]')) {
        const [variant, i] = mpSketchOpen.split(':');
        mpSetSketch(variant, +i, null);
      }
    });
    /* stopPropagation keeps the app's document-level paste router from also
       adopting the image as a Board sketch. */
    menu.addEventListener('paste', e => {
      if (!mpSketchOpen || !e.clipboardData) return;
      const it = Array.from(e.clipboardData.items)
        .find(x => x.kind === 'file' && /^image\//i.test(x.type));
      if (!it) return;
      const f = it.getAsFile();
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      applyFile(f, mpSketchOpen);
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { mpCloseSketchMenu(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
    });
    return menu;
  }

  function mpOpenSketchMenu(ref, box) {
    mpCloseFldMenu();
    if (mpColorWrap) mpColorWrap.classList.remove('open');
    mpSketchOpen = ref;
    const menu = mpSketchMenuEl();
    menu.hidden = false;
    menu.tabIndex = -1;   // focusable, so the paste event targets the menu
    const r = box.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 110) + 'px';
    menu.focus();
  }

  function mpCloseSketchMenu() {
    const menu = document.getElementById('mpSketchMenu');
    if (menu) menu.hidden = true;
    mpSketchOpen = null;
  }
