// Utilidades: teléfonos, nombres, plantillas, fechas y archivos.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Quita acentos y pasa a minúsculas (para buscar y comparar)
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// ---------- Teléfonos ----------

// Devuelve el número en formato +13055551234, o null si no es válido.
export function normPhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^\d(\.\d+)?e\+\d+$/i.test(s)) s = Number(s).toFixed(0); // 3.055551234E+9 (Excel)
  s = s.replace(/^p:\s*/i, ''); // Facebook Lead Ads exporta "p:+13055551234"
  s = s.replace(/\s*(ext\.?|x)\s*\d+\s*$/i, ''); // extensión
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (d.startsWith('011') && d.length > 12) return '+' + d.slice(3);
  if (d.length === 10 && !plus) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (plus && d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}

export function fmtPhone(p) {
  if (!p) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

export const phoneDigits = (p) => String(p ?? '').replace(/\D/g, '');

// ---------- Nombres ----------

const LOWER_PARTS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'do', 'dos', 'van', 'von']);

// "JUAN PEREZ" o "juan perez" → "Juan Perez". Si ya viene con mayúsculas y minúsculas, se respeta.
export function tidyName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    s = s
      .toLowerCase()
      .split(' ')
      .map((w, i) => (i > 0 && LOWER_PARTS.has(w) ? w : w.replace(/(^|[-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())))
      .join(' ');
  }
  return s;
}

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

// ---------- Plantillas ----------

export const VARS = [
  ['primer_nombre', 'Primer nombre'],
  ['nombre', 'Nombre completo'],
  ['auto', 'Auto de interés'],
  ['mi_nombre', 'Tu nombre'],
  ['concesionario', 'Concesionario'],
];

// msg: { body, optOut: 'es' | 'en' | '', autoFallback }
export function renderMessage(msg, lead, settings) {
  const vars = {
    primer_nombre: firstName(lead.name),
    nombre: lead.name || '',
    auto: (lead.vehicle || '').trim() || msg.autoFallback || '',
    mi_nombre: settings.myName || '',
    concesionario: settings.dealer || '',
  };
  let out = String(msg.body || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  out = out
    .replace(/[ \t]+([,.!?;:])/g, '$1') // "Hola !" → "Hola!" cuando falta el nombre
    .replace(/([¡¿])[ \t]+/g, '$1')
    .replace(/,([!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
  const stop = msg.optOut === 'en' ? settings.optOutEn : msg.optOut === 'es' ? settings.optOutEs : '';
  out = out.trim();
  if (stop) out += '\n\n' + stop.trim();
  return out;
}

// ---------- Envío ----------

const APPLE = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);

export function smsHref(phone, body) {
  const sep = APPLE ? '&' : '?';
  return body ? `sms:${phone}${sep}body=${encodeURIComponent(body)}` : `sms:${phone}`;
}

// Ley de Florida (FTSA): mensajes de venta solo de 8 am a 8 pm
export function outsideHours(d = new Date()) {
  const h = d.getHours();
  return h < 8 || h >= 20;
}

export const DAY = 24 * 60 * 60 * 1000;
export const sentRecently = (lead, now = Date.now()) => !!lead.lastSentAt && now - lead.lastSentAt < DAY;

// ---------- Fechas ----------

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const shortDate = (t) => {
  const d = new Date(t);
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
};

export function clock(t = Date.now()) {
  const d = new Date(t);
  let h = d.getHours();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

export function when(t) {
  if (!t) return '';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `hoy, ${clock(t)}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `ayer, ${clock(t)}`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `hace ${days} días`;
  return shortDate(t) + (d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '');
}

export const isToday = (t) => !!t && new Date(t).toDateString() === new Date().toDateString();

// ---------- Archivos ----------

export async function shareOrDownload(filename, blob) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
  return true;
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
