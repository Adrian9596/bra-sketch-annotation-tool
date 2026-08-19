// Autosave restore banner: the hand-rolled floating UI that offers to
// restore a recovered autosave record after a crash or accidental reload.
// Source part for app.js. Run `npm run build` after editing.
//
// Split out of src/project/autosave.js: this is presentation only (DOM
// construction for the banner and its Restore/Discard buttons). The
// persistence engine it reads from (readAutosave/clearAutosave/
// suspendAutosave/resumeAutosave/hasUnsavedWork) stays in autosave.js.

  function describeAutosaveRecord(record) {
    if (!record || !record.snapshot || !record.snapshot.state) return '';
    const s = record.snapshot.state;
    const anns = Array.isArray(s.annotations) ? s.annotations.length : 0;
    const imgs = Array.isArray(s.images) ? s.images.length : 0;
    const bomImgs = s.bom && s.bom.images
      ? (s.bom.images.solid || []).length + (s.bom.images.lace || []).length
      : 0;
    const constructionImgs = s.construction && s.construction.images
      ? ['solid', 'lace'].reduce((sum, sheet) => sum + ['outer', 'inner'].reduce((viewSum, view) =>
        viewSum + (((s.construction.images[sheet] || {})[view] || []).length), 0), 0)
      : 0;
    const ageMs = Number.isFinite(record.savedAt) ? Date.now() - record.savedAt : null;
    let when = '';
    if (ageMs != null) {
      if (ageMs < 60_000) when = 'a moment ago';
      else if (ageMs < 60 * 60_000) when = Math.round(ageMs / 60_000) + ' min ago';
      else if (ageMs < 24 * 60 * 60_000) when = Math.round(ageMs / (60 * 60_000)) + ' hr ago';
      else when = Math.round(ageMs / (24 * 60 * 60_000)) + ' day(s) ago';
    }
    const parts = [];
    if (anns) parts.push(anns + ' line' + (anns === 1 ? '' : 's'));
    if (imgs) parts.push(imgs + ' image' + (imgs === 1 ? '' : 's'));
    if (bomImgs) parts.push(bomImgs + ' BOM image' + (bomImgs === 1 ? '' : 's'));
    if (constructionImgs) parts.push(constructionImgs + ' Construction image' + (constructionImgs === 1 ? '' : 's'));
    if (record.imagesStripped) parts.push('image bitmap dropped to fit storage');
    return (parts.join(', ') || 'work in progress') + (when ? ' • saved ' + when : '');
  }

  // Non-blocking restore prompt: appears as a floating banner over the
  // board. Kept independent of the toast queue so it can stick around
  // until the TD makes a choice (autosave restore is not a transient
  // notification — losing it silently would defeat the point).
  function maybeOfferAutosaveRestore() {
    if (typeof document === 'undefined') return;
    if (hasUnsavedWork()) return; // The URL / demo loader already put work on the board — do not clobber.
    const record = readAutosave();
    if (!record) return;
    const s = record.snapshot && record.snapshot.state;
    const hasContent = s && ((Array.isArray(s.annotations) && s.annotations.length)
      || (Array.isArray(s.images) && s.images.length)
      || (s.construction && ((s.construction.callouts || []).length
        || (s.construction.images && ['solid', 'lace'].some(sheet => ['outer', 'inner'].some(view =>
          ((((s.construction.images[sheet] || {})[view]) || []).length))))
        || (typeof hasMeaningfulConstructionWork === 'function' && s.construction)))
      || (s.bom && ((s.bom.callouts || []).length
        || (s.bom.images && ((s.bom.images.solid || []).length || (s.bom.images.lace || []).length))
        || (typeof hasMeaningfulBomWork === 'function' && s.bom))));
    if (!hasContent) { clearAutosave(); return; }
    showAutosaveRestoreBanner(record);
  }

  function showAutosaveRestoreBanner(record) {
    const banner = document.createElement('div');
    banner.id = 'autosaveRestoreBanner';
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
      'z-index:10000', 'background:#0f172a', 'color:#f8fafc',
      'padding:12px 16px', 'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,.28)',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'max-width:520px', 'font:13px/1.4 system-ui,sans-serif',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:13.5px';
    title.textContent = 'Recovered work available';
    banner.appendChild(title);

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:12px;color:#cbd5f5';
    detail.textContent = 'We autosaved your last session before it closed — ' + describeAutosaveRecord(record) + '.';
    banner.appendChild(detail);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:2px';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.textContent = 'Restore';
    restoreBtn.style.cssText = 'padding:6px 12px;background:#38bdf8;color:#0f172a;border:none;border-radius:6px;font-weight:700;cursor:pointer';
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring…';
      try {
        suspendAutosave();
        await loadProject(record.snapshot);
        showToast(record.imagesStripped || record.bomImagesStripped
          ? 'Restored project geometry. Some image bitmaps did not fit storage — please re-add them.'
          : 'Restored your previous session.');
        clearAutosave();
      } catch (err) {
        console.error('[autosave] restore failed:', err);
        showToast('Could not restore the autosaved session.', 4200);
      } finally {
        resumeAutosave();
        banner.remove();
      }
    });
    btnRow.appendChild(restoreBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.textContent = 'Discard';
    discardBtn.style.cssText = 'padding:6px 12px;background:transparent;color:#f8fafc;border:1px solid #475569;border-radius:6px;cursor:pointer';
    discardBtn.addEventListener('click', () => {
      clearAutosave();
      banner.remove();
    });
    btnRow.appendChild(discardBtn);

    banner.appendChild(btnRow);
    document.body.appendChild(banner);
  }
