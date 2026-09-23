// Promise/one-call wrappers around the browser's file and image APIs: save a
// Blob as a download, read a Blob as a data URL, decode a data URL into an
// Image. No feature knowledge — every exporter, the project save, the library
// and the tech-pack pages share them, so they live in core (ADR 0103 Phase B).
// Source part for app.js. Run `npm run build` after editing.

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImageFromDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataURL;
    });
  }
