// Help & shortcuts dialog (read-only quick reference).
// Source part for app.js. Run `npm run build` after editing.

  function openHelpDialog() {
    const dialog = buildDialog({
      title: 'Help & shortcuts',
      sub: 'Everything you need to annotate a sketch.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.innerHTML = `
      <div class="help-section">
        <h3>Getting started</h3>
        <ul class="help-list">
          <li class="help-item"><span>Add a photo with <b>Add Image</b>, drag one onto the board, or paste with <span class="kbd">Ctrl</span><span class="kbd">V</span> / <span class="kbd">⌘</span><span class="kbd">V</span>.</span></li>
          <li class="help-item"><span><b>Import PPTX</b> pulls sketches straight out of a PowerPoint deck.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Drawing tools</h3>
        <ul class="help-list">
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.4 3.1l13 6.1c.74.35.6 1.43-.2 1.59l-5 1-2 5c-.3.78-1.4.7-1.6-.1L4.2 4.4c-.2-.83.6-1.55 1.2-1.3z"/></svg>
            <span><b>Select</b> — click a line, label, or image to move or edit it.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="19" x2="19" y2="5"/></svg>
            <span><b>Straight line</b> — click the start point, then the end point.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 17C8 7 16 7 20 11"/></svg>
            <span><b>Curved line</b> — click start then end, then drag to bend it.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="14" x2="13" y2="14"/><line x1="13" y1="14" x2="20" y2="14" stroke-dasharray="2.2 2.2"/></svg>
            <span><b>Extension line</b> — after drawing a straight line, click once more in line with it to add a collinear dashed extension as a separate POM. Click off-axis to start a new line instead.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 18.5l-3-3a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8l-6.8 6.8z"/><line x1="8.5" y1="18.5" x2="20" y2="18.5"/></svg>
            <span><b>Eraser</b> — paint white over parts of the photo you don't want.</span>
          </li>
          <li class="help-item"><span><b>Stitches</b> — switch a line between plain, dashed, zigzag, cover, or bartack stitch styles. <b>Arrow</b> and <b>color</b> controls sit next to it.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Measurements</h3>
        <ul class="help-list">
          <li class="help-item"><span>Every line becomes a numbered <b>point of measure (POM)</b> in the side panel.</span></li>
          <li class="help-item"><span><b>Set Scale</b> — select a line whose real length you know, click Set Scale, type the length, and the panel estimates every other line for you.</span></li>
          <li class="help-item"><span><b>Hide Numbers</b> clears the callout numbers from the board; the panel still lists them.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Keyboard shortcuts</h3>
        <div class="help-row"><span>Open Command Palette</span><span class="help-keys"><span class="kbd">${escapeHtml(formatAppCommandShortcuts(getAppCommand('palette.open')))}</span></span></div>
        ${appCommandHelpRowsHtml()}
        <div class="help-row"><span>Nudge selected anchor pin 1 px (10 px with <span class="kbd">⇧</span>)</span><span class="help-keys"><span class="kbd">←</span><span class="kbd">↑</span><span class="kbd">↓</span><span class="kbd">→</span></span></div>
        <div class="help-row"><span>Drop anchor without snapping to ink</span><span class="help-keys">Hold <span class="kbd">⌥</span> on release</span></div>
        <div class="help-row"><span>Nudge selected line / active point 1 px (10 px with <span class="kbd">⇧</span>)</span><span class="help-keys"><span class="kbd">←</span><span class="kbd">↑</span><span class="kbd">↓</span><span class="kbd">→</span></span></div>
        <div class="help-row"><span>Pick the point the arrows move (line → start → mid → end → bend handles)</span><span class="help-keys"><span class="kbd">Tab</span></span></div>
        <div class="help-row"><span>Step a focused Size L / L2 / TOL field by ⅛ (whole unit with <span class="kbd">⇧</span>)</span><span class="help-keys"><span class="kbd">↑</span><span class="kbd">↓</span></span></div>
        <div class="help-row"><span>Pan the board</span><span class="help-keys">Hold <span class="kbd">Space</span> + drag</span></div>
        <div class="help-row"><span>Zoom</span><span class="help-keys">Mouse wheel / trackpad</span></div>
        <div class="help-row"><span>Eraser brush size</span><span class="help-keys"><span class="kbd">[</span> <span class="kbd">]</span></span></div>
        <div class="help-row"><span>Cancel / deselect</span><span class="help-keys"><span class="kbd">Esc</span></span></div>
      </div>`;
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'picker-btn primary';
    okBtn.textContent = 'Got it';
    okBtn.addEventListener('click', dialog.close);
    footer.appendChild(spacer);
    footer.appendChild(okBtn);
    dialog.panel.appendChild(footer);

    dialog.open();
    okBtn.focus();
  }
