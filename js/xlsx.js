// Lector mínimo de Excel (.xlsx): abre el zip, lee la primera hoja y devuelve filas de texto.
// Sin librerías externas, funciona sin internet.

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('NO_INFLATE');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf, want) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // Fin del directorio central
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('NOT_ZIP');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = u8.subarray(start, start + csize);
    const raw = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
    if (raw) out[name] = dec.decode(raw);
  }
  return out;
}

const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(buf) {
  const files = await unzip(
    buf,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      n.startsWith('xl/worksheets/'),
  );
  const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');

  // Primera hoja según el libro
  let sheetPath = null;
  if (files['xl/workbook.xml'] && files['xl/_rels/workbook.xml.rels']) {
    const wb = parse(files['xl/workbook.xml']);
    const first = tags(wb, 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rels = parse(files['xl/_rels/workbook.xml.rels']);
    const rel = tags(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) {
      const t = rel.getAttribute('Target');
      sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
  }
  if (!sheetPath || !files[sheetPath]) {
    sheetPath = Object.keys(files)
      .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k))
      .sort()[0];
  }
  if (!sheetPath) throw new Error('NO_SHEET');

  const shared = files['xl/sharedStrings.xml']
    ? tags(parse(files['xl/sharedStrings.xml']), 'si').map((si) =>
        tags(si, 't')
          .filter((t) => !t.parentNode || t.parentNode.localName !== 'rPh') // sin la guía fonética
          .map((t) => t.textContent)
          .join(''),
      )
    : [];

  const sheet = parse(files[sheetPath]);
  const rows = [];
  for (const row of tags(sheet, 'row')) {
    const r = [];
    let next = 0;
    for (const c of tags(row, 'c')) {
      let i = colIndex(c.getAttribute('r'));
      if (i < 0) i = next;
      next = i + 1;
      const type = c.getAttribute('t');
      const v = tags(c, 'v')[0];
      let val = '';
      if (type === 's') val = shared[Number(v && v.textContent)] ?? '';
      else if (type === 'inlineStr') val = tags(c, 't').map((t) => t.textContent).join('');
      else if (v) val = v.textContent;
      if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
      r[i] = val;
    }
    const rIdx = Number(row.getAttribute('r'));
    const at = rIdx > 0 ? rIdx - 1 : rows.length;
    rows[at] = Array.from(r, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x || []).filter((r) => r.some((x) => String(x).trim() !== ''));
}
