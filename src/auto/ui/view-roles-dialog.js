// View-role confirmation dialog: replaces the old window.prompt letter-code
// flow (F/B/I/U) after Detect Sketch when the classifier is unsure.
// Source part for app.js. Run `npm run build` after editing.
//
// openViewRolesDialog({ views, sourceImage }) resolves with an array of role
// strings (one per view, in the same order) when the TD confirms, or null
// when they dismiss (Esc / click-outside / "Keep as detected") — null means
// "leave the detection untouched", matching the old cancelled-prompt path.

  const VIEW_ROLE_CHOICES = [
    { role: 'front_outer', label: 'Front Outer' },
    { role: 'back', label: 'Back' },
    { role: 'front_inner', label: 'Front Inner' },
    { role: 'unknown', label: 'Unknown' },
  ];

  function viewRoleDisplayName(role) {
    const hit = VIEW_ROLE_CHOICES.find(c => c.role === role
      || (role === 'front' && c.role === 'front_outer'));
    return hit ? hit.label : 'Unknown';
  }

  // Crop one detected view box out of the source sketch into a small canvas
  // thumbnail. Returns null when anything is missing (e.g. Node tests) so the
  // dialog degrades to text-only rows.
  function buildViewThumbnail(sourceImage, view, size) {
    try {
      const img = sourceImage && sourceImage.img;
      if (!img || typeof document === 'undefined') return null;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (!iw || !ih) return null;
      const sx = Math.max(0, Math.floor((view.x || 0) * iw));
      const sy = Math.max(0, Math.floor((view.y || 0) * ih));
      const sw = Math.max(1, Math.floor((view.width || 0) * iw));
      const sh = Math.max(1, Math.floor((view.height || 0) * ih));
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#f5f5f7';
      ctx.fillRect(0, 0, size, size);
      const scale = Math.min(size / sw, size / sh);
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      ctx.drawImage(img, sx, sy, sw, sh,
        Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
      return canvas;
    } catch (err) {
      return null;
    }
  }

  function openViewRolesDialog({ views, sourceImage }) {
    return new Promise((resolve) => {
      const dialog = buildDialog({
        title: 'Confirm view roles',
        sub: 'Tell Auto Mode which detected view is which before it places anchors.',
      });

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialog.close();
        resolve(value);
      };
      // buildDialog's own close paths (Esc, ×, click-outside) bypass finish(),
      // so watch the overlay leaving the DOM and treat it as "keep detected".
      const observer = new MutationObserver(() => {
        if (!document.body.contains(dialog.overlay)) {
          observer.disconnect();
          if (!settled) { settled = true; resolve(null); }
        }
      });

      const body = document.createElement('div');
      body.className = 'dialog-body';

      const intro = document.createElement('p');
      intro.style.margin = '0 0 12px';
      intro.style.fontSize = '12.5px';
      intro.style.color = 'var(--muted)';
      intro.textContent = 'Detection was not sure about these views. Wrong roles put POM lines on the wrong sketch — fix any that look off.';
      body.appendChild(intro);

      const chosen = views.map(v => {
        const role = v.viewRole || v.role || 'unknown';
        return role === 'front' ? 'front_outer' : role;
      });

      views.forEach((view, index) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '12px';
        row.style.alignItems = 'center';
        row.style.padding = '10px 0';
        if (index > 0) row.style.borderTop = '1px solid #ececf0';

        const thumb = buildViewThumbnail(sourceImage, view, 72);
        if (thumb) {
          thumb.style.flex = '0 0 72px';
          thumb.style.borderRadius = '8px';
          thumb.style.border = '1px solid #e0e0e6';
          row.appendChild(thumb);
        }

        const info = document.createElement('div');
        info.style.flex = '0 0 auto';
        info.style.minWidth = '86px';
        const name = document.createElement('div');
        name.style.fontSize = '13px';
        name.style.fontWeight = '600';
        name.textContent = 'View ' + (index + 1);
        info.appendChild(name);
        const detected = document.createElement('div');
        detected.style.fontSize = '11.5px';
        detected.style.color = 'var(--muted)';
        const confidence = view.roleConfidence != null
          ? ' · ' + Math.round(view.roleConfidence * 100) + '%'
          : '';
        detected.textContent = 'Detected: ' + viewRoleDisplayName(chosen[index]) + confidence;
        info.appendChild(detected);
        row.appendChild(info);

        const group = document.createElement('div');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', 'Role for view ' + (index + 1));
        group.style.display = 'flex';
        group.style.gap = '4px';
        group.style.flexWrap = 'wrap';
        group.style.marginLeft = 'auto';

        const buttons = VIEW_ROLE_CHOICES.map(choice => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = choice.label;
          btn.setAttribute('role', 'radio');
          btn.style.padding = '5px 10px';
          btn.style.fontSize = '12px';
          btn.style.borderRadius = '999px';
          btn.style.border = '1px solid #d4d4d8';
          btn.style.cursor = 'pointer';
          btn.addEventListener('click', () => {
            chosen[index] = choice.role;
            paint();
          });
          group.appendChild(btn);
          return { btn, role: choice.role };
        });

        function paint() {
          buttons.forEach(({ btn, role }) => {
            const on = chosen[index] === role;
            btn.style.background = on ? '#1f2937' : '#fff';
            btn.style.color = on ? '#fff' : 'var(--text)';
            btn.style.borderColor = on ? '#1f2937' : '#d4d4d8';
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
          });
        }
        paint();

        row.appendChild(group);
        body.appendChild(row);
      });

      dialog.panel.appendChild(body);

      const footer = document.createElement('div');
      footer.className = 'picker-footer';
      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      const keepBtn = document.createElement('button');
      keepBtn.type = 'button';
      keepBtn.className = 'picker-btn';
      keepBtn.textContent = 'Keep as detected';
      keepBtn.addEventListener('click', () => finish(null));
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'picker-btn primary';
      confirmBtn.textContent = 'Confirm roles';
      confirmBtn.addEventListener('click', () => finish(chosen.slice()));
      footer.appendChild(spacer);
      footer.appendChild(keepBtn);
      footer.appendChild(confirmBtn);
      dialog.panel.appendChild(footer);

      dialog.open();
      observer.observe(document.body, { childList: true });
      confirmBtn.focus();
    });
  }
