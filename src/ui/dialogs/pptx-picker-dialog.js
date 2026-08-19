// PowerPoint (.pptx) import picker: a modal that previews every page found
// in a deck and lets the user choose which ones to add to the board.
// Source part for app.js. Run `npm run build` after editing.
//
// Split out of src/import/pptx.js. A self-contained thumbnail-grid dialog
// with no ZIP or OOXML knowledge — only needs page data
// ({slide, dataURLs}), addImagesFromDataURLs, and showToast.

  // Collapse per-image entries [{slide, dataURL}] into per-page groups
  // [{slide, dataURLs:[...]}], preserving slide order, so a slide that holds
  // multiple pictures is presented (and imported) as a single page.
  function groupEntriesBySlide(entries) {
    const order = [];
    const bySlide = new Map();
    for (const entry of entries) {
      let page = bySlide.get(entry.slide);
      if (!page) {
        page = { slide: entry.slide, dataURLs: [] };
        bySlide.set(entry.slide, page);
        order.push(page);
      }
      page.dataURLs.push(entry.dataURL);
    }
    return order;
  }

  // Modal that previews every page found in a deck and lets the user import
  // only the ones they want, instead of dumping all slides onto the board.
  function openPptxPicker(pages) {
    const selected = new Set();

    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header';
    const title = document.createElement('h2');
    title.textContent = 'Import pages';
    const sub = document.createElement('span');
    sub.className = 'picker-sub';
    sub.textContent = pages.length + ' pages found — pick the ones to add.';
    header.appendChild(title);
    header.appendChild(sub);
    panel.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    panel.appendChild(grid);

    pages.forEach((page, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'picker-cell';
      cell.setAttribute('aria-pressed', 'false');

      const thumb = document.createElement('img');
      thumb.className = 'picker-thumb';
      thumb.src = page.dataURLs[0];
      thumb.alt = 'Slide ' + page.slide;
      cell.appendChild(thumb);

      const cap = document.createElement('span');
      cap.className = 'picker-cap';
      cap.textContent = page.dataURLs.length > 1
        ? 'Slide ' + page.slide + ' · ' + page.dataURLs.length + ' images'
        : 'Slide ' + page.slide;
      cell.appendChild(cap);

      cell.addEventListener('click', () => {
        if (selected.has(index)) {
          selected.delete(index);
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
        updateFooter();
      });
      grid.appendChild(cell);
    });

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'picker-link';
    const count = document.createElement('span');
    count.className = 'picker-count';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'picker-btn primary';
    footer.appendChild(selectAllBtn);
    footer.appendChild(spacer);
    footer.appendChild(count);
    footer.appendChild(cancelBtn);
    footer.appendChild(importBtn);
    panel.appendChild(footer);

    function updateFooter() {
      const n = selected.size;
      count.textContent = n + ' selected';
      importBtn.disabled = n === 0;
      importBtn.textContent = n === 0 ? 'Import' : 'Import ' + n;
      selectAllBtn.textContent = n === pages.length ? 'Clear all' : 'Select all';
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    }

    selectAllBtn.addEventListener('click', () => {
      const all = selected.size === pages.length;
      selected.clear();
      Array.from(grid.children).forEach((cell, index) => {
        if (all) {
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
      });
      updateFooter();
    });

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    importBtn.addEventListener('click', async () => {
      if (!selected.size) return;
      const chosen = Array.from(selected)
        .sort((a, b) => a - b)
        .flatMap(i => pages[i].dataURLs);
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        await addImagesFromDataURLs(chosen);
        close();
      } catch (error) {
        console.error(error);
        showToast('Could not import the selected pages.', 4200);
        importBtn.disabled = false;
        updateFooter();
      }
    });

    updateFooter();
    document.body.appendChild(overlay);
  }
