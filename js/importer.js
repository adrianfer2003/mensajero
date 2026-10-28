// Importar leads desde Excel, CSV o una lista pegada.
import { normPhone, tidyName, fold } from './util.js';
import { readXlsx } from './xlsx.js';

// ---------- Leer archivos ----------

function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  // UTF-16 sin BOM (algunos exportes de Facebook): muchos bytes nulos
  let zeros = 0;
  for (let i = 1; i < Math.min(u8.length, 400); i += 2) if (u8[i] === 0) zeros++;
  if (zeros > 60) return new TextDecoder('utf-16le').decode(u8);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder('windows-1252').decode(u8);
  }
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [['\t', count('\t')], [';', count(';')], [',', count(',')]].sort((a, b) => b[1] - a[1])[0];
  const d = delim[1] > 0 ? delim[0] : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

export async function readTableFile(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf.slice(0, 4));
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
  const lower = file.name.toLowerCase();
  if (isZip) {
    if (lower.endsWith('.numbers')) throw new Error('NUMBERS');
    return readXlsx(buf);
  }
  if (lower.endsWith('.xls')) throw new Error('OLD_XLS');
  return parseCSV(decodeText(buf));
}

// ---------- Columnas ----------

// Convierte filas crudas en { header, rows }. Si la primera fila tiene teléfonos, no es encabezado.
export function toTable(raw) {
  const width = Math.max(0, ...raw.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => String(r[i] ?? '').trim());
  const first = raw[0] ? pad(raw[0]) : [];
  const looksHeader = first.length && !first.some((c) => normPhone(c)) && first.some((c) => /[a-z]/i.test(c));
  const header = looksHeader ? first.map((c, i) => c || `Columna ${i + 1}`) : first.map((_, i) => `Columna ${i + 1}`);
  const rows = (looksHeader ? raw.slice(1) : raw).map(pad);
  return { header, rows };
}

const H = {
  phone: /(phone|tel|cel|movil|mobile|cell|numero|number|whats)/,
  first: /^(first ?name|first|nombre|primer nombre|nombres|given ?name)$/,
  last: /(last ?name|apellido|surname|family ?name)/,
  full: /(full ?name|nombre completo|^name$|^nombre$|cliente|customer|contact|contacto|lead name)/,
  vehicle: /(vehic|^auto|carro|^car\b|car of interest|\bmodel|modelo|interes|interest|\bvin\b|stock|year make)/,
  email: /(e ?mail|correo)/,
};

export function guessMapping({ header, rows }) {
  const names = header.map((h) => fold(h).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim());
  const sample = rows.slice(0, 50);
  const phoneScore = header.map((_, i) => sample.filter((r) => normPhone(r[i])).length);
  const pick = (re, avoid = []) => names.findIndex((n, i) => re.test(n) && !avoid.includes(i));

  let phone = -1;
  const best = Math.max(0, ...phoneScore);
  if (best > 0) {
    const cands = phoneScore.map((s, i) => [s, i]).filter(([s]) => s === best).map(([, i]) => i);
    phone = cands.find((i) => H.phone.test(names[i])) ?? cands[0];
  } else phone = pick(H.phone);

  const used = [phone];
  const email = pick(H.email, used);
  used.push(email);
  const last = pick(H.last, used);
  used.push(last);
  let first = pick(H.first, used);
  used.push(first);
  let name = pick(H.full, used);
  if (name < 0 && first >= 0) {
    name = first;
    first = -1;
  }
  if (name < 0) {
    // primera columna con letras que no sea el correo
    name = header.findIndex((_, i) => !used.includes(i) && sample.some((r) => /[a-záéíóúñ]{2}/i.test(r[i]) && !/@/.test(r[i])));
  }
  used.push(name);
  const vehicle = pick(H.vehicle, used);
  return { name, last: name >= 0 ? last : -1, phone, vehicle, email };
}

// ---------- Lista pegada ----------

const PHONE_RE = /(\+?\d[\d\s().\-]{7,}\d)/;

export function parsePasted(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  if (lines.some((l) => l.includes('\t'))) return toTable(lines.map((l) => l.split('\t')));
  const rows = lines.map((line) => {
    const m = PHONE_RE.exec(line);
    if (!m) return [line.replace(/[,;|]+$/, '').trim(), '', ''];
    const before = line.slice(0, m.index).replace(/[\s,;:|\-–]+$/, '').trim();
    const after = line.slice(m.index + m[0].length).replace(/^[\s,;:|\-–]+/, '').trim();
    return [before, m[0], after];
  });
  return { header: ['Nombre', 'Teléfono', 'Auto'], rows };
}

// ---------- Armar leads ----------

export function buildLeads(table, map, existing) {
  const seen = new Set(existing);
  const fresh = [];
  let dups = 0;
  let bad = 0;
  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  for (const r of table.rows) {
    const phone = normPhone(get(r, map.phone));
    if (!phone) {
      if (r.some((x) => String(x).trim())) bad++;
      continue;
    }
    if (seen.has(phone)) {
      dups++;
      continue;
    }
    seen.add(phone);
    const name = tidyName([get(r, map.name), get(r, map.last)].filter(Boolean).join(' '));
    fresh.push({ name, phone, vehicle: get(r, map.vehicle), email: get(r, map.email) });
  }
  return { fresh, dups, bad };
}
