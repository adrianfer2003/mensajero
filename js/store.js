// Todo se guarda en este teléfono (IndexedDB). Nada sale a internet.
import { uid } from './util.js';

const DB_NAME = 'mensajero';
const STORE = 'kv';
const KEYS = ['leads', 'templates', 'campaigns', 'settings'];

export const DEFAULT_SETTINGS = {
  myName: '',
  dealer: '',
  optOutEs: 'Responde STOP para no recibir más mensajes.',
  optOutEn: 'Reply STOP to opt out.',
  skip24h: true,
  quietWarn: true,
  hideInstall: false,
};

export const state = {
  leads: [],
  templates: [],
  campaigns: [],
  settings: { ...DEFAULT_SETTINGS },
};

export function seedTemplates() {
  return [
    {
      id: uid(),
      name: 'Primer contacto',
      body: '¡Hola {primer_nombre}! Soy {mi_nombre} de {concesionario}. Vi que estás buscando {auto}. ¿Cuándo te queda bien pasar a verlo, o prefieres que te mande fotos y precio por aquí?',
      autoFallback: 'carro',
      optOut: 'es',
    },
    {
      id: uid(),
      name: 'Seguimiento',
      body: 'Hola {primer_nombre}, soy {mi_nombre} de {concesionario}. ¿Sigues buscando {auto}? Esta semana tengo buenas opciones y te puedo ayudar con el financiamiento. ¿Te llamo un momento?',
      autoFallback: 'carro',
      optOut: 'es',
    },
    {
      id: uid(),
      name: 'Oferta del mes',
      body: '¡{primer_nombre}, buenas noticias! Este mes tenemos ofertas especiales en {concesionario}. Dime qué pago mensual te queda cómodo y te busco las mejores opciones. Soy {mi_nombre}.',
      autoFallback: '',
      optOut: 'es',
    },
    {
      id: uid(),
      name: 'First contact (English)',
      body: "Hi {primer_nombre}! This is {mi_nombre} from {concesionario}. I saw you're looking for {auto}. When's a good time to come see it, or want me to text you photos and pricing?",
      autoFallback: 'a new car',
      optOut: 'en',
    },
  ];
}

// ---------- IndexedDB ----------

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const getKey = (k) => (db ? idb('readonly', (s) => s.get(k)) : Promise.resolve(lsGet(k)));
const setKey = (k, v) => (db ? idb('readwrite', (s) => s.put(v, k)) : Promise.resolve(lsSet(k, v)));

function lsGet(k) {
  try {
    const raw = localStorage.getItem('mensajero:' + k);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem('mensajero:' + k, JSON.stringify(v));
  } catch {}
}

export async function load() {
  try {
    db = await openDB();
  } catch {
    db = null; // sin IndexedDB: localStorage
  }
  for (const k of KEYS) {
    let v;
    try {
      v = await getKey(k);
    } catch {
      v = undefined;
    }
    if (k === 'settings') state.settings = { ...DEFAULT_SETTINGS, ...(v || {}) };
    else state[k] = Array.isArray(v) ? v : [];
  }
  if (!state.templates.length && !(await getKey('seeded'))) {
    state.templates = seedTemplates();
    await setKey('seeded', true);
    save('templates');
  }
  // Pide al sistema no borrar los datos cuando falte espacio
  try {
    navigator.storage && navigator.storage.persist && navigator.storage.persist();
  } catch {}
}

const dirty = new Set();
let timer = null;

export function save(...keys) {
  (keys.length ? keys : KEYS).forEach((k) => dirty.add(k));
  clearTimeout(timer);
  timer = setTimeout(flush, 120);
}

export async function flush() {
  clearTimeout(timer);
  const ks = [...dirty];
  dirty.clear();
  for (const k of ks) {
    try {
      await setKey(k, state[k]);
    } catch (e) {
      console.error('No se pudo guardar', k, e);
    }
  }
}

export function replaceAll(data) {
  state.leads = Array.isArray(data.leads) ? data.leads : [];
  state.templates = Array.isArray(data.templates) ? data.templates : [];
  state.campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  save();
}

// ---------- Búsquedas ----------

export const leadById = (id) => state.leads.find((l) => l.id === id);
export const templateById = (id) => state.templates.find((t) => t.id === id);
export const campaignById = (id) => state.campaigns.find((c) => c.id === id);

export function newLead(fields) {
  return {
    id: uid(),
    name: '',
    phone: '',
    vehicle: '',
    email: '',
    list: '',
    notes: '',
    status: 'nuevo',
    dnc: false,
    createdAt: Date.now(),
    lastSentAt: null,
    history: [],
    ...fields,
  };
}
