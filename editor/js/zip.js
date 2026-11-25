// Minimal zip reader for crrec-1 recordings (stored + deflate entries), using the browser's DecompressionStream.
export async function openZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file (no central directory). Was the download cut short?');
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const entries = new Map();
  const td = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    entries.set(name, { method, csize, usize, start });
  }
  async function bytes(name) {
    const en = entries.get(name);
    if (!en) throw new Error('missing ' + name + ' in the recording');
    const raw = u8.subarray(en.start, en.start + en.csize);
    if (en.method === 0) return raw;
    if (en.method !== 8) throw new Error('unsupported zip compression ' + en.method);
    const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    bytes,
    text: async (name) => td.decode(await bytes(name)),
    blob: async (name, type) => new Blob([await bytes(name)], type ? { type } : undefined),
  };
}
