import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_ATTACHMENTS = 20;

function localAbsolute(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  // Reject UNC, Windows device namespaces, drive-relative paths and alternate
  // streams. This also excludes paths whose access could use a network share.
  if (/^[\\/]{2}/.test(value)) return false;
  if (process.platform !== 'win32' && /^\/dev(?:\/|$)/.test(value)) return false;
  const windows = /^[a-zA-Z]:[\\/]/.test(value);
  if (!windows && !path.posix.isAbsolute(value)) return false;
  if (windows && value.slice(2).includes(':')) return false;
  if (process.platform === 'win32') {
    if (!windows) return false;
    if (value.slice(3).split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part.replace(/[ .]+$/, '')))) return false;
  } else if (windows) return false;
  return true;
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'PNG';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'GIF';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'WebP';
  return null;
}

function plausibleImage(format, head, tail, size) {
  if (format === 'PNG') return size >= 45 && head.length >= 24 && head.readUInt32BE(8) === 13 && head.subarray(12, 16).toString('ascii') === 'IHDR'
    && head.readUInt32BE(16) > 0 && head.readUInt32BE(20) > 0 && tail.length >= 12
    && tail.subarray(-12, -8).equals(Buffer.alloc(4)) && tail.subarray(-8, -4).toString('ascii') === 'IEND';
  if (format === 'JPEG') return size >= 64 && tail.indexOf(Buffer.from([0xff, 0xd9])) !== -1;
  if (format === 'GIF') return size >= 20 && head.length >= 10 && head.readUInt16LE(6) > 0 && head.readUInt16LE(8) > 0 && tail.includes(0x3b);
  if (format === 'WebP') return size >= 20 && head.length >= 12 && head.readUInt32LE(4) >= 12 && head.readUInt32LE(4) + 8 <= size;
  return false;
}

/** Validate local files without loading their contents or copying them. */
export async function prepareAttachments(value = []) {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new TypeError(`attachments must be an array of at most ${MAX_ATTACHMENTS} local files.`);
  const result = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) || Object.keys(attachment).some((key) => key !== 'path') || !localAbsolute(attachment.path)) {
      throw new TypeError('Each attachment must have an absolute local file path; network and device paths are not supported.');
    }
    let handle;
    try {
      const resolved = await realpath(attachment.path);
      if (!localAbsolute(resolved)) throw new Error('The resolved path is not a local file.');
      if (!(await stat(resolved)).isFile()) throw new Error('The path is not a regular file.');
      // A file can be replaced after stat. Nonblocking open prevents a FIFO
      // replacement from hanging the controller; fstat then rejects it.
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);
      handle = await open(resolved, flags);
      const details = await handle.stat();
      if (!details.isFile()) throw new Error('The path is not a regular file.');
      const buffer = Buffer.alloc(32);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead), format = imageFormat(head);
      if (format) {
        const tail = Buffer.alloc(Math.min(details.size, 256));
        const { bytesRead: tailRead } = await handle.read(tail, 0, tail.length, Math.max(0, details.size - tail.length));
        if (!plausibleImage(format, head, tail.subarray(0, tailRead), details.size)) throw new Error(`${format} image appears truncated or invalid; choose a complete image file.`);
      }
      result.push({ name: path.basename(attachment.path), path: resolved, type: format ? 'image' : 'file' });
    } catch (error) {
      throw new Error(`Cannot attach ${attachment.path}: ${error.message}`, { cause: error });
    } finally { await handle?.close(); }
  }
  return result;
}

export function directUserInput(message, attachments) {
  const description = attachments.length ? `\n\nAttached local files: ${JSON.stringify(attachments)}.` : '';
  return [
    { type: 'text', text: `[Direct message from the user]\n\n${message}${description}`, text_elements: [] },
    ...attachments.filter(({ type }) => type === 'image').map(({ path: filePath }) => ({ type: 'localImage', path: filePath })),
  ];
}
