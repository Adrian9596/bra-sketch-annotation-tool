// Minimal, dependency-free ZIP reader (central directory + DEFLATE via
// DecompressionStream). Source part for app.js. Run `npm run build` after
// editing.
//
// Fully generic — no pptx-specific or app-specific (state/el) references.
// Split out of src/import/pptx.js so it can be reused by any future
// ZIP-container import (e.g. .docx) and reasoned about independently of
// OOXML/slide parsing. Must load before src/import/pptx-xml.js and
// src/import/pptx.js, both of which call into it.

  function parseZip(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= 0; i -= 1) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP/.pptx file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let n = 0; n < count; n += 1) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8Decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv, bytes, entries, _cache: {} };
  }

  function entryCompressedBytes(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const lo = e.localOffset;
    if (zip.dv.getUint32(lo, true) !== 0x04034b50) return null;
    const nameLen = zip.dv.getUint16(lo + 26, true);
    const extraLen = zip.dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    return { method: e.method, data: zip.bytes.subarray(start, start + e.compSize) };
  }

  async function readZipEntryBytes(zip, name) {
    const raw = entryCompressedBytes(zip, name);
    if (!raw) return null;
    if (raw.method === 0) return raw.data;
    if (raw.method === 8) return await inflateRaw(raw.data);
    throw new Error('Unsupported ZIP compression method ' + raw.method);
  }

  async function readZipEntryText(zip, name) {
    const bytes = await readZipEntryBytes(zip, name);
    return bytes ? utf8Decode(bytes) : '';
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
