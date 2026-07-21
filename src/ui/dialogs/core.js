// Shared modal shell used by every dialog under src/ui/dialogs/.
// Source part for app.js. Run `npm run build` after editing.
//
// buildDialog gives each dialog a backdrop, header with a close button, and
// Esc / click-outside dismissal. Dialog-specific files (help, scale, etc.)
// assemble their bodies on top of the returned panel. escapeHtml is the
// shared safe-text helper used when dialogs build innerHTML strings.

  // Shared shell so dialogs look and behave the same: backdrop, header with
  // a close button, Esc / click-outside to dismiss. Returns the panel to fill.
  function buildDialog({ title, sub }) {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel dialog-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header dialog-header';
    const heading = document.createElement('h2');
    heading.textContent = title;
    header.appendChild(heading);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'picker-sub';
      subEl.textContent = sub;
      header.appendChild(subEl);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);
    panel.appendChild(header);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    return {
      overlay,
      panel,
      close,
      open() { document.body.appendChild(overlay); },
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
