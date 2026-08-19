// Library dialog: "By Style" card-grid rendering — one card per styleId,
// aggregated counts + evidence/meaning badges.
// Source part for app.js. Run `npm run build` after editing.

  function renderStyleGridView(container, entries, handlers) {
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.padding = '32px 16px';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '13px';
      empty.textContent = 'No styles yet. Save the current board to start building the library.';
      container.appendChild(empty);
      return;
    }
    const groups = groupLibraryEntriesByStyle(entries);
    groups.forEach(group => {
      container.appendChild(buildStyleCard(group, handlers));
    });
  }

  function styleMemoryBadges(styleId) {
    let evidenceCount = 0;
    let meaningCount = 0;
    if (styleId && typeof summarizeStyleEvidence === 'function') {
      try {
        const s = summarizeStyleEvidence(styleId);
        evidenceCount = (s && s.totalRecords) || 0;
      } catch (err) { /* memory store may be uninitialized in test contexts */ }
    }
    if (styleId && typeof listConfirmedMeanings === 'function') {
      try {
        meaningCount = (listConfirmedMeanings(styleId) || []).length;
      } catch (err) { /* same as above */ }
    }
    return { evidenceCount, meaningCount };
  }

  function buildStyleCard(group, handlers) {
    const styleId = group.styleId;
    const latest = group.entries[0] || null;
    const saveCount = group.entries.length;
    const totalLines = group.entries.reduce((sum, e) => sum + (e.annotationCount || 0), 0);
    const totalImages = group.entries.reduce((sum, e) => sum + (e.imageCount || 0), 0);
    const totalConfirmedPoms = group.entries.reduce((sum, e) => sum + (e.confirmedPomCount || 0), 0);
    const { evidenceCount, meaningCount } = styleMemoryBadges(styleId);

    const row = document.createElement('div');
    row.className = 'library-style-card';
    row.style.display = 'flex';
    row.style.gap = '14px';
    row.style.alignItems = 'stretch';
    row.style.padding = '12px 14px';
    row.style.borderBottom = '1px solid #ececf0';
    row.style.background = '#fff';

    const thumb = document.createElement('div');
    thumb.style.width = '88px';
    thumb.style.height = '88px';
    thumb.style.flex = '0 0 88px';
    thumb.style.borderRadius = '8px';
    thumb.style.border = '1px solid #e0e0e6';
    thumb.style.background = '#f5f5f7 center/contain no-repeat';
    thumb.style.overflow = 'hidden';
    const cover = latest && latest.thumbnailDataURL;
    if (cover) {
      thumb.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
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
    info.style.display = 'flex';
    info.style.flexDirection = 'column';
    info.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.style.fontSize = '14px';
    title.style.fontWeight = '600';
    title.style.color = 'var(--text)';
    title.textContent = styleId || '(no style code)';
    info.appendChild(title);

    const lastSeen = document.createElement('div');
    lastSeen.style.fontSize = '12px';
    lastSeen.style.color = 'var(--muted)';
    lastSeen.textContent = 'Last saved: ' + formatLibraryDate(latest && latest.savedAt);
    info.appendChild(lastSeen);

    const counts = document.createElement('div');
    counts.style.fontSize = '11.5px';
    counts.style.color = 'var(--muted)';
    const countParts = [
      saveCount + ' save' + (saveCount === 1 ? '' : 's'),
      totalLines + ' line' + (totalLines === 1 ? '' : 's'),
      totalImages + ' image' + (totalImages === 1 ? '' : 's'),
    ];
    if (totalConfirmedPoms) countParts.push(totalConfirmedPoms + ' confirmed POM' + (totalConfirmedPoms === 1 ? '' : 's'));
    counts.textContent = countParts.join('  ·  ');
    info.appendChild(counts);

    if (styleId && (evidenceCount > 0 || meaningCount > 0)) {
      const badges = document.createElement('div');
      badges.style.display = 'flex';
      badges.style.gap = '6px';
      badges.style.marginTop = '4px';
      badges.style.flexWrap = 'wrap';
      if (meaningCount > 0) badges.appendChild(buildBadge(meaningCount + ' meaning' + (meaningCount === 1 ? '' : 's'), '#dbeafe', '#1e40af'));
      if (evidenceCount > 0) badges.appendChild(buildBadge(evidenceCount + ' evidence', '#dcfce7', '#166534'));
      info.appendChild(badges);
    }
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexDirection = 'column';
    actions.style.gap = '6px';
    actions.style.justifyContent = 'center';
    actions.style.flex = '0 0 auto';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'picker-btn primary';
    openBtn.textContent = 'Open latest';
    openBtn.style.fontSize = '12px';
    openBtn.style.padding = '5px 12px';
    openBtn.disabled = !latest;
    openBtn.addEventListener('click', () => {
      if (latest) handlers.onOpen(latest);
    });

    const viewSavesBtn = document.createElement('button');
    viewSavesBtn.type = 'button';
    viewSavesBtn.className = 'picker-btn';
    viewSavesBtn.textContent = saveCount > 1 ? 'View ' + saveCount + ' saves' : 'View saves';
    viewSavesBtn.style.fontSize = '12px';
    viewSavesBtn.style.padding = '5px 10px';
    viewSavesBtn.addEventListener('click', () => handlers.onViewSaves(styleId));

    actions.appendChild(openBtn);
    actions.appendChild(viewSavesBtn);
    row.appendChild(actions);

    return row;
  }
