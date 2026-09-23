// Transparent Learning panel: generic reusable tab-shell widget — not
// learning-specific at all, it just takes {id,label,count,build} defs.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Tab shell ------------------------------------------------------
  // Tabs are built lazily — each panel's content is constructed once on
  // first activation so revisiting a tab doesn't lose the expanded-row
  // state from the previous visit.
  function buildLearningTabs(defs) {
    const wrap = document.createElement('div');
    wrap.className = 'ld-tab-shell';

    const bar = document.createElement('div');
    bar.className = 'ld-tabs';
    bar.setAttribute('role', 'tablist');

    const panels = document.createElement('div');
    panels.className = 'ld-tab-panels';

    const built = new Map();
    const buttons = [];
    const panelEls = [];

    defs.forEach((def, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ld-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'ld-tab-panel-' + def.id);
      btn.id = 'ld-tab-' + def.id;
      btn.dataset.tab = def.id;

      const labelEl = document.createElement('span');
      labelEl.textContent = def.label;
      btn.appendChild(labelEl);
      if (Number.isFinite(def.count)) {
        const badge = document.createElement('span');
        badge.className = 'ld-tab-badge';
        badge.textContent = String(def.count);
        btn.appendChild(badge);
      }
      bar.appendChild(btn);
      buttons.push(btn);

      const panel = document.createElement('div');
      panel.className = 'ld-tab-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.id = 'ld-tab-panel-' + def.id;
      panel.setAttribute('aria-labelledby', 'ld-tab-' + def.id);
      panels.appendChild(panel);
      panelEls.push(panel);

      btn.addEventListener('click', () => activate(idx));
    });

    function activate(activeIdx) {
      for (let i = 0; i < buttons.length; i++) {
        const isActive = i === activeIdx;
        buttons[i].classList.toggle('is-active', isActive);
        buttons[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
        buttons[i].tabIndex = isActive ? 0 : -1;
        panelEls[i].classList.toggle('is-active', isActive);
        if (isActive && !built.has(i)) {
          const content = defs[i].build();
          if (content) panelEls[i].appendChild(content);
          built.set(i, true);
        }
      }
    }

    wrap.appendChild(bar);
    wrap.appendChild(panels);
    activate(0);
    return wrap;
  }
