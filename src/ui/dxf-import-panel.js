// US-104: the "Open DXF file" action in the Tools menu.
//
// Presentation only, mirroring src/ui/shape-stamp-panel.js's split: the
// model (parsing, geometry, the board mutation) lives in
// src/manual/dxf-import.js. This file is just the hidden file input, the
// FileReader glue, and closing the Tools menu after picking a file.
// Source part for app.js. Run `npm run build` after editing.

  function onDxfImportFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Unlike Template JSON import, a successful result lands on the board,
      // not inside this menu — close it so the TD sees the placed pieces.
      closeBoardToolbarMenus(null, false);
      importDxfText(String(reader.result || ''));
    };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
  }

  function bindDxfImportPanel() {
    if (!el.dxfImportBtn || !el.dxfImportFileInput) return;
    el.dxfImportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      el.dxfImportFileInput.click();
    });
    el.dxfImportFileInput.addEventListener('change', onDxfImportFile);
  }
