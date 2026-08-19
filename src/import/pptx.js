// PowerPoint (.pptx) import: orchestration glue between the file input, the
// slide parser, and the picker dialog.
// Source part for app.js. Run `npm run build` after editing.
//
// The ZIP container reader lives in zip-reader.js (hand-rolled, dependency-
// free), slide/picture extraction in pptx-xml.js, and the picker UI the TD
// uses to choose which pages to import in ui/dialogs/pptx-picker-dialog.js.

  async function onPptxFileChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    await processPptxFile(file);
  }

  async function processPptxFile(file) {
    el.importPptxBtn.disabled = true;
    const prevLabel = el.importPptxBtn.textContent;
    el.importPptxBtn.textContent = 'Importing…';
    try {
      const buffer = await file.arrayBuffer();
      const entries = await extractSlidesFromPptx(buffer);
      if (!entries.length) {
        showToast('No usable sketch images were found in that deck.', 4200);
        return;
      }
      // Group images by their source slide so each picker choice is a whole
      // page: a slide with several pictures imports all of them together.
      const pages = groupEntriesBySlide(entries);
      if (pages.length === 1) {
        await addImagesFromDataURLs(pages[0].dataURLs);
        return;
      }
      openPptxPicker(pages);
    } catch (error) {
      console.error(error);
      showToast('Could not read that .pptx file. It may be corrupt or use an unsupported format.', 4600);
    } finally {
      el.importPptxBtn.disabled = false;
      el.importPptxBtn.textContent = prevLabel;
    }
  }
