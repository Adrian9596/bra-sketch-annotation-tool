// Mind Map: a fully separate, self-contained tool (vendor/mindmap.html,
// embedded byte-for-byte in an <iframe>) reachable from a single
// Manual-only toolbar button (#mindMapBtn, index.html). It shares no code
// and no state with the measurement board — its own document, its own
// localStorage namespace (`atlas.mindmap.*`) — and takes over the whole
// viewport while open. The rest of the app is marked `inert` for the
// duration so nothing behind the overlay is clickable or keyboard-reachable;
// the only way out is the overlay's own Exit button, which always confirms
// first via openMindMapExitDialog — the same "confirm before leaving" shape
// as openAutoModeExitDialog (auto-exit-dialog.js), reused via the shared
// buildDialog shell (dialogs/core.js).
// Source part for app.js. Run `npm run build` after editing.

  const MINDMAP_SRC = 'vendor/mindmap.html';

  function openMindMap() {
    if (document.getElementById('mindMapOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mindMapOverlay';
    overlay.className = 'mindmap-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Mind Map');

    const bar = document.createElement('div');
    bar.className = 'mindmap-overlay-bar';
    const title = document.createElement('strong');
    title.textContent = 'Mind Map';
    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'mindmap-exit-btn';
    exitBtn.textContent = 'Exit Mind Map';
    exitBtn.addEventListener('click', requestMindMapExit);
    bar.appendChild(title);
    bar.appendChild(exitBtn);

    const frame = document.createElement('iframe');
    frame.className = 'mindmap-overlay-frame';
    frame.title = 'Mind Map';
    frame.src = MINDMAP_SRC;

    overlay.appendChild(bar);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    const appRoot = document.querySelector('.app');
    if (appRoot) appRoot.inert = true;
  }

  function closeMindMap() {
    const overlay = document.getElementById('mindMapOverlay');
    if (overlay) overlay.remove();
    const appRoot = document.querySelector('.app');
    if (appRoot) appRoot.inert = false;
  }

  function requestMindMapExit() {
    openMindMapExitDialog().then(shouldExit => {
      if (shouldExit) closeMindMap();
    });
  }

  // Stay/Exit prompt shown before leaving Mind Map. Mirrors
  // openAutoModeExitDialog's settle-once-on-any-dismissal shape (Esc,
  // backdrop click, or the dialog's own X all resolve the same as Stay) so
  // every dismissal route funnels through one place and none of them can
  // leave Mind Map without the TD explicitly choosing Exit.
  function openMindMapExitDialog() {
    const dialog = buildDialog({
      title: 'Exit Mind Map?',
      sub: 'It saves on its own — nothing is lost either way.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.innerHTML = '<p>Returning to the measurement board closes this tool. ' +
      'It is not part of the bra project and is unaffected by anything you do ' +
      'on the board.</p>';
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';

    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.className = 'picker-btn';
    stayBtn.textContent = 'Stay';

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'picker-btn primary';
    exitBtn.textContent = 'Exit Mind Map';

    footer.appendChild(spacer);
    footer.appendChild(stayBtn);
    footer.appendChild(exitBtn);
    dialog.panel.appendChild(footer);

    return new Promise(resolve => {
      let choice = false;
      let settled = false;
      const observer = new MutationObserver(() => {
        if (!document.body.contains(dialog.overlay)) {
          observer.disconnect();
          if (settled) return;
          settled = true;
          resolve(choice);
        }
      });
      observer.observe(document.body, { childList: true });
      stayBtn.addEventListener('click', () => { choice = false; dialog.close(); });
      exitBtn.addEventListener('click', () => { choice = true; dialog.close(); });
      dialog.open();
      stayBtn.focus();
    });
  }
