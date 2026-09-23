// Library dialog: "By Save" flat-list rendering — every snapshot is its own
// row, grouped under a per-style header.
// Source part for app.js. Run `npm run build` after editing.

  function renderLibraryList(container, entries, handlers) {
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.padding = '32px 16px';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '13px';
      empty.textContent = 'No projects saved yet. Use Save to archive the current board.';
      container.appendChild(empty);
      return;
    }
    const groups = groupLibraryEntriesByStyle(entries);
    groups.forEach(group => {
      const header = document.createElement('div');
      header.style.padding = '8px 12px';
      header.style.background = '#f1f1f4';
      header.style.borderTop = '1px solid #e6e6ea';
      header.style.borderBottom = '1px solid #e6e6ea';
      header.style.fontSize = '12px';
      header.style.fontWeight = '600';
      header.style.color = 'var(--text)';
      header.textContent = (group.styleId || '(no style code)')
        + '   ·   ' + group.entries.length + ' save' + (group.entries.length === 1 ? '' : 's');
      container.appendChild(header);
      group.entries.forEach(entry => {
        container.appendChild(buildLibraryRow(entry, handlers));
      });
    });
  }

  function buildLibraryRow(entry, handlers) {
    const row = document.createElement('div');
    row.className = 'library-row';
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    row.style.padding = '10px 12px';
    row.style.borderBottom = '1px solid #ececf0';
    row.style.background = '#fff';

    const thumb = document.createElement('div');
    thumb.style.width = '64px';
    thumb.style.height = '64px';
    thumb.style.flex = '0 0 64px';
    thumb.style.borderRadius = '6px';
    thumb.style.border = '1px solid #e0e0e6';
    thumb.style.background = '#f5f5f7 center/contain no-repeat';
    thumb.style.overflow = 'hidden';
    if (entry.thumbnailDataURL) {
      thumb.style.backgroundImage = 'url("' + entry.thumbnailDataURL.replace(/"/g, '%22') + '")';
    } else {
      thumb.style.display = 'flex';
      thumb.style.alignItems = 'center';
      thumb.style.justifyContent = 'center';
      thumb.style.color = '#9ca3af';
      thumb.style.fontSize = '11px';
      thumb.textContent = 'no image';
    }
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';

    const title = document.createElement('div');
    title.style.fontSize = '13px';
    title.style.fontWeight = '600';
    title.style.color = 'var(--text)';
    title.textContent = entry.styleId || '(no style code)';
    info.appendChild(title);

    const date = document.createElement('div');
    date.style.fontSize = '12px';
    date.style.color = 'var(--muted)';
    date.textContent = formatLibraryDate(entry.savedAt);
    info.appendChild(date);

    const counts = document.createElement('div');
    counts.style.fontSize = '11.5px';
    counts.style.color = 'var(--muted)';
    counts.style.marginTop = '2px';
    const parts = [];
    parts.push((entry.annotationCount || 0) + ' line' + (entry.annotationCount === 1 ? '' : 's'));
    parts.push((entry.imageCount || 0) + ' image' + (entry.imageCount === 1 ? '' : 's'));
    if (entry.confirmedPomCount) parts.push(entry.confirmedPomCount + ' confirmed POM' + (entry.confirmedPomCount === 1 ? '' : 's'));
    counts.textContent = parts.join('  ·  ');
    info.appendChild(counts);

    row.appendChild(info);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.flex = '0 0 auto';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'picker-btn primary';
    openBtn.textContent = 'Open';
    openBtn.style.fontSize = '12px';
    openBtn.style.padding = '5px 12px';
    openBtn.addEventListener('click', () => handlers.onOpen(entry));

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'picker-btn';
    downloadBtn.textContent = 'JSON';
    downloadBtn.title = 'Download this snapshot as a .json file';
    downloadBtn.style.fontSize = '12px';
    downloadBtn.style.padding = '5px 10px';
    downloadBtn.addEventListener('click', () => handlers.onDownload(entry));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'picker-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.fontSize = '12px';
    deleteBtn.style.padding = '5px 10px';
    deleteBtn.style.color = '#b91c1c';
    deleteBtn.addEventListener('click', () => handlers.onDelete(entry));

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);

    return row;
  }
