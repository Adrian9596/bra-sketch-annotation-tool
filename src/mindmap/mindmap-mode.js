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

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'mindmap-exit-btn';
    exitBtn.innerHTML = '<svg class="mm-chev" width="9" height="14" viewBox="0 0 9 14" fill="none" '
      + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" '
      + 'aria-hidden="true"><path d="M7.5 1.5 2 7l5.5 5.5"/></svg>';
    exitBtn.appendChild(document.createTextNode('Exit Mind Map'));
    exitBtn.addEventListener('click', requestMindMapExit);

    const frame = document.createElement('iframe');
    frame.className = 'mindmap-overlay-frame';
    frame.title = 'Mind Map';
    frame.src = MINDMAP_SRC;
    frame.addEventListener('load', () => {
      syncMindMapSkin(overlay, frame);
      // Same origin, so focus can move INTO the map: the TD lands ready to
      // type instead of having to click the canvas first.
      try { frame.contentWindow.focus(); } catch (error) { /* not fatal */ }
    });

    overlay.appendChild(frame);
    overlay.appendChild(exitBtn);
    document.body.appendChild(overlay);

    const appRoot = document.querySelector('.app');
    if (appRoot) appRoot.inert = true;
  }

  // The embedded tool owns its own palette and resolves system/light/dark
  // itself, always writing the RESOLVED value to data-theme on its <html>.
  // Rather than guessing which appearance it landed in, copy the handful of
  // tokens this layer's chrome needs straight off it, and re-copy whenever it
  // switches. The iframe is same-origin (relative src, no sandbox attribute),
  // so this is a plain read; nothing is written back into the tool, and a
  // failure just leaves the CSS fallbacks in place.
  let mindMapSkinObserver = null;

  const MINDMAP_SKIN = [
    ['--bg', '--mm-bg'],
    ['--surface-raised', '--mm-surface'],
    ['--surface-solid', '--mm-surface-solid'],
    ['--border', '--mm-border'],
    ['--text', '--mm-text'],
    ['--shadow-2', '--mm-shadow'],
    ['--accent', '--mm-accent'],
    ['--dur-fast', '--dur-fast'],
  ];

  function syncMindMapSkin(overlay, frame) {
    let root;
    try {
      const doc = frame.contentDocument;
      root = doc && doc.documentElement;
    } catch (error) { return; }
    if (!root) return;
    const apply = () => {
      const styles = frame.contentWindow.getComputedStyle(root);
      for (const [from, to] of MINDMAP_SKIN) {
        const value = styles.getPropertyValue(from).trim();
        if (value) overlay.style.setProperty(to, value);
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    mindMapSkinObserver = observer;
  }


  function closeMindMap() {
    if (mindMapSkinObserver) { mindMapSkinObserver.disconnect(); mindMapSkinObserver = null; }
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
