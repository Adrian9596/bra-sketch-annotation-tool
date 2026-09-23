// URL-query-param test/demo boot paths: ground-truth labeling, URL project
// load, and URL auto-draft demo automation.
// Source part for app.js. Run `npm run build` after editing.

  // Ground-truth labeling helper: ?label=1 shows a floating "Save Ground
  // Truth" button. The TD runs Detect Sketch, drags anchors to the correct
  // positions, then clicks Save to download a JSON file for the accuracy
  // harness (scripts/accuracy-tests.mjs). Hidden unless the param is present,
  // so it never touches the normal toolbar layout.
  function maybeShowGroundTruthLabeler() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('label') !== '1') return;
    const btn = document.createElement('button');
    btn.id = 'gtLabelBtn';
    btn.type = 'button';
    btn.textContent = '💾 Save Ground Truth';
    btn.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:9999',
      'padding:8px 12px', 'background:#b3005a', 'color:#fff', 'border:none',
      'border-radius:6px', 'font:13px system-ui,sans-serif', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';');
    btn.addEventListener('click', () => {
      if (state.appMode !== 'auto' || !state.autoMode.anchors.length) {
        showToast('Switch to Auto Mode, run Detect Sketch, and correct the anchors first.', 4200);
        return;
      }
      const suggested = (window.__braGroundTruthName || 'sketch.jpg') + '.json';
      const name = window.prompt(
        'Ground-truth file name (match the image, e.g. demo1.jpg.json):',
        suggested
      );
      if (!name) return;
      downloadGroundTruth(name);
    });
    document.body.appendChild(btn);

    // Convenience for building the accuracy corpus: ?label=1&image=demo/demo1.jpg
    // auto-loads that image, runs Detect Sketch, and pre-fills the save file
    // name — so labeling a corpus is "open URL → drag the wrong anchors → Save",
    // one image per URL. Absent the param, the manual add-image flow is unchanged.
    const imagePath = params.get('image');
    if (imagePath) void autoLoadLabelImage(imagePath);
  }

  // Fetch a same-origin image, put it on the board, and run Detect Sketch so the
  // detector's seeded anchors are ready for the TD to correct. Used only by the
  // ?label=1&image= labeling flow above. Best-effort: on any failure it falls
  // back to the manual add-image path with a toast.
  async function autoLoadLabelImage(imagePath) {
    try {
      const res = await fetch(encodeURI(imagePath), { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      const blob = await res.blob();
      const dataURL = await new Promise((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result || ''));
        r.onerror = () => no(new Error('read failed'));
        r.readAsDataURL(blob);
      });
      setAppMode('auto');
      await addImagesFromDataURLs([dataURL]);
      await new Promise((r) => setTimeout(r, 80));
      const sourceImage = state.images[state.images.length - 1] || null;
      if (!sourceImage) throw new Error('image did not load');
      state.selection = { kind: 'image', id: sourceImage.id };
      window.__braGroundTruthName = imagePath.split('/').pop();
      await runOfflineDetection();
      updateUI();
      render();
      const n = state.autoMode.anchors.length;
      showToast('Loaded ' + window.__braGroundTruthName + ' — ' + n
        + ' anchors detected. Click "Fit", drag any anchors that are off, then Save Ground Truth.', 6000);
    } catch (err) {
      console.error('[Ground Truth] auto-load failed:', err);
      showToast('Could not auto-load ' + imagePath + ' — add it manually, then Detect Sketch.', 5200);
    }
  }

  async function loadProjectFromUrl() {
    const projectUrl = new URLSearchParams(window.location.search).get('project');
    if (!projectUrl) return;
    try {
      const response = await fetch(projectUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load project');
      await loadProject(await response.json());
      showToast('Draft project loaded.');
    } catch (error) {
      console.error(error);
      showToast('Could not load the draft project.', 4200);
    }
  }

  // Demo helper: ?autoDraft=1 drives Auto Mode → Detect Sketch → Generate POM
  // Drafts on whatever image is on the board after load. Lets the demo flow be
  // shared as a URL without manual clicking. No-op when the param is absent.
  async function maybeAutoDraftFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autoDraft') !== '1') return;
    const waitForImage = async () => {
      for (let i = 0; i < 50; i += 1) {
        const img = pickAutoSourceImage();
        if (img && img.img && img.img.complete) return img;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const sourceImage = await waitForImage();
    if (!sourceImage) {
      showToast('autoDraft: no source image found.', 4200);
      return;
    }
    setAppMode('auto');
    await runOfflineDetection();
    if (state.autoMode.status !== 'detected') {
      showToast('autoDraft: detection did not complete.', 4200);
      return;
    }
    generatePOMDraftsFromAnchors();
  }
