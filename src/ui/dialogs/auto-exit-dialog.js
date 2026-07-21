// Auto Mode exit guard: Apply / Discard / Stay prompt for unapplied drafts.
// Source part for app.js. Run `npm run build` after editing.

  // Auto Mode exit guard. The TD has unapplied drafts
  // and is trying to leave Auto Mode (or open a project, which would
  // implicitly clear the draft layer). Offers Apply / Discard / Stay as real
  // buttons instead of a confusing free-text prompt. Resolves to one of
  // 'apply', 'discard', or 'stay'.
  function openAutoModeExitDialog({ approvedCount, totalCount, reason }) {
    const dialog = buildDialog({
      title: 'You have unapplied Auto Mode drafts',
      sub: totalCount + ' draft' + (totalCount === 1 ? '' : 's') +
        ' on the board · ' + approvedCount + ' approved.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    const lead = reason
      ? '<p>' + reason + '</p>'
      : '<p>Choose what to do before leaving Auto Mode:</p>';
    body.innerHTML = lead +
      '<ul style="margin:8px 0 0; padding-left:18px; color:var(--muted);">' +
        '<li><b>Apply Approved Lines</b> moves approved drafts into the project ' +
          'and switches to Manual Mode. Any remaining drafts stay in the Auto ' +
          'draft layer — toggle back to Auto to resolve them.</li>' +
        '<li><b>Discard Drafts</b> clears the draft layer without changing the project.</li>' +
        '<li><b>Stay</b> keeps everything as-is.</li>' +
      '</ul>';
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';

    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.className = 'picker-btn';
    stayBtn.textContent = 'Stay';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'picker-btn';
    discardBtn.textContent = 'Discard Drafts';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'picker-btn primary';
    applyBtn.textContent = 'Apply Approved Lines';
    applyBtn.disabled = approvedCount === 0;
    if (approvedCount === 0) applyBtn.title = 'No drafts are approved yet.';

    footer.appendChild(spacer);
    footer.appendChild(stayBtn);
    footer.appendChild(discardBtn);
    footer.appendChild(applyBtn);
    dialog.panel.appendChild(footer);

    return new Promise(resolve => {
      // buildDialog wires Esc / backdrop / X-button to its own close()
      // closure — we can't intercept those paths by overriding dialog.close.
      // Watch the overlay being detached instead so every dismissal route
      // funnels through one settle().
      let choice = 'stay';
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
      stayBtn.addEventListener('click', () => { choice = 'stay'; dialog.close(); });
      discardBtn.addEventListener('click', () => { choice = 'discard'; dialog.close(); });
      applyBtn.addEventListener('click', () => { choice = 'apply'; dialog.close(); });
      dialog.open();
      (approvedCount > 0 ? applyBtn : stayBtn).focus();
    });
  }
