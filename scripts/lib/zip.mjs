// Small ZIP reader so updates work the same on macOS and Windows with no extra tools.
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

function decodeName(bytes, isUtf8) {
  if (isUtf8) return bytes.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

function findEocd(buf) {
  const lowest = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= lowest; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  throw new Error('zip: arşiv sonu bulunamadı');
}

// git and GitHub store the commit id here.
export function zipComment(buf) {
  const eocd = findEocd(buf);
  const length = buf.readUInt16LE(eocd + 20);
  return buf.subarray(eocd + 22, eocd + 22 + length).toString('latin1');
}

/**
 * @param {Buffer} buf
 * @param {{ maxTotalBytes?: number }} [options]
 */
export function readZip(buf, { maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('zip: zip64 desteklenmiyor');

  const entries = [];
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL) throw new Error('zip: bozuk dizin');
    const madeBy = buf.readUInt16LE(off + 4);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const extAttr = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const name = decodeName(buf.subarray(off + 46, off + 46 + nameLen), (flags & 0x800) !== 0);
    off += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error('zip: şifreli arşiv');
    totalBytes += size;
    if (size > MAX_ENTRY_BYTES || totalBytes > maxTotalBytes) throw new Error('zip: dosya çok büyük');
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL) throw new Error('zip: bozuk kayıt');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    if (start + compSize > buf.length) throw new Error('zip: eksik veri');
    const raw = buf.subarray(start, start + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error('zip: bilinmeyen sıkıştırma');
    if (data.length !== size || crc32(data) >>> 0 !== crc) throw new Error('zip: dosya bozuk');

    const mode = madeBy >> 8 === 3 ? extAttr >>> 16 : 0;
    entries.push({
      name,
      data,
      mode,
      isDir: name.endsWith('/'),
      isSymlink: (mode & 0o170000) === 0o120000,
    });
  }
  return entries;
}

// GitHub archives wrap everything in a single `<repo>-<sha>/` folder.
export function stripTopDir(entries) {
  const top = entries[0]?.name.split('/')[0];
  if (!top) throw new Error('zip: boş arşiv');
  const prefix = `${top}/`;
  return entries.map((e) => {
    if (!e.name.startsWith(prefix)) throw new Error('zip: tek üst klasör yok');
    return { ...e, path: e.name.slice(prefix.length) };
  });
}
