// Shared modal shell used by every dialog under src/ui/dialogs/.
// Source part for app.js. Run `npm run build` after editing.
//
// buildDialog gives each dialog a backdrop, header with a close button, and
// Esc / click-outside dismissal. Dialog-specific files (help, scale, etc.)
// assemble their bodies on top of the returned panel. escapeHtml is the
// shared safe-text helper used when dialogs build innerHTML strings.

  let dialogTitleSeq = 0;

  // Shared shell so dialogs look and behave the same: backdrop, header with
  // a close button, Esc / click-outside to dismiss. Returns the panel to fill.
  function buildDialog({ title, sub }) {
    const returnFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel dialog-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header dialog-header';
    const heading = document.createElement('h2');
    heading.id = 'dialog-title-' + (++dialogTitleSeq);
    heading.textContent = title;
    panel.setAttribute('aria-labelledby', heading.id);
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
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
        returnFocus.focus();
      }
    }
    function onKey(ev) {
      if (ev.key === 'Escape') {
        // Modal Escape belongs exclusively to the open dialog. Several page
        // controllers also listen for Escape on document (for example, BOM
        // uses it to return to Board). stopPropagation() alone still allows
        // later listeners on the same document node to run after close()
        // removes the overlay, so closing a palette could also change pages.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
        return;
      }
      if (ev.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), '
        + '[href], [tabindex]:not([tabindex="-1"])'
      )).filter(node => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
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
