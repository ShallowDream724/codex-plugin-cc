import { stat, open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const LIMIT = 10 * 1024 * 1024;
const mimeForExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
export function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  return width && height && width <= 16384 && height <= 16384 && width * height <= 40000000 ? { width, height } : null;
}
function signature(buffer, mime) {
  if (mime === 'image/png') return !!pngDimensions(buffer);
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  if (mime === 'image/bmp') return buffer.toString('ascii', 0, 2) === 'BM';
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
export async function materializeImage(source, save, convert) {
  const base = { index: source.index, ...(typeof source.alt === 'string' ? { alt: source.alt.slice(0, 256) } : {}) };
  let mime = typeof source.mime === 'string' ? source.mime.toLowerCase() : '', buffer, path = source.path;
  const fail = (notice) => ({ ...base, ...(path && isAbsolute(path) ? { path, file_url: pathToFileURL(path).href } : {}), ...(mime ? { mime_type: mime } : {}), previewable: false, notice });
  if (path) {
    if (!isAbsolute(path)) return fail('Image path is not absolute.');
    mime = mimeForExt[extname(path).toLowerCase()] ?? mime;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > LIMIT) return fail('Image is unavailable or exceeds the preview size limit.');
      const handle = await open(path, 'r');
      try { buffer = Buffer.alloc(Math.min(info.size, 32)); await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
    } catch { return fail('Image file is unavailable.'); }
  } else {
    if (typeof source.data !== 'string') return fail('Image data is unavailable.');
    let encoded = source.data;
    const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(encoded);
    if (match) { mime ||= match[1].toLowerCase(); encoded = match[2]; }
    if (!mime || !Object.values(mimeForExt).includes(mime)) return fail('Unsupported image format.');
    if (encoded.length > Math.ceil(LIMIT / 3) * 4 || !encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return fail('Invalid or oversized image data.');
    buffer = Buffer.from(encoded, 'base64');
    if (buffer.length > LIMIT || buffer.toString('base64') !== encoded) return fail('Invalid or oversized image data.');
    if (!signature(buffer, mime)) return fail('Image data does not match its format or exceeds image dimensions.');
    try { path = await save(buffer, mime); }
    catch (error) { if (error?.code === 'DISPLAY_CACHE_FULL') return fail('Display cache capacity reached; this embedded image cannot be opened.'); throw error; }
  }
  if (!signature(buffer, mime)) return fail('Image data does not match its format or exceeds image dimensions.');
  const dimensions = mime === 'image/png' ? pngDimensions(buffer) : null;
  const originalUrl = pathToFileURL(path).href;
  if (mime !== 'image/png' && ['image/jpeg', 'image/gif', 'image/bmp'].includes(mime) && convert) {
    try {
      const preview = await convert(path);
      if (preview) return { ...base, ...preview, file_url: originalUrl, mime_type: mime, preview_mime_type: 'image/png', previewable: true, ...(mime === 'image/gif' ? { notice: 'GIF preview shows the first frame.' } : {}) };
    } catch (error) {
      if (error?.code === 'DISPLAY_CACHE_FULL') return { ...base, path, file_url: originalUrl, mime_type: mime, previewable: false, notice: 'Display cache capacity reached; open the original image.' };
      // The original remains available if the system decoder fails.
    }
  }
  return { ...base, path, file_url: originalUrl, mime_type: mime, previewable: mime === 'image/png', ...(dimensions ?? {}), ...(mime !== 'image/png' ? { notice: 'Preview is unavailable for this format; open the original image.' } : {}) };
}
