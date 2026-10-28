// Mensajero: manda mensajes a tus leads uno por uno desde el iPhone.
import { state, load, save, flush, replaceAll, leadById, templateById, campaignById, newLead, seedTemplates } from './store.js';
import * as U from './util.js';
import { readTableFile, toTable, guessMapping, parsePasted, buildLeads } from './importer.js';

const TEST = new URLSearchParams(location.search).has('test');
const esc = U.esc;

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');
const $fileIn = document.getElementById('file-in');
const $backupIn = document.getElementById('backup-in');

const STATUSES = [
  ['nuevo', 'Nuevo'],
  ['contactado', 'Contactado'],
  ['respondio', 'Respondió'],
  ['cita', 'Cita'],
  ['vendido', 'Vendido'],
  ['perdido', 'No interesado'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const DEFAULT_AUDIENCE = ['nuevo', 'contactado', 'respondio', 'cita'];

const nav = { tab: 'enviar', stack: [] };
const ui = { q: '', list: '*', status: '*', limit: 150, camp: null, editMsg: false, pasteText: '' };
let importDraft = null;
let pending = null; // mensaje abierto en Mensajes, esperando confirmación
const PENDING_KEY = 'mensajero:pending';
function setPending(p) {
  pending = p;
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}
let sheetItems = [];

// ---------- Íconos ----------
const svg = (d, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  chev: svg('<path d="M9 18l6-6-6-6"/>', 'chev'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  phone: svg('<path d="M21 16.5v3a2 2 0 0 1-2.2 2A19.5 19.5 0 0 1 2.5 5.2 2 2 0 0 1 4.5 3h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.4 10.7a16 16 0 0 0 5 5l1.3-1.3a2 2 0 0 1 2.1-.5c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.6 2z"/>'),
  message: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

// ---------- Piezas de HTML ----------
const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
const head = (title, right = '') => `<header class="head"><h1 class="title">${esc(title)}</h1>${right}</header>`;
const subnav = (label = 'Atrás', right = '') =>
  `<div class="subnav"><button class="back" data-act="back">${I.back}${esc(label)}</button>${right}</div>`;
const label = (t) => `<h2 class="label">${esc(t)}</h2>`;
const bubble = (text) => `<div class="bubble-wrap"><div class="bubble">${esc(text)}</div></div>`;
const chip = (text, pressed, act, k, count) =>
  `<button class="chip" data-act="${act}" data-k="${esc(k)}" aria-pressed="${!!pressed}">${esc(text)}${
    count != null ? `<span class="n">${count}</span>` : ''
  }</button>`;
const listName = (k) => k || 'Sin lista';
const who = (l) => U.firstName(l.name) || U.fmtPhone(l.phone);

function listCounts(leads = state.leads) {
  const m = new Map();
  for (const l of leads) m.set(l.list || '', (m.get(l.list || '') || 0) + 1);
  return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0], 'es')));
}
const listsDatalist = () =>
  `<datalist id="lists">${listCounts()
    .filter(([k]) => k)
    .map(([k]) => `<option value="${esc(k)}"></option>`)
    .join('')}</datalist>`;

// ---------- Navegación ----------
const current = () => nav.stack[nav.stack.length - 1] || { view: nav.tab, params: {} };
let lastKey = '';

function render() {
  const cur = current();
  const key = cur.view + ':' + JSON.stringify(cur.params || {}) + ':' + nav.stack.length;
  const y = window.scrollY;
  $view.innerHTML = VIEWS[cur.view](cur.params || {});
  document.body.classList.toggle('no-tabs', nav.stack.length > 0);
  document.body.dataset.view = cur.view;
  $tabs.querySelectorAll('[data-tab]').forEach((b) => {
    if (b.dataset.tab === nav.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, key === lastKey ? y : 0);
  lastKey = key;
  AFTER[cur.view] && AFTER[cur.view](cur.params || {});
}
function go(view, params = {}) {
  nav.stack.push({ view, params });
  render();
}
function back() {
  const top = nav.stack.pop();
  if (top && LEAVE[top.view]) LEAVE[top.view](top.params || {});
  render();
}
function replace(view, params = {}) {
  nav.stack[nav.stack.length - 1] = { view, params };
  render();
}
function setTab(tab) {
  nav.tab = tab;
  nav.stack = [];
  render();
}

// ---------- Avisos ----------
let toastTimer = null;
function toast(msg, actionLabel, action) {
  $toast.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  $toast.classList.add('show');
  const btn = $toast.querySelector('button');
  if (btn)
    btn.onclick = () => {
      hideToast();
      action();
    };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3200);
}
function hideToast() {
  $toast.classList.remove('show');
}

function sheet(items, title = '') {
  sheetItems = items;
  $sheet.innerHTML = `<div class="sheet-bg" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(
    title || 'Opciones',
  )}">${title ? `<p class="sheet-title">${esc(title)}</p>` : ''}<div class="group">${items
    .map((it, i) => `<button class="row sheet-row${it.danger ? ' danger' : ''}" data-act="sheet-item" data-i="${i}">${esc(it.label)}</button>`)
    .join('')}</div><button class="btn" data-act="close-sheet">Cancelar</button></div></div>`;
  requestAnimationFrame(() => $sheet.querySelector('.sheet-bg').classList.add('open'));
}
const closeSheet = () => {
  $sheet.innerHTML = '';
};

// ---------- Envíos ----------
const nextIndex = (c) => c.queue.findIndex((id) => !c.results[id]);

function campStats(c) {
  const s = { sent: 0, skipped: 0, dnc: 0, gone: 0, done: 0 };
  for (const id of c.queue) {
    const r = c.results[id];
    if (!r) continue;
    s.done++;
    if (r === 'sent') s.sent++;
    else if (r === 'skipped') s.skipped++;
    else if (r === 'dnc') s.dnc++;
    else s.gone++;
  }
  return s;
}

function finishIfDone(c) {
  if (nextIndex(c) < 0) {
    if (!c.finishedAt) c.finishedAt = Date.now();
  } else c.finishedAt = null;
}

// Quita del envío a quien se borró o pidió no recibir mensajes
function syncCampaign(c) {
  let changed = false;
  for (const id of c.queue) {
    if (c.results[id]) continue;
    const l = leadById(id);
    if (!l) c.results[id] = 'gone';
    else if (l.dnc) c.results[id] = 'dnc';
    else continue;
    changed = true;
  }
  if (changed) {
    finishIfDone(c);
    save('campaigns');
  }
}

function audience(d) {
  let pool = state.leads.filter((l) => (d.lists.size === 0 || d.lists.has(l.list || '')) && d.statuses.has(l.status));
  const dnc = pool.filter((l) => l.dnc).length;
  pool = pool.filter((l) => !l.dnc);
  let recent = 0;
  if (state.settings.skip24h) {
    const now = Date.now();
    const before = pool.length;
    pool = pool.filter((l) => !U.sentRecently(l, now));
    recent = before - pool.length;
  }
  pool.sort((a, b) => a.createdAt - b.createdAt);
  return { leads: pool, dnc, recent };
}

function messageFor(c, lead) {
  return c.overrides && c.overrides[lead.id] != null ? c.overrides[lead.id] : U.renderMessage(c, lead, state.settings);
}

function confirmSent() {
  if (!pending) return;
  const p = pending;
  setPending(null);
  ui.editMsg = false;
  const c = campaignById(p.campaignId);
  const lead = leadById(p.leadId);
  if (!c || !lead) return render();
  const snap = { status: lead.status, lastSentAt: lead.lastSentAt };
  const entry = { t: Date.now(), text: p.text, campaign: c.name };
  lead.history.push(entry);
  lead.lastSentAt = entry.t;
  if (lead.status === 'nuevo') lead.status = 'contactado';
  c.results[lead.id] = 'sent';
  finishIfDone(c);
  save('leads', 'campaigns');
  render();
  toast(`Enviado a ${who(lead)}`, 'Deshacer', () => {
    lead.history = lead.history.filter((h) => h !== entry);
    lead.status = snap.status;
    lead.lastSentAt = snap.lastSentAt;
    delete c.results[lead.id];
    finishIfDone(c);
    save('leads', 'campaigns');
    render();
  });
}

function markCurrent(result) {
  const c = campaignById(current().params.id);
  if (!c) return;
  const idx = nextIndex(c);
  if (idx < 0) return;
  const lead = leadById(c.queue[idx]);
  ui.editMsg = false;
  c.results[lead.id] = result;
  if (result === 'dnc') lead.dnc = true;
  finishIfDone(c);
  save('leads', 'campaigns');
  render();
  const msg = result === 'dnc' ? `${who(lead)} no recibirá más mensajes` : `Saltaste a ${who(lead)}`;
  toast(msg, 'Deshacer', () => {
    delete c.results[lead.id];
    if (result === 'dnc') lead.dnc = false;
    finishIfDone(c);
    save('leads', 'campaigns');
    render();
  });
}

// ---------- Leads ----------
function filteredLeads() {
  const q = U.fold(ui.q).trim();
  const qd = q.replace(/\D/g, '');
  return state.leads
    .filter(
      (l) =>
        (ui.list === '*' || (l.list || '') === ui.list) &&
        (ui.status === '*' || (ui.status === 'dnc' ? l.dnc : l.status === ui.status && !l.dnc)) &&
        (!q || U.fold(l.name).includes(q) || U.fold(l.vehicle).includes(q) || (qd.length >= 3 && U.phoneDigits(l.phone).includes(qd))),
    )
    .sort((a, b) => Math.floor(b.createdAt) - Math.floor(a.createdAt) || a.createdAt - b.createdAt);
}

function leadRow(l) {
  const sub = [l.name ? `<span>${U.fmtPhone(l.phone)}</span>` : '', l.vehicle ? `<span>${esc(l.vehicle)}</span>` : ''].join('');
  const pill = l.dnc ? '<span class="pill dnc">No contactar</span>' : `<span class="pill s-${l.status}">${STATUS_LABEL[l.status] || ''}</span>`;
  return `<button class="row" data-act="open-lead" data-id="${l.id}"><div class="row-main"><div class="row-title">${esc(
    l.name || U.fmtPhone(l.phone),
  )}</div>${sub ? `<div class="row-sub">${sub}</div>` : ''}</div>${pill}</button>`;
}

function leadListHTML() {
  const all = filteredLeads();
  const shown = all.slice(0, ui.limit);
  let h = `<p class="count">${n(all.length, 'lead', 'leads')}</p>`;
  if (!all.length) h += `<p class="note">Ningún lead coincide.</p>`;
  else h += `<div class="group">${shown.map(leadRow).join('')}</div>`;
  if (all.length > shown.length) h += `<button class="btn" data-act="more">Mostrar ${Math.min(300, all.length - shown.length)} más</button>`;
  if (ui.list !== '*' && ui.status === '*' && !ui.q && all.length)
    h += `<button class="link danger end" data-act="delete-list">Borrar la lista ${esc(listName(ui.list))} y sus ${n(all.length, 'lead', 'leads')}</button>`;
  return h;
}

const emptyLeads = () =>
  `<section class="empty"><p class="empty-title">Primero, tus leads</p><p>Sube el Excel o CSV que te dan Facebook, el CRM o el concesionario, o pega una lista con nombres y teléfonos.</p><div class="stack"><button class="btn primary" data-act="pick-file">Importar Excel o CSV</button><button class="btn" data-act="paste">Pegar una lista</button><button class="link" data-act="add-lead">Agregar uno a mano</button></div></section>`;

const field = (lbl, f, val, type = 'text', extra = '') =>
  `<label class="field"><span>${esc(lbl)}</span><input type="${type}" value="${esc(val)}" data-change="lead-field" data-f="${f}" autocomplete="off" ${extra}></label>`;

// ---------- Vistas ----------
const VIEWS = {
  enviar() {
    const s = state.settings;
    let h = head('Enviar');
    if (U.isIOS() && !U.isStandalone() && !s.hideInstall)
      h += `<div class="hint"><p>Para tenerla como app: en Safari toca <b>Compartir</b> y luego <b>Agregar a inicio</b>.</p><button class="link" data-act="hide-install">Entendido</button></div>`;
    if (!state.leads.length) return h + emptyLeads();
    if (!s.myName || !s.dealer)
      h += `<button class="hint hint-btn" data-act="tab" data-tab="ajustes"><span><b>Pon tu nombre y el del concesionario</b> para que los mensajes salgan firmados.</span>${I.chev}</button>`;
    const active = state.campaigns.filter((c) => !c.finishedAt);
    const done = state.campaigns.filter((c) => c.finishedAt);
    if (active.length) h += label('Sin terminar') + `<div class="group">${active.map(campRow).join('')}</div>`;
    h += `<button class="btn primary big" data-act="new-campaign">Nuevo envío</button>`;
    const today = state.leads.filter((l) => U.isToday(l.lastSentAt)).length;
    h += `<p class="note center">${n(state.leads.length, 'lead guardado', 'leads guardados')}. ${
      today ? `Hoy le escribiste a ${n(today, 'persona', 'personas')}.` : 'Hoy todavía no le has escrito a nadie.'
    }</p>`;
    if (done.length) h += label('Envíos anteriores') + `<div class="group">${done.slice(0, 40).map(campRow).join('')}</div>`;
    return h;
  },

  newCampaign() {
    const d = ui.camp;
    const inLists = state.leads.filter((l) => d.lists.size === 0 || d.lists.has(l.list || ''));
    const byStatus = {};
    for (const l of inLists) if (!l.dnc) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    const aud = audience(d);
    const tpl = templateById(d.templateId);
    let h = subnav() + `<h1 class="title">Nuevo envío</h1>`;
    h += label('¿A quién le escribes?');
    h += `<div class="chips">${chip('Todas las listas', d.lists.size === 0, 'camp-list', '*')}${listCounts()
      .map(([k, c]) => chip(listName(k), d.lists.has(k), 'camp-list', k, c))
      .join('')}</div>`;
    h += `<div class="chips">${STATUSES.map(([k, v]) => chip(v, d.statuses.has(k), 'camp-status', k, byStatus[k] || 0)).join('')}</div>`;
    const out = [];
    if (aud.dnc) out.push(`${n(aud.dnc, 'que pidió', 'que pidieron')} no recibir mensajes`);
    if (aud.recent) out.push(`${n(aud.recent, 'persona a quien ya le escribiste', 'personas a quienes ya les escribiste')} en las últimas 24 horas`);
    h += `<p class="note">${aud.leads.length ? `Le vas a escribir a ${n(aud.leads.length, 'persona', 'personas')}.` : 'Nadie cumple con lo que escogiste.'}${
      out.length ? ` Quedan fuera ${out.join(' y ')}.` : ''
    }</p>`;
    h += label('Mensaje');
    if (!state.templates.length) h += `<button class="btn" data-act="new-template">Escribir un mensaje</button>`;
    else
      h += `<div class="group">${state.templates
        .map(
          (t) =>
            `<button class="row radio" data-act="camp-tpl" data-id="${t.id}" aria-pressed="${t.id === d.templateId}"><span class="dot" aria-hidden="true"></span><div class="row-main"><div class="row-title">${esc(
              t.name || 'Sin nombre',
            )}</div><div class="row-sub clamp">${esc(U.renderMessage({ ...t, optOut: '' }, aud.leads[0] || sampleLead(), state.settings))}</div></div></button>`,
        )
        .join('')}</div><button class="link" data-act="new-template">Escribir otro mensaje</button>`;
    if (tpl && aud.leads.length) {
      const sample = aud.leads[0];
      h += label(`Así le llega a ${who(sample)}`) + bubble(U.renderMessage(tpl, sample, state.settings));
      h += `<button class="link" data-act="edit-template" data-id="${tpl.id}">Editar esta plantilla</button>`;
    }
    const ok = tpl && aud.leads.length;
    h += `<div class="sticky"><button class="btn primary big" data-act="start-campaign" ${ok ? '' : 'disabled'}>${
      ok ? `Empezar con ${n(aud.leads.length, 'persona', 'personas')}` : tpl ? 'Nadie para escribirle' : 'Escoge un mensaje'
    }</button></div>`;
    return h;
  },

  queue({ id }) {
    const c = campaignById(id);
    if (!c) return subnav() + `<p class="note">Este envío ya no existe.</p>`;
    syncCampaign(c);
    const idx = nextIndex(c);
    const st = campStats(c);
    const total = c.queue.length;
    if (idx < 0) return doneView(c, st);
    const lead = leadById(c.queue[idx]);
    const text = messageFor(c, lead);
    const fn = who(lead);
    let h = `<div class="q"><div class="q-top"><button class="back" data-act="back">${I.back}Pausar</button><span class="q-count">${st.done + 1} de ${total}</span></div>`;
    h += `<div class="q-bar" role="progressbar" aria-label="Progreso del envío" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${st.done}"><i style="width:${(
      (st.done / total) *
      100
    ).toFixed(1)}%"></i></div>`;
    if (state.settings.quietWarn && U.outsideHours())
      h += `<div class="warn">Son las ${U.clock()}. En Florida los mensajes de venta solo se pueden mandar de 8 am a 8 pm. Mejor sigue mañana.</div>`;
    const meta = [
      lead.vehicle ? `<span class="pill">${esc(lead.vehicle)}</span>` : '',
      lead.list ? `<span class="pill">${esc(lead.list)}</span>` : '',
      U.sentRecently(lead) ? `<span class="pill dnc">Le escribiste ${esc(U.when(lead.lastSentAt))}</span>` : '',
    ].join('');
    h += `<section class="q-lead"><h1 class="q-name">${esc(lead.name || U.fmtPhone(lead.phone))}</h1>${
      lead.name ? `<p class="q-phone">${U.fmtPhone(lead.phone)}</p>` : ''
    }${meta ? `<div class="q-meta">${meta}</div>` : ''}</section>`;

    if (pending && pending.leadId === lead.id) {
      h += `<div class="q-wait"><p>¿Se envió el mensaje a ${esc(fn)}?</p><p class="note">Si ya le diste a enviar en Mensajes, toca Sí.</p></div>`;
      h += `<div class="q-actions"><button class="btn primary big" data-act="confirm-sent">Sí, el siguiente</button><button class="btn" data-act="not-sent">No, volver</button></div></div>`;
      return h;
    }
    if (ui.editMsg) {
      h += `<div class="bubble-wrap"><textarea class="bubble bubble-edit" data-input="override" data-lead="${lead.id}" aria-label="Mensaje para ${esc(fn)}">${esc(
        text,
      )}</textarea></div><div class="links"><button class="link" data-act="edit-msg-done">Listo</button>${
        c.overrides[lead.id] != null ? `<button class="link" data-act="edit-msg-reset">Volver al mensaje de la plantilla</button>` : ''
      }</div>`;
    } else {
      h += bubble(text) + `<div class="links"><button class="link" data-act="edit-msg">Cambiar el mensaje solo para ${esc(fn)}</button></div>`;
    }
    h += `<div class="q-actions"><a class="tagbtn" href="${esc(U.smsHref(lead.phone, text))}" data-act="send" data-lead="${lead.id}">Enviar a ${esc(
      fn,
    )}</a><div class="q-sub"><button class="btn" data-act="skip">Saltar</button><button class="btn danger" data-act="dnc">No contactar</button></div></div></div>`;
    return h;
  },

  campaign({ id }) {
    const c = campaignById(id);
    if (!c) return subnav() + `<p class="note">Este envío ya no existe.</p>`;
    const st = campStats(c);
    let h = subnav() + `<h1 class="title">${esc(c.name)}</h1><p class="note">Empezó ${esc(U.when(c.createdAt))}</p>`;
    h += tally(st);
    if (st.skipped) h += `<button class="btn primary" data-act="retry-skipped">Escribirle a ${n(st.skipped, 'el saltado', 'los saltados')}</button>`;
    const RES = { sent: 'Enviado', skipped: 'Saltado', dnc: 'No contactar', gone: 'Borrado' };
    h +=
      label('Personas') +
      `<div class="group">${c.queue
        .map((lid) => {
          const l = leadById(lid);
          const r = c.results[lid];
          const name = l ? esc(l.name || U.fmtPhone(l.phone)) : 'Lead borrado';
          const pill = `<span class="pill ${r === 'sent' ? 's-cita' : r === 'dnc' ? 'dnc' : ''}">${r ? RES[r] : 'Pendiente'}</span>`;
          return l
            ? `<button class="row" data-act="open-lead" data-id="${lid}"><div class="row-main"><div class="row-title">${name}</div></div>${pill}</button>`
            : `<div class="row"><div class="row-main"><div class="row-title muted">${name}</div></div>${pill}</div>`;
        })
        .join('')}</div>`;
    h += `<button class="btn danger" data-act="delete-campaign">Borrar este envío</button><p class="note">Borrar el envío no borra los leads ni lo que les escribiste.</p>`;
    return h;
  },

  leads() {
    let h = head(
      'Leads',
      state.leads.length ? `<button class="icon-btn" data-act="add-menu" aria-label="Agregar leads">${I.plus}</button>` : '',
    );
    if (!state.leads.length) return h + emptyLeads();
    h += `<label class="search">${I.search}<input type="search" placeholder="Buscar nombre, teléfono o auto" value="${esc(
      ui.q,
    )}" data-input="leads-q" enterkeyhint="search" autocomplete="off" aria-label="Buscar leads"></label>`;
    h += `<div class="chips">${chip('Todas las listas', ui.list === '*', 'f-list', '*')}${listCounts()
      .map(([k, c]) => chip(listName(k), ui.list === k, 'f-list', k, c))
      .join('')}</div>`;
    const dnc = state.leads.some((l) => l.dnc);
    h += `<div class="chips">${chip('Todos', ui.status === '*', 'f-status', '*')}${STATUSES.map(([k, v]) => chip(v, ui.status === k, 'f-status', k)).join('')}${
      dnc ? chip('No contactar', ui.status === 'dnc', 'f-status', 'dnc') : ''
    }</div>`;
    h += `<div id="lead-list">${leadListHTML()}</div>`;
    return h;
  },

  lead({ id }) {
    const l = leadById(id);
    if (!l) return subnav() + `<p class="note">Este lead ya no existe.</p>`;
    let h = subnav();
    h += `<h1 class="title lead-name">${esc(l.name || 'Sin nombre')}</h1><p class="q-phone" id="lead-phone">${U.fmtPhone(l.phone)}</p>`;
    h += `<div class="duo"><a class="btn" href="tel:${esc(l.phone)}">${I.phone}Llamar</a><a class="btn" href="${esc(U.smsHref(l.phone, ''))}">${I.message}Escribir</a></div>`;
    if (l.dnc) h += `<div class="warn">Pidió no recibir mensajes. No sale en los envíos.</div>`;
    h += label('Estado') + `<div class="chips wrap">${STATUSES.map(([k, v]) => chip(v, l.status === k, 'set-status', k)).join('')}</div>`;
    h += `<div class="group"><label class="row toggle"><div class="row-main"><div class="row-title">No contactar</div><div class="row-sub">Si respondió STOP o te pidió que no le escribas</div></div><input type="checkbox" class="switch" data-change="dnc" ${
      l.dnc ? 'checked' : ''
    }></label></div>`;
    h +=
      label('Datos') +
      `<div class="group">${field('Nombre', 'name', l.name)}${field('Teléfono', 'phone', U.fmtPhone(l.phone), 'tel')}${field(
        'Auto de interés',
        'vehicle',
        l.vehicle,
      )}${field('Lista', 'list', l.list, 'text', 'list="lists"')}${field(
        'Correo',
        'email',
        l.email,
        'email',
      )}<label class="field"><span>Notas</span><textarea data-change="lead-field" data-f="notes" rows="3">${esc(l.notes)}</textarea></label></div>${listsDatalist()}`;
    h += label('Mensajes enviados');
    h += l.history.length
      ? `<div class="group">${[...l.history]
          .reverse()
          .map(
            (m) =>
              `<div class="row hist"><div class="row-main"><div class="row-sub">${esc(U.when(m.t))}${
                m.campaign ? `, ${esc(m.campaign)}` : ''
              }</div><p class="hist-text">${esc(m.text)}</p></div></div>`,
          )
          .join('')}</div>`
      : `<p class="note">Todavía no le has escrito desde la app.</p>`;
    h += `<button class="btn danger" data-act="delete-lead">Borrar lead</button>`;
    return h;
  },

  addLead() {
    return (
      subnav('Cancelar') +
      `<h1 class="title">Agregar lead</h1><div class="group">
      <label class="field"><span>Nombre</span><input id="add-name" type="text" autocomplete="off"></label>
      <label class="field"><span>Teléfono</span><input id="add-phone" type="tel" autocomplete="off"></label>
      <label class="field"><span>Auto de interés</span><input id="add-vehicle" type="text" autocomplete="off"></label>
      <label class="field"><span>Lista</span><input id="add-list" type="text" list="lists" autocomplete="off" value="${esc(
        ui.list !== '*' ? ui.list : '',
      )}"></label>
      <label class="field"><span>Notas</span><textarea id="add-notes" rows="2"></textarea></label>
    </div>${listsDatalist()}<div class="sticky"><button class="btn primary big" data-act="save-new-lead">Guardar lead</button></div>`
    );
  },

  paste() {
    return (
      subnav() +
      `<h1 class="title">Pegar una lista</h1><p class="note">Un lead por línea, con el nombre y el teléfono. También puedes copiar filas de Excel o Google Sheets y pegarlas aquí.</p>
      <div class="group"><textarea class="paste" data-input="paste" aria-label="Lista de leads" placeholder="Juan Pérez 305-555-1234 Tucson&#10;María López, (786) 555-0199">${esc(
        ui.pasteText,
      )}</textarea></div><div class="sticky"><button class="btn primary big" data-act="paste-go">Continuar</button></div>`
    );
  },

  importMap() {
    const d = importDraft;
    if (!d) return subnav() + `<p class="note">No hay nada que importar.</p>`;
    const res = buildLeads(d.table, d.map, state.leads.map((l) => l.phone));
    const sample = (i) => {
      const v = d.table.rows.map((r) => r[i]).find((x) => x);
      return v ? `: ${v.length > 22 ? v.slice(0, 21) + '…' : v}` : '';
    };
    const mapField = (lbl, key) =>
      `<label class="field select"><span>${esc(lbl)}</span><select data-change="map" data-k="${key}"><option value="-1">${
        key === 'phone' ? 'Escoge una columna' : 'No viene'
      }</option>${d.table.header
        .map((hd, i) => `<option value="${i}" ${d.map[key] === i ? 'selected' : ''}>${esc(hd + sample(i))}</option>`)
        .join('')}</select></label>`;
    let h = subnav('Cancelar') + `<h1 class="title">Revisa antes de importar</h1><p class="note">${esc(d.source)}, ${n(d.table.rows.length, 'fila', 'filas')}</p>`;
    const lines = [`<li><b>${res.fresh.length}</b> ${res.fresh.length === 1 ? 'nuevo' : 'nuevos'}</li>`];
    if (res.dups) lines.push(`<li><b>${res.dups}</b> ${res.dups === 1 ? 'repetido, no se duplica' : 'repetidos, no se duplican'}</li>`);
    if (res.bad) lines.push(`<li><b>${res.bad}</b> sin teléfono válido, se quedan fuera</li>`);
    h += `<ul class="tally small">${lines.join('')}</ul>`;
    h +=
      label('¿Qué hay en cada columna?') +
      `<div class="group">${mapField('Nombre', 'name')}${mapField('Apellido, si viene aparte', 'last')}${mapField('Teléfono', 'phone')}${mapField(
        'Auto de interés',
        'vehicle',
      )}${mapField('Correo', 'email')}</div>`;
    h +=
      label('Guardar en la lista') +
      `<div class="group"><label class="field"><span>Nombre de la lista</span><input type="text" value="${esc(
        d.listName,
      )}" data-input="import-list" list="lists" autocomplete="off"></label></div>${listsDatalist()}<p class="note">Con listas puedes escribirle solo a un grupo, por ejemplo a los de Facebook de octubre.</p>`;
    if (res.fresh.length)
      h +=
        label('Así se van a guardar') +
        `<div class="group">${res.fresh
          .slice(0, 3)
          .map(
            (f) =>
              `<div class="row"><div class="row-main"><div class="row-title">${esc(f.name || U.fmtPhone(f.phone))}</div><div class="row-sub">${
                f.name ? `<span>${U.fmtPhone(f.phone)}</span>` : ''
              }${f.vehicle ? `<span>${esc(f.vehicle)}</span>` : ''}</div></div></div>`,
          )
          .join('')}</div>`;
    h += `<div class="sticky"><button class="btn primary big" data-act="do-import" ${res.fresh.length ? '' : 'disabled'}>${
      res.fresh.length ? `Importar ${n(res.fresh.length, 'lead', 'leads')}` : 'Nada nuevo para importar'
    }</button></div>`;
    return h;
  },

  plantillas() {
    let h = head('Plantillas', `<button class="icon-btn" data-act="new-template" aria-label="Nueva plantilla">${I.plus}</button>`);
    h += `<p class="note">Escribe el mensaje una vez; la app le pone el nombre y el auto de cada lead.</p>`;
    if (!state.templates.length) return h + `<button class="btn primary" data-act="new-template">Escribir una plantilla</button>`;
    const sl = sampleLead();
    h += `<div class="group">${state.templates
      .map(
        (t) =>
          `<button class="row" data-act="edit-template" data-id="${t.id}"><div class="row-main"><div class="row-title">${esc(
            t.name || 'Sin nombre',
          )}</div><div class="row-sub clamp">${esc(U.renderMessage({ ...t, optOut: '' }, sl, state.settings))}</div></div>${I.chev}</button>`,
      )
      .join('')}</div>`;
    return h;
  },

  tpl({ id }) {
    const t = templateById(id);
    if (!t) return subnav() + `<p class="note">Esta plantilla ya no existe.</p>`;
    const sl = sampleLead();
    let h = subnav() + `<h1 class="title">${t._new ? 'Nueva plantilla' : 'Editar plantilla'}</h1>`;
    h += `<div class="group"><label class="field"><span>Nombre de la plantilla</span><input type="text" value="${esc(
      t.name,
    )}" data-input="tpl-name" placeholder="Ej. Seguimiento" autocomplete="off"></label></div>`;
    h += label('Mensaje');
    h += `<div class="group"><textarea class="tpl-body" id="tpl-body" data-input="tpl-body" rows="7" aria-label="Mensaje" placeholder="¡Hola {primer_nombre}! Soy {mi_nombre} de {concesionario}…">${esc(
      t.body,
    )}</textarea></div>`;
    h += `<p class="note">Toca para poner los datos de cada lead:</p><div class="chips wrap">${U.VARS.map(([k, v]) => chip(v, false, 'insert-var', k)).join('')}</div>`;
    h += `<div id="tpl-fallback">${fallbackField(t)}</div>`;
    h +=
      label('Aviso para salir al final') +
      `<div class="seg" role="group" aria-label="Aviso para salir">${[
        ['es', 'Español'],
        ['en', 'English'],
        ['', 'Ninguno'],
      ]
        .map(([k, v]) => `<button data-act="tpl-optout" data-k="${k}" aria-pressed="${(t.optOut || '') === k}">${v}</button>`)
        .join('')}</div>`;
    h += label(`Así le llega a ${who(sl)}`) + `<div id="tpl-preview">${tplPreview(t, sl)}</div>`;
    h += `<button class="btn danger" data-act="delete-template">Borrar plantilla</button>`;
    return h;
  },

  ajustes() {
    const s = state.settings;
    const sf = (lbl, key, ph = '') =>
      `<label class="field"><span>${esc(lbl)}</span><input type="text" value="${esc(s[key])}" data-input="setting" data-k="${key}" placeholder="${esc(
        ph,
      )}" autocomplete="off"></label>`;
    const tg = (title, sub, key) =>
      `<label class="row toggle"><div class="row-main"><div class="row-title">${esc(title)}</div>${
        sub ? `<div class="row-sub">${esc(sub)}</div>` : ''
      }</div><input type="checkbox" class="switch" data-change="setting-bool" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    let h = head('Ajustes');
    h += label('Firma de tus mensajes') + `<div class="group">${sf('Tu nombre', 'myName', 'Ej. Adrian')}${sf('Concesionario', 'dealer', 'Nombre del concesionario')}</div>`;
    h += label('Aviso para salir') + `<div class="group">${sf('En español', 'optOutEs')}${sf('In English', 'optOutEn')}</div>`;
    h +=
      label('Reglas de envío') +
      `<div class="group">${tg('Saltar a quien ya le escribí hoy', 'No incluye a quien recibió un mensaje en las últimas 24 horas', 'skip24h')}${tg(
        'Avisarme fuera de horario',
        'Antes de las 8 am o después de las 8 pm',
        'quietWarn',
      )}</div>`;
    h += `<p class="note">En Florida, los mensajes de venta solo se pueden mandar de 8 am a 8 pm, máximo 3 en 24 horas a la misma persona sobre lo mismo, y a quien responda STOP no se le puede volver a escribir.</p>`;
    h += label('Tus leads');
    h += `<p class="note">Se guardan solo en este teléfono, no en internet. Guarda un respaldo de vez en cuando por si cambias de teléfono.</p>`;
    h += `<div class="group"><button class="row" data-act="backup"><div class="row-main"><div class="row-title">Guardar respaldo</div></div>${I.chev}</button><button class="row" data-act="restore"><div class="row-main"><div class="row-title">Restaurar un respaldo</div></div>${I.chev}</button><button class="row" data-act="export-csv"><div class="row-main"><div class="row-title">Exportar leads a CSV</div><div class="row-sub">Se abre en Excel o Google Sheets</div></div>${I.chev}</button></div>`;
    h += `<div class="group"><button class="row danger" data-act="wipe"><div class="row-main"><div class="row-title">Borrar todo</div></div></button></div>`;
    h += `<p class="note center">${n(state.leads.length, 'lead', 'leads')}, ${n(state.templates.length, 'plantilla', 'plantillas')}, ${n(
      state.campaigns.length,
      'envío',
      'envíos',
    )}</p>`;
    return h;
  },
};

function campRow(c) {
  const st = campStats(c);
  const sub = c.finishedAt ? `${st.sent} de ${c.queue.length} enviados` : `Vas por ${st.done} de ${c.queue.length}`;
  return `<button class="row" data-act="open-campaign" data-id="${c.id}"><div class="row-main"><div class="row-title">${esc(
    c.name,
  )}</div><div class="row-sub">${sub}</div></div>${c.finishedAt ? '' : '<span class="pill s-nuevo">Seguir</span>'}${I.chev}</button>`;
}

function tally(st) {
  const li = [`<li><b>${st.sent}</b> ${st.sent === 1 ? 'enviado' : 'enviados'}</li>`];
  if (st.skipped) li.push(`<li><b>${st.skipped}</b> ${st.skipped === 1 ? 'saltado' : 'saltados'}</li>`);
  if (st.dnc) li.push(`<li><b>${st.dnc}</b> no contactar</li>`);
  return `<ul class="tally">${li.join('')}</ul>`;
}

function doneView(c, st) {
  let h = '<div class="q">' + subnav('Envíos');
  h += `<section class="done"><div class="done-mark">${I.check}</div><h1 class="q-name">Listo</h1><p class="note">${esc(c.name)}</p>${tally(st)}</section>`;
  h += `<div class="q-actions">`;
  if (st.skipped) h += `<button class="btn primary big" data-act="retry-skipped">Escribirle a ${n(st.skipped, 'el saltado', 'los saltados')}</button>`;
  h += `<button class="btn ${st.skipped ? '' : 'primary big'}" data-act="home">Volver a Enviar</button></div></div>`;
  return h;
}

function sampleLead() {
  return (
    state.leads.find((l) => l.name && l.vehicle && !l.dnc) ||
    state.leads.find((l) => l.name) || { name: 'María González', vehicle: 'Tucson 2025', phone: '+13055550123' }
  );
}

const fallbackField = (t) =>
  /\{auto\}/.test(t.body)
    ? `<div class="group"><label class="field"><span>Si el lead no tiene auto guardado, escribir</span><input type="text" value="${esc(
        t.autoFallback,
      )}" data-input="tpl-fallback" placeholder="carro" autocomplete="off"></label></div>`
    : '';

function tplPreview(t, sl) {
  const text = U.renderMessage(t, sl, state.settings);
  return text ? bubble(text) + `<p class="note">${n(text.length, 'carácter', 'caracteres')}</p>` : `<p class="note">Escribe el mensaje arriba.</p>`;
}

function listFromFile(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : `Importados ${U.shortDate(Date.now())}`;
}

function newTemplate() {
  const t = { id: U.uid(), name: '', body: '', optOut: 'es', autoFallback: 'carro', _new: true };
  state.templates.push(t);
  return t;
}

// ---------- Después de pintar / al salir ----------
const AFTER = {
  queue() {
    const ta = $view.querySelector('.bubble-edit');
    if (ta) {
      ta.style.height = ta.scrollHeight + 'px';
      ta.focus();
    }
  },
  tpl({ id }) {
    const t = templateById(id);
    if (t && t._new && !t.body) $view.querySelector('#tpl-body')?.focus();
  },
  addLead() {
    $view.querySelector('#add-name')?.focus();
  },
};

const LEAVE = {
  tpl({ id }) {
    const t = templateById(id);
    if (!t) return;
    if (!t.body.trim()) {
      state.templates = state.templates.filter((x) => x !== t);
      if (ui.camp && ui.camp.templateId === id) ui.camp.templateId = state.templates[0] && state.templates[0].id;
      if (!t._new) toast('La plantilla quedó vacía y se borró');
    } else {
      delete t._new;
      if (!t.name.trim()) t.name = t.body.trim().split(/\s+/).slice(0, 4).join(' ');
    }
    save('templates');
  },
  importMap() {
    importDraft = null;
  },
};

// ---------- Acciones ----------
const ACT = {
  tab: (el) => setTab(el.dataset.tab),
  back: () => back(),
  home: () => setTab('enviar'),
  'close-sheet': (el, e) => {
    if (el.classList.contains('sheet-bg') && e.target !== el) return;
    closeSheet();
  },
  'sheet-item': (el) => {
    const it = sheetItems[Number(el.dataset.i)];
    closeSheet();
    it && it.run();
  },
  'hide-install': () => {
    state.settings.hideInstall = true;
    save('settings');
    render();
  },

  // Agregar leads
  'add-menu': () =>
    sheet(
      [
        { label: 'Importar Excel o CSV', run: () => ACT['pick-file']() },
        { label: 'Pegar una lista', run: () => ACT.paste() },
        { label: 'Agregar uno a mano', run: () => ACT['add-lead']() },
      ],
      'Agregar leads',
    ),
  'pick-file': () => {
    $fileIn.value = '';
    $fileIn.click();
  },
  paste: () => go('paste'),
  'add-lead': () => go('addLead'),
  'paste-go': () => {
    const table = parsePasted(ui.pasteText);
    if (!table.rows.length) return toast('Pega al menos un nombre con su teléfono');
    importDraft = { source: 'Lista pegada', table, map: guessMapping(table), listName: `Lista ${U.shortDate(Date.now())}` };
    go('importMap');
  },
  'do-import': () => {
    const d = importDraft;
    if (!d) return;
    const res = buildLeads(d.table, d.map, state.leads.map((l) => l.phone));
    const list = d.listName.trim();
    const base = Date.now();
    res.fresh.forEach((f, i) => state.leads.push(newLead({ ...f, list, createdAt: base + i / 1000 })));
    save('leads');
    importDraft = null;
    ui.pasteText = '';
    ui.list = list;
    ui.status = '*';
    ui.q = '';
    ui.limit = 150;
    nav.tab = 'leads';
    nav.stack = [];
    render();
    toast(`Importaste ${n(res.fresh.length, 'lead', 'leads')}`);
  },
  'save-new-lead': () => {
    const v = (id) => ($view.querySelector('#' + id)?.value || '').trim();
    const phone = U.normPhone(v('add-phone'));
    if (!phone) return toast('Escribe un teléfono válido, por ejemplo 305 555 1234');
    if (state.leads.some((l) => l.phone === phone)) return toast('Ya tienes un lead con ese teléfono');
    state.leads.push(newLead({ name: U.tidyName(v('add-name')), phone, vehicle: v('add-vehicle'), list: v('add-list'), notes: v('add-notes') }));
    save('leads');
    back();
    toast('Lead guardado');
  },

  // Lista de leads
  'f-list': (el) => {
    ui.list = el.dataset.k;
    ui.limit = 150;
    render();
  },
  'f-status': (el) => {
    ui.status = el.dataset.k;
    ui.limit = 150;
    render();
  },
  more: () => {
    ui.limit += 300;
    document.getElementById('lead-list').innerHTML = leadListHTML();
  },
  'delete-list': () => {
    const count = state.leads.filter((l) => (l.list || '') === ui.list).length;
    if (!confirm(`¿Borrar la lista "${listName(ui.list)}" y sus ${n(count, 'lead', 'leads')}? No se puede deshacer.`)) return;
    state.leads = state.leads.filter((l) => (l.list || '') !== ui.list);
    ui.list = '*';
    save('leads');
    render();
    toast('Lista borrada');
  },
  'open-lead': (el) => go('lead', { id: el.dataset.id }),
  'set-status': (el) => {
    const l = leadById(current().params.id);
    l.status = el.dataset.k;
    save('leads');
    render();
  },
  'delete-lead': () => {
    const l = leadById(current().params.id);
    if (!confirm(`¿Borrar a ${l.name || U.fmtPhone(l.phone)}?`)) return;
    state.leads = state.leads.filter((x) => x !== l);
    save('leads');
    back();
    toast('Lead borrado');
  },

  // Envíos
  'new-campaign': () => {
    const prevTpl = ui.camp && templateById(ui.camp.templateId);
    ui.camp = {
      lists: new Set(ui.camp ? ui.camp.lists : []),
      statuses: new Set(ui.camp ? ui.camp.statuses : DEFAULT_AUDIENCE),
      templateId: (prevTpl || state.templates[0] || {}).id,
    };
    for (const k of ui.camp.lists) if (!state.leads.some((l) => (l.list || '') === k)) ui.camp.lists.delete(k);
    go('newCampaign');
  },
  'camp-list': (el) => {
    const k = el.dataset.k;
    const s = ui.camp.lists;
    if (k === '*') s.clear();
    else if (s.has(k)) s.delete(k);
    else s.add(k);
    render();
  },
  'camp-status': (el) => {
    const s = ui.camp.statuses;
    const k = el.dataset.k;
    if (s.has(k)) s.delete(k);
    else s.add(k);
    render();
  },
  'camp-tpl': (el) => {
    ui.camp.templateId = el.dataset.id;
    render();
  },
  'start-campaign': () => {
    const d = ui.camp;
    const tpl = templateById(d.templateId);
    const aud = audience(d);
    if (!tpl || !aud.leads.length) return;
    const c = {
      id: U.uid(),
      name: `${tpl.name || 'Mensaje'}, ${U.shortDate(Date.now())}`,
      templateId: tpl.id,
      body: tpl.body,
      optOut: tpl.optOut,
      autoFallback: tpl.autoFallback,
      createdAt: Date.now(),
      queue: aud.leads.map((l) => l.id),
      results: {},
      overrides: {},
      finishedAt: null,
    };
    state.campaigns.unshift(c);
    save('campaigns');
    ui.editMsg = false;
    replace('queue', { id: c.id });
  },
  'open-campaign': (el) => {
    const c = campaignById(el.dataset.id);
    if (!c) return;
    ui.editMsg = false;
    go(c.finishedAt ? 'campaign' : 'queue', { id: c.id });
  },
  send: (el, e) => {
    const c = campaignById(current().params.id);
    const lead = leadById(el.dataset.lead);
    if (!c || !lead) return e.preventDefault();
    setPending({ campaignId: c.id, leadId: lead.id, text: messageFor(c, lead), left: false, at: Date.now() });
    ui.editMsg = false;
    flush();
    if (TEST) {
      e.preventDefault();
      window.__lastSms = el.getAttribute('href');
    }
    // El enlace abre Mensajes. Al volver a la app se marca como enviado.
    setTimeout(() => pending && current().view === 'queue' && render(), 700);
  },
  'confirm-sent': () => confirmSent(),
  'not-sent': () => {
    setPending(null);
    render();
  },
  skip: () => markCurrent('skipped'),
  dnc: () => markCurrent('dnc'),
  'edit-msg': () => {
    ui.editMsg = true;
    render();
  },
  'edit-msg-done': () => {
    ui.editMsg = false;
    render();
  },
  'edit-msg-reset': () => {
    const c = campaignById(current().params.id);
    const idx = nextIndex(c);
    if (idx >= 0) delete c.overrides[c.queue[idx]];
    ui.editMsg = false;
    save('campaigns');
    render();
  },
  'retry-skipped': () => {
    const c = campaignById(current().params.id);
    for (const id of c.queue) if (c.results[id] === 'skipped') delete c.results[id];
    finishIfDone(c);
    save('campaigns');
    if (current().view === 'campaign') replace('queue', { id: c.id });
    else render();
  },
  'delete-campaign': () => {
    const c = campaignById(current().params.id);
    if (!confirm(`¿Borrar el envío "${c.name}"?`)) return;
    state.campaigns = state.campaigns.filter((x) => x !== c);
    save('campaigns');
    back();
  },

  // Plantillas
  'new-template': () => {
    const t = newTemplate();
    if (ui.camp && current().view === 'newCampaign') ui.camp.templateId = t.id;
    go('tpl', { id: t.id });
  },
  'edit-template': (el) => go('tpl', { id: el.dataset.id }),
  'insert-var': (el) => {
    const ta = $view.querySelector('#tpl-body');
    if (!ta) return;
    const tok = `{${el.dataset.k}}`;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    ta.setRangeText(pad + tok, start, end, 'end');
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  },
  'tpl-optout': (el) => {
    const t = templateById(current().params.id);
    t.optOut = el.dataset.k;
    save('templates');
    $view.querySelectorAll('[data-act="tpl-optout"]').forEach((b) => b.setAttribute('aria-pressed', b === el));
    $view.querySelector('#tpl-preview').innerHTML = tplPreview(t, sampleLead());
  },
  'delete-template': () => {
    const t = templateById(current().params.id);
    if (!t._new && !confirm(`¿Borrar la plantilla "${t.name || 'Sin nombre'}"?`)) return;
    state.templates = state.templates.filter((x) => x !== t);
    if (ui.camp && ui.camp.templateId === t.id) ui.camp.templateId = state.templates[0] && state.templates[0].id;
    save('templates');
    nav.stack.pop();
    render();
  },

  // Ajustes y datos
  backup: () => {
    const data = {
      app: 'mensajero',
      version: 1,
      exportedAt: new Date().toISOString(),
      leads: state.leads,
      templates: state.templates,
      campaigns: state.campaigns,
      settings: state.settings,
    };
    const day = new Date().toISOString().slice(0, 10);
    U.shareOrDownload(`mensajero-respaldo-${day}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  },
  restore: () => {
    $backupIn.value = '';
    $backupIn.click();
  },
  'export-csv': () => {
    const rows = [['Nombre', 'Teléfono', 'Auto de interés', 'Lista', 'Estado', 'No contactar', 'Correo', 'Notas', 'Último mensaje']];
    for (const l of state.leads)
      rows.push([
        l.name,
        U.fmtPhone(l.phone),
        l.vehicle,
        l.list,
        STATUS_LABEL[l.status] || l.status,
        l.dnc ? 'Sí' : '',
        l.email,
        l.notes,
        l.lastSentAt ? new Date(l.lastSentAt).toLocaleString('es-US') : '',
      ]);
    const day = new Date().toISOString().slice(0, 10);
    U.shareOrDownload(`leads-${day}.csv`, new Blob([U.toCSV(rows)], { type: 'text/csv' }));
  },
  wipe: () => {
    if (!confirm('¿Borrar todos los leads, plantillas y envíos de este teléfono? No se puede deshacer.')) return;
    replaceAll({ templates: seedTemplates(), settings: state.settings });
    ui.list = '*';
    ui.status = '*';
    ui.camp = null;
    flush();
    render();
    toast('Se borró todo');
  },
};

const INPUT = {
  'leads-q': (el) => {
    ui.q = el.value;
    ui.limit = 150;
    document.getElementById('lead-list').innerHTML = leadListHTML();
  },
  paste: (el) => {
    ui.pasteText = el.value;
  },
  'import-list': (el) => {
    if (importDraft) importDraft.listName = el.value;
  },
  override: (el) => {
    const c = campaignById(current().params.id);
    c.overrides[el.dataset.lead] = el.value;
    save('campaigns');
    const lead = leadById(el.dataset.lead);
    const a = $view.querySelector('.tagbtn');
    if (a && lead) a.setAttribute('href', U.smsHref(lead.phone, el.value));
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  },
  'tpl-name': (el) => {
    templateById(current().params.id).name = el.value;
    save('templates');
  },
  'tpl-body': (el) => {
    const t = templateById(current().params.id);
    const hadAuto = /\{auto\}/.test(t.body);
    t.body = el.value;
    save('templates');
    if (hadAuto !== /\{auto\}/.test(t.body)) $view.querySelector('#tpl-fallback').innerHTML = fallbackField(t);
    $view.querySelector('#tpl-preview').innerHTML = tplPreview(t, sampleLead());
  },
  'tpl-fallback': (el) => {
    const t = templateById(current().params.id);
    t.autoFallback = el.value;
    save('templates');
    $view.querySelector('#tpl-preview').innerHTML = tplPreview(t, sampleLead());
  },
  setting: (el) => {
    state.settings[el.dataset.k] = el.value;
    save('settings');
  },
};

const CHANGE = {
  'lead-field': (el) => {
    const l = leadById(current().params.id);
    if (!l) return;
    const f = el.dataset.f;
    const v = el.value.trim();
    if (f === 'phone') {
      const p = U.normPhone(v);
      if (!p) {
        toast('Ese teléfono no es válido');
        el.value = U.fmtPhone(l.phone);
        return;
      }
      if (state.leads.some((x) => x.phone === p && x !== l)) {
        toast('Ya tienes otro lead con ese teléfono');
        el.value = U.fmtPhone(l.phone);
        return;
      }
      l.phone = p;
      el.value = U.fmtPhone(p);
      $view.querySelector('#lead-phone').textContent = U.fmtPhone(p);
    } else if (f === 'name') {
      l.name = v;
      $view.querySelector('.lead-name').textContent = v || 'Sin nombre';
    } else l[f] = f === 'notes' ? el.value : v;
    save('leads');
  },
  dnc: (el) => {
    const l = leadById(current().params.id);
    l.dnc = el.checked;
    save('leads');
    render();
  },
  map: (el) => {
    importDraft.map[el.dataset.k] = Number(el.value);
    render();
  },
  'setting-bool': (el) => {
    state.settings[el.dataset.k] = el.checked;
    save('settings');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && INPUT[el.dataset.input]) INPUT[el.dataset.input](el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $sheet.firstChild) closeSheet();
});

// Al volver de Mensajes, el mensaje se da por enviado
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (pending) pending.left = true;
    flush();
  } else if (pending && pending.left) confirmSent();
});
window.addEventListener('pagehide', () => flush());

$fileIn.addEventListener('change', async () => {
  const f = $fileIn.files && $fileIn.files[0];
  if (!f) return;
  try {
    const raw = await readTableFile(f);
    const table = toTable(raw);
    if (!table.rows.length) throw new Error('EMPTY');
    importDraft = { source: f.name, table, map: guessMapping(table), listName: listFromFile(f.name) };
    go('importMap');
  } catch (err) {
    const msg =
      {
        NUMBERS: 'Ese archivo es de Numbers. Ábrelo y expórtalo como Excel o CSV.',
        OLD_XLS: 'Ese Excel es del formato viejo (.xls). Guárdalo como .xlsx o CSV.',
        NO_INFLATE: 'Para abrir Excel necesitas iOS 16.4 o más nuevo. Guarda el archivo como CSV.',
        EMPTY: 'El archivo no tiene filas.',
      }[err && err.message] || 'No se pudo leer el archivo. Guárdalo como CSV y prueba otra vez.';
    toast(msg);
  }
});

$backupIn.addEventListener('change', async () => {
  const f = $backupIn.files && $backupIn.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'mensajero' || !Array.isArray(data.leads)) throw new Error('BAD');
    if (!confirm(`Esto cambia lo que tienes ahora (${n(state.leads.length, 'lead', 'leads')}) por el respaldo (${n(data.leads.length, 'lead', 'leads')}). ¿Seguir?`))
      return;
    replaceAll(data);
    await flush();
    ui.list = '*';
    ui.status = '*';
    ui.camp = null;
    render();
    toast('Respaldo restaurado');
  } catch {
    toast('Ese archivo no es un respaldo de Mensajero');
  }
});

// ---------- Arranque ----------
await load();
try {
  // Si iOS recargó la app mientras estabas en Mensajes, pregunta si se envió
  const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
  const c = saved && campaignById(saved.campaignId);
  if (c && Date.now() - saved.at < 3 * 3600 * 1000 && !c.results[saved.leadId] && leadById(saved.leadId)) {
    pending = { ...saved, left: false };
    nav.stack = [{ view: 'queue', params: { id: c.id } }];
  } else localStorage.removeItem(PENDING_KEY);
} catch {}
render();
document.documentElement.classList.add('ready');

if ('serviceWorker' in navigator && !TEST && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (TEST) window.__app = { state, render, go, setTab, ui, confirmSent, flush };
