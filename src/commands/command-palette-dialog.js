// Searchable, keyboard-first Command Palette (US-094). Source part for app.js.
// Run `npm run build` after editing.

  function openCommandPalette() {
    if (document.querySelector('.command-palette-overlay')) return;

    const dialog = buildDialog({
      title: 'Command Palette',
      sub: 'Every stable action, scoped to the page and selection you are using.',
    });
    dialog.overlay.classList.add('command-palette-overlay');
    dialog.panel.classList.add('command-palette-panel');

    const searchWrap = document.createElement('div');
    searchWrap.className = 'command-palette-search-wrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'command-palette-search';
    search.placeholder = 'Type a command…';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('aria-label', 'Search commands');
    searchWrap.appendChild(search);
    dialog.panel.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'command-palette-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Commands');
    dialog.panel.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'command-palette-footer';
    footer.innerHTML = '<span><span class="kbd">↑</span><span class="kbd">↓</span> navigate</span>'
      + '<span><span class="kbd">Enter</span> run</span>'
      + '<span><span class="kbd">Esc</span> close</span>';
    dialog.panel.appendChild(footer);

    let rows = [];
    let activeIndex = 0;

    function paletteSearchText(command) {
      return [command.label, command.category, command.keywords, command.id]
        .join(' ').toLowerCase();
    }

    function paletteCommands() {
      const query = search.value.trim().toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      return getAppCommands()
        .filter(command => command.palette !== false)
        .filter(command => tokens.every(token => paletteSearchText(command).includes(token)))
        .map(command => ({ command, availability: getAppCommandAvailability(command) }))
        .sort((a, b) => {
          const aPage = a.command.page === state.activePage ? 0 : (a.command.page ? 2 : 1);
          const bPage = b.command.page === state.activePage ? 0 : (b.command.page ? 2 : 1);
          if (aPage !== bPage) return aPage - bPage;
          if (a.availability.enabled !== b.availability.enabled) return a.availability.enabled ? -1 : 1;
          return a.command.category.localeCompare(b.command.category) || a.command.label.localeCompare(b.command.label);
        });
    }

    function activePaletteRow() {
      return rows[activeIndex] || null;
    }

    function syncPaletteActive() {
      const buttons = Array.from(list.querySelectorAll('[data-command-id]'));
      buttons.forEach((button, index) => {
        const active = index === activeIndex;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        if (active) {
          search.setAttribute('aria-activedescendant', button.id);
          button.scrollIntoView({ block: 'nearest' });
        }
      });
      if (!buttons.length) search.removeAttribute('aria-activedescendant');
    }

    function renderPalette() {
      rows = paletteCommands();
      activeIndex = Math.max(0, Math.min(activeIndex, rows.length - 1));
      if (!rows.length) {
        list.innerHTML = '<div class="command-palette-empty">No commands match this search.</div>';
        search.removeAttribute('aria-activedescendant');
        return;
      }
      list.innerHTML = rows.map((row, index) => {
        const command = row.command;
        const shortcut = formatAppCommandShortcuts(command);
        return '<button type="button" id="command-palette-row-' + index + '" data-command-id="'
          + escapeHtml(command.id) + '" role="option" tabindex="-1" aria-disabled="'
          + String(!row.availability.enabled) + '" class="command-palette-row'
          + (row.availability.enabled ? '' : ' disabled') + '">'
          + '<span class="command-palette-copy"><span class="command-palette-label">'
          + escapeHtml(command.label) + '</span><span class="command-palette-meta">'
          + escapeHtml(command.category)
          + (row.availability.enabled ? '' : ' · ' + row.availability.reason) + '</span></span>'
          + (shortcut ? '<span class="command-palette-shortcut">' + escapeHtml(shortcut) + '</span>' : '')
          + '</button>';
      }).join('');
      syncPaletteActive();
    }

    function executePaletteRow(row) {
      if (!row) return;
      if (!row.availability.enabled) {
        showToast(row.availability.reason);
        return;
      }
      const id = row.command.id;
      dialog.close();
      runAppCommand(id);
    }

    search.addEventListener('input', () => {
      activeIndex = 0;
      renderPalette();
    });
    search.addEventListener('keydown', event => {
      if (!rows.length) return;
      if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % rows.length;
      else if (event.key === 'ArrowUp') activeIndex = (activeIndex - 1 + rows.length) % rows.length;
      else if (event.key === 'Home') activeIndex = 0;
      else if (event.key === 'End') activeIndex = rows.length - 1;
      else if (event.key === 'Enter') {
        event.preventDefault();
        executePaletteRow(activePaletteRow());
        return;
      } else return;
      event.preventDefault();
      syncPaletteActive();
    });
    list.addEventListener('mousemove', event => {
      const button = event.target.closest('[data-command-id]');
      if (!button) return;
      const index = Array.from(list.querySelectorAll('[data-command-id]')).indexOf(button);
      if (index >= 0 && index !== activeIndex) {
        activeIndex = index;
        syncPaletteActive();
      }
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-command-id]');
      if (!button) return;
      executePaletteRow(rows.find(row => row.command.id === button.dataset.commandId));
    });

    dialog.open();
    renderPalette();
    search.focus();
  }
