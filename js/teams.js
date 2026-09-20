/** Encrypted teams with user-owned Firebase projects. Personal tasks never enter this transport. */
import { createFirebaseTransport } from './firebase-transport.js';
import { parseFirebaseConfig } from './firebase-config.js';
import { normalizeLogin, validateNewPassword } from './login.js';
import { openGuide } from './guide.js';
const enc = new TextEncoder(), dec = new TextDecoder();
const clone = value => JSON.parse(JSON.stringify(value));
const str = value => JSON.stringify(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => crypto.randomUUID();
export const toBase64 = bytes => {
  const array = new Uint8Array(bytes); let binary = '';
  for (let offset = 0; offset < array.length; offset += 8192) binary += String.fromCharCode(...array.subarray(offset, offset + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
export const fromBase64 = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const digest = async text => toBase64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const envelopeText = envelope => str(['NK-TEAM-EVENT-1', envelope.header, envelope.iv, envelope.cipher]);
const wrapText = wrap => str(['NK-TEAM-WRAP-1', wrap.teamId, wrap.from, wrap.to, wrap.iv, wrap.cipher]);
export async function makeIdentity(alias) {
  const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const box = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const identity = { alias: alias.slice(0, 60), sign: await crypto.subtle.exportKey('jwk', sign.publicKey), signPrivate: await crypto.subtle.exportKey('jwk', sign.privateKey), box: await crypto.subtle.exportKey('jwk', box.publicKey), boxPrivate: await crypto.subtle.exportKey('jwk', box.privateKey) };
  identity.id = await digest(str([identity.sign.x, identity.sign.y, identity.box.x, identity.box.y]));
  return identity;
}
async function sign(identity, text) {
  const key = await crypto.subtle.importKey('jwk', identity.signPrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return toBase64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(text)));
}
async function verify(publicKey, signature, text) {
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64(signature), enc.encode(text));
}
async function wrappingKey(identity, publicKey, teamId, recipient) {
  const privateKey = await crypto.subtle.importKey('jwk', identity.boxPrivate, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(teamId), info: enc.encode(`NK-TEAM-WRAP-1:${recipient}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function wrapTeamKey(identity, recipient, teamId, rawKey) {
  const key = await wrappingKey(identity, recipient.box, teamId, recipient.id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrap = { teamId, from: identity.id, to: recipient.id, iv: toBase64(iv), cipher: toBase64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(str([teamId, identity.id, recipient.id])) }, key, fromBase64(rawKey))) };
  wrap.signature = await sign(identity, wrapText(wrap));
  return wrap;
}
export async function unwrapTeamKey(identity, sender, wrap) {
  if (wrap.to !== identity.id || wrap.from !== sender.id || !await verify(sender.sign, wrap.signature, wrapText(wrap))) throw new Error('Не вдалося перевірити ключ команди.');
  const key = await wrappingKey(identity, sender.box, wrap.teamId, identity.id);
  return toBase64(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(wrap.iv), additionalData: enc.encode(str([wrap.teamId, wrap.from, wrap.to])) }, key, fromBase64(wrap.cipher)));
}
export async function sealEvent(identity, rawKey, header, body) {
  const key = await crypto.subtle.importKey('raw', fromBase64(rawKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope = { header, iv: toBase64(iv), cipher: toBase64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(str(header)) }, key, enc.encode(str(body)))) };
  envelope.signature = await sign(identity, envelopeText(envelope));
  return envelope;
}
export async function openEvent(rawKey, sender, envelope) {
  if (sender.id !== envelope.header.senderId || !await verify(sender.sign, envelope.signature, envelopeText(envelope))) throw new Error('Підпис командної події недійсний.');
  const key = await crypto.subtle.importKey('raw', fromBase64(rawKey), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: enc.encode(str(envelope.header)) }, key, fromBase64(envelope.cipher))));
}
const isAdmin = role => ['owner', 'admin'].includes(role);
const emptyTeam = id => ({ id, name: 'Команда · очікує погодження', key: null, status: 'pending', members: [], pending: [], tasks: {}, seen: {}, acks: [], delivery: {} });
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localTime = () => new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateLabel = value => value ? new Date(value).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'medium' }) : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const validAt = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validTitle = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export function validTask(task) {
  if (!task || !validId(task.id) || !validTitle(task.title) || !validId(task.creator) || !validId(task.assignee) || !Number.isInteger(task.version) || task.version < 1 || typeof task.done !== 'boolean' || !validDate(task.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.time)) return false;
  if (!Array.isArray(task.steps) || task.steps.length > 12 || new Set(task.steps.map(s => s?.id)).size !== task.steps.length || task.steps.some(s => !s || !validId(s.id) || !validTitle(s.title) || !validId(s.assignee) || typeof s.done !== 'boolean' || (s.done ? !validAt(s.completedAt) : s.completedAt !== null))) return false;
  if (task.done ? !validAt(task.completedAt) || task.steps.some(s => !s.done) : task.completedAt !== null) return false;
  return Array.isArray(task.history) && task.history.length > 0 && task.history.length <= 2000 && task.history.every(h => h && validId(h.actor) && validAt(h.at) && ['task-create', 'task-step', 'task-complete'].includes(h.kind) && (h.kind === 'task-create' || typeof h.done === 'boolean') && (h.kind !== 'task-step' || validId(h.stepId)));
}
async function validateMember(member) {
  if (!member || !validId(member.id) || typeof member.alias !== 'string' || member.alias.length > 60 || !member.sign || !member.box || member.sign.d || member.box.d || !['owner', 'admin', 'member', undefined].includes(member.role)) throw new Error('Некоректна ідентичність учасника.');
  const id = await digest(str([member.sign.x, member.sign.y, member.box.x, member.box.y]));
  if (id !== member.id) throw new Error('Відкритий ключ учасника не відповідає його відбитку.');
}
async function validateState(saved) {
  await validateMember(saved.identity);
  if (!saved.identity.signPrivate?.d || !saved.identity.boxPrivate?.d || !saved.teams || Array.isArray(saved.teams) || saved.outbox.length > 100) throw new Error('Некоректне сховище команд.');
  for (const [id, team] of Object.entries(saved.teams)) {
    if (!validId(id) || team.id !== id || typeof team.name !== 'string' || team.name.length > 80 || !['pending', 'approved'].includes(team.status) || !(team.key === null || typeof team.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(team.key)) || !Array.isArray(team.members) || !Array.isArray(team.pending) || !team.tasks || !team.seen || !Array.isArray(team.acks) || !team.delivery || Object.entries(team.tasks).some(([taskId, task]) => taskId !== task.id || !validTask(task))) throw new Error('Некоректні збережені дані команди.');
    if (team.quarantine && (typeof team.quarantine !== 'object' || Array.isArray(team.quarantine) || Object.keys(team.quarantine).length > 200)) throw new Error('Некоректний список недоставлених подій.');
    for (const person of [...team.members, ...team.pending]) await validateMember(person);
  }
  if (saved.outbox.some(item => !item?.envelope?.header || !validId(item.envelope.header.id) || !validId(item.envelope.header.teamId))) throw new Error('Некоректна черга командних подій.');
}
/** Pending applicants are untrusted until both their fingerprint and admin approval are checked. */
export async function verifyTeamRoster(metadata, identityId, check = () => {}) {
  if (!metadata || !validId(metadata.id) || !['pending', 'approved'].includes(metadata.status) || !Array.isArray(metadata.members) || !Array.isArray(metadata.pending) || metadata.members.length + metadata.pending.length > 30) throw new Error('Некоректний склад команди.');
  for (const person of metadata.members) {
    if (!['owner', 'admin', 'member'].includes(person?.role)) throw new Error('Не вдалося перевірити права учасника.');
    await validateMember(person); check();
  }
  if (new Set(metadata.members.map(m => m.id)).size !== metadata.members.length || (metadata.status === 'approved' && !metadata.members.some(m => m.id === identityId))) throw new Error('Не вдалося перевірити склад команди.');
  const pending = [], ids = new Set(); let invalidPending = 0;
  for (const person of metadata.pending) {
    try {
      await validateMember(person); check();
      if (ids.has(person.id) || metadata.members.some(m => m.id === person.id)) throw new Error('Повторна заявка.');
      ids.add(person.id); pending.push(person);
    } catch (problem) { check(); if (problem?.name === 'AbortError') throw problem; invalidPending++; }
  }
  return { ...metadata, pending, invalidPending };
}
/** Isolate damaged messages without acknowledging or applying their contents. */
export async function receiveTeamMessages(savedTeam, identityId, messages, apply, check = () => {}) {
  let team = clone(savedTeam);
  team.quarantine ||= {};
  const accepted = [];
  for (const item of messages) {
    check();
    const envelope = item?.envelope, h = envelope?.header;
    const messageId = validId(h?.id) ? h.id : `invalid_${await digest(str(item))}`;
    try {
      if (!h || !validId(h.id) || !validId(h.taskId) || h.teamId !== team.id || h.epoch !== 1 || !Array.isArray(h.recipients) || !h.recipients.includes(identityId) || await digest(envelopeText(envelope)) !== item.hash) throw new Error('Конверт команди пошкоджено.');
      check();
      if (team.seen[h.id] && team.seen[h.id] !== item.hash) throw new Error('Повторна подія має інший вміст.');
      const next = clone(team);
      if (!next.seen[h.id]) {
        const sender = next.members.find(m => m.id === h.senderId);
        if (!sender) throw new Error('Відправника немає у команді.');
        const body = await openEvent(next.key, sender, envelope);
        check();
        apply(next, h, body, sender);
        next.seen[h.id] = item.hash;
      }
      delete next.quarantine[messageId];
      if (!next.acks.some(a => a.id === h.id)) next.acks.push({ id: h.id, teamId: next.id, epoch: 1, hash: item.hash, recipient: identityId });
      accepted.push(h.id); team = next;
    } catch (problem) {
      check();
      if (problem?.name === 'AbortError') throw problem;
      // A bad signature or missing version is not a receipt. Keep retrying after snapshots.
      if (Object.keys(team.quarantine).length < 200 || Object.hasOwn(team.quarantine, messageId)) {
        team.quarantine[messageId] = { hash: typeof item?.hash === 'string' ? item.hash.slice(0, 100) : null, taskId: validId(h?.taskId) ? h.taskId : null, reason: String(problem?.message || 'Некоректна подія.').slice(0, 300) };
      }
    }
  }
  return { team, accepted };
}
export function createTeamsController({ root, getSession, readState, saveState, onChange = () => {}, toast = () => {}, isBusy = () => false }) {
  let active = false, session = null, generation = 0, state = null, working = false, timer = null, aborter = null;
  let selected = null, mode = 'list', filter = 'mine', status = '', error = '', invitation = null;
  let workspace = null, projectId = null, transport = null, cloudUser = null;
  const check = epoch => { if (!active || generation !== epoch || getSession() !== session) throw new DOMException('Сеанс завершено.', 'AbortError'); };
  const currentTeam = () => state?.teams[selected];
  const roleFor = team => team.members.find(m => m.id === state.identity.id)?.role;
  const memberName = (team, id) => team.members.find(m => m.id === id)?.alias || 'Учасник';
  async function persist(next, epoch) {
    check(epoch);
    const saved = { ...workspace, activeProject: projectId, projects: { ...workspace.projects, [projectId]: next } };
    await saveState(clone(saved));
    check(epoch);
    workspace = saved; state = next;
    onChange();
  }
  async function rpc(action, payload, epoch) {
    check(epoch);
    if (!transport?.authStatus()) throw new Error('Увійдіть у Firebase для синхронізації. Локальна історія збережена.');
    const result = await transport.rpc(action, payload);
    check(epoch);
    return result;
  }
  function showError(problem) {
    if (problem?.name === 'AbortError') return;
    error = problem instanceof TypeError ? 'Не вдалося підключитися до Firebase. Перевірте інтернет і налаштування бази. Локальна історія та черга збережені.' : problem.message;
  }
  async function run(operation) {
    if (working || isBusy() || !active) return;
    const epoch = generation, hadFirebaseSession = Boolean(cloudUser || transport?.authStatus());
    let forceRender = false;
    working = true; root.setAttribute('aria-busy', 'true'); error = '';
    try { await operation(epoch); }
    catch (problem) {
      if (epoch === generation) {
        showError(problem);
        const account = transport?.authStatus();
        if ((hadFirebaseSession && !account) || account?.mustChangePassword) {
          // Reset/disable expires cloud access, never the encrypted local space or its outbox.
          cloudUser = null; invitation = null; selected = null; status = '';
          clearPasswords(); mode = account?.mustChangePassword ? 'password' : 'auth'; forceRender = true;
        }
      }
    }
    finally { if (epoch === generation) { working = false; root.setAttribute('aria-busy', 'false'); render(forceRender); } }
  }
  async function sync(epoch) {
    for (const pending of Object.values(state.teams).filter(t => t.creationPending)) {
      await rpc('create', { teamId: pending.id }, epoch);
      const committed = clone(state); committed.teams[pending.id].creationPending = false;
      await persist(committed, epoch);
    }
    const index = await rpc('index', {}, epoch);
    let next = clone(state);
    if (next.serverId && next.serverId !== index.serverId) throw new Error('Відповідь надійшла від іншого Firebase-проєкту. Синхронізацію зупинено.');
    status = 'Синхронізовано з Firebase';
    next.isProjectOwner = index.isProjectOwner === true;
    next.serverId = index.serverId;
    for (const team of Object.values(next.teams)) team.reachable = false;
    for (const raw of index.teams) {
      try {
        const metadata = await verifyTeamRoster(raw, state.identity.id, () => check(epoch));
        const team = next.teams[metadata.id] ||= emptyTeam(metadata.id);
        const verified = { ...team, status: metadata.status, members: metadata.members, pending: metadata.pending, reachable: true, rosterError: null, invalidPending: metadata.invalidPending };
        if (!verified.key && metadata.wrap) {
          const sender = verified.members.find(m => m.id === metadata.wrap.from);
          if (!sender || !isAdmin(sender.role)) throw new Error('Ключ надійшов від непогодженого адміністратора.');
          verified.key = await unwrapTeamKey(next.identity, sender, metadata.wrap); check(epoch);
        }
        if (verified.status === 'approved' && !verified.key) throw new Error('Ключ команди відсутній. Відновіть JSON-копію початкового простору або зверніться до адміністратора.');
        next.teams[metadata.id] = verified;
      } catch (problem) {
        check(epoch); if (problem?.name === 'AbortError') throw problem;
        if (validId(raw?.id)) {
          const team = next.teams[raw.id] ||= emptyTeam(raw.id);
          team.reachable = false; team.rosterError = String(problem?.message || 'Не вдалося перевірити команду.').slice(0, 300);
        }
        status = 'Є неперевірені дані команди. Її обмін зупинено; інші команди синхронізуються.';
      }
    }
    await persist(next, epoch);
    // Outbox is committed before any send. Errors retain the original encrypted event.
    for (const queued of [...state.outbox]) {
      if (queued.failed || queued.accepted || state.teams[queued.envelope.header.teamId]?.rosterError) continue;
      try {
        await rpc('send', { envelope: queued.envelope }, epoch);
        next = clone(state);
        if (queued.envelope.header.kind === 'snapshot') next.outbox = next.outbox.filter(item => item.envelope.header.id !== queued.envelope.header.id);
        else next.outbox.find(item => item.envelope.header.id === queued.envelope.header.id).accepted = true;
        await persist(next, epoch);
      } catch (problem) {
        if (problem.status === 409 || problem.status === 403 || problem.status === 400) {
          next = clone(state);
          next.outbox.find(item => item.envelope.header.id === queued.envelope.header.id).failed = problem.message;
          await persist(next, epoch);
        } else throw problem;
      }
    }
    for (const stored of Object.values(state.teams)) {
      if (stored.status !== 'approved' || !stored.key || !stored.reachable) continue;
      const inbox = await rpc('inbox', { teamId: stored.id }, epoch);
      if (inbox.messages.length) {
        next = clone(state);
        const team = next.teams[stored.id];
        const received = await receiveTeamMessages(team, state.identity.id, inbox.messages, applyEvent, () => check(epoch));
        next.teams[stored.id] = received.team;
        next.outbox = next.outbox.filter(item => !received.accepted.includes(item.envelope.header.id));
        // Event, deduplication marker and ACK are one encrypted IndexedDB commit.
        await persist(next, epoch);
      }
      for (const ack of [...state.teams[stored.id].acks]) {
        await rpc('ack', ack, epoch);
        next = clone(state);
        next.teams[stored.id].acks = next.teams[stored.id].acks.filter(a => a.id !== ack.id);
        await persist(next, epoch);
      }
      const delivery = await rpc('status', { teamId: stored.id }, epoch);
      next = clone(state);
      next.teams[stored.id].delivery = Object.fromEntries(delivery.messages.map(m => [m.id, m]));
      await persist(next, epoch);
    }
  }
  function applyEvent(team, h, body, sender) {
    if (h.kind === 'snapshot') {
      if (!isAdmin(sender.role) || typeof body.name !== 'string' || body.name.length > 80 || !Array.isArray(body.tasks) || body.tasks.length > 1000 || body.tasks.some(t => !validTask(t))) throw new Error('Некоректний знімок команди.');
      team.name = body.name;
      for (const task of body.tasks) if (!team.tasks[task.id] || task.version > team.tasks[task.id].version) team.tasks[task.id] = task;
      return;
    }
    if (!validAt(body.at)) throw new Error('Подія не містить коректного часу.');
    if (h.kind === 'task-create') {
      if (!validTask(body.task) || body.task.id !== h.taskId || body.task.version !== 1 || body.task.creator !== sender.id || body.task.assignee !== h.assignee || body.task.done || str(body.task.steps.map(s => ({ id: s.id, assignee: s.assignee }))) !== str(h.steps) || body.task.steps.some(s => s.done) || body.task.history.length !== 1 || body.task.history[0].actor !== sender.id || body.task.history[0].kind !== 'task-create' || body.task.history[0].at !== body.at) throw new Error('Вміст задачі не відповідає призначенню.');
      if (!team.tasks[h.taskId]) { body.task.lastMessage = h.id; team.tasks[h.taskId] = body.task; }
      return;
    }
    const task = team.tasks[h.taskId];
    if (!task) throw new Error('Спочатку потрібен знімок історії від адміністратора.');
    if (h.version <= task.version) return;
    if (h.version !== task.version + 1) throw new Error('Пропущено версію задачі. Попросіть адміністратора надіслати знімок.');
    if (h.kind === 'task-step') {
      const step = task.steps.find(s => s.id === h.stepId);
      if (!step || !(step.assignee === sender.id || isAdmin(sender.role))) throw new Error('Недозволена зміна етапу.');
      step.done = h.done;
      step.completedAt = h.done ? body.at : null;
      if (!h.done) { task.done = false; task.completedAt = null; }
    } else if (h.kind === 'task-complete') {
      if (!(task.assignee === sender.id || isAdmin(sender.role)) || (h.done && task.steps.some(s => !s.done))) throw new Error('Недозволене завершення задачі.');
      task.done = h.done;
      task.completedAt = h.done ? body.at : null;
    } else throw new Error('Невідома командна подія.');
    task.version = h.version;
    task.lastMessage = h.id;
    if (task.history.length >= 2000) throw new Error('Ліміт історії задачі досягнуто.');
    task.history.push({ actor: sender.id, kind: h.kind, stepId: h.stepId || null, done: h.done, at: body.at });
  }
  async function queue(team, kind, taskId, metadata, body, epoch, recipients = null) {
    if (state.outbox.length >= 100) throw new Error('Спочатку доставте або приберіть попередні 100 подій.');
    const header = { v: 1, epoch: 1, id: uid(), teamId: team.id, senderId: state.identity.id, kind, taskId, recipients: recipients || team.members.map(m => m.id).sort(), ...metadata };
    const envelope = await sealEvent(state.identity, team.key, header, body);
    check(epoch);
    const next = clone(state);
    next.outbox.push({ envelope });
    await persist(next, epoch);
  }
  const button = (label, action, extra = '', css = 'btn btn-outline-secondary') => `<button type="button" class="${css}" data-team-action="${action}" ${extra}>${label}</button>`;
  function authMeta() {
    const user = transport?.authStatus() || cloudUser;
    return user ? `<div class="team-auth-meta"><p class="team-note">${esc(user.login || '')}<br>UID: <code>${esc(user.uid)}</code></p><div class="team-actions">${button('Копіювати UID', 'copy-uid')}${!user.mustChangePassword ? `${button('Перевірити підключення', 'sync')}${mode !== 'password' ? button('Змінити пароль', 'change-password') : ''}` : ''}${button('Вийти з бази', 'cloud-logout')}</div></div>` : '';
  }
  function authForm() {
    return `<form id="team-auth-form" class="team-form"><h2>Вхід у базу</h2><p class="team-note">${esc(projectId)} · Логін і пароль видає адміністратор команди. Це окремий вхід — Google-акаунт тут не потрібен.</p><label for="team-login">Логін</label><input id="team-login" class="form-control" type="text" minlength="3" maxlength="32" pattern="[A-Za-z0-9]([A-Za-z0-9_]|-){1,30}[A-Za-z0-9]" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(state?.authLogin || '')}" placeholder="Наприклад: komandyr"><label for="team-password">Пароль</label><input id="team-password" class="form-control" type="password" minlength="6" maxlength="128" required autocomplete="current-password"><div class="team-actions"><button type="submit" class="btn btn-primary">Увійти</button></div></form>`;
  }
  function fingerprintCard() {
    return `<div class="team-fingerprint"><span>Ваш відбиток у цій базі</span><code>${esc(state.identity.id)}</code>${button('Копіювати відбиток', 'copy-fingerprint')}<small>Звірте весь код з адміністратором перед погодженням.</small></div>`;
  }
  function passwordForm() {
    const mandatory = transport?.authStatus()?.mustChangePassword === true;
    return `<form id="team-password-form" class="team-form"><h2>${mandatory ? 'Встановіть власний пароль' : 'Змінити пароль'}</h2><p class="team-note">${mandatory ? 'Тимчасовий пароль потрібно замінити перед доступом до команд. ' : ''}Від 12 до 128 символів. Можна використати довгу фразу. Пароль не зберігається у просторі.</p><label for="team-new-password">Новий пароль</label><input id="team-new-password" class="form-control" type="password" minlength="12" maxlength="128" required autocomplete="new-password"><label for="team-new-password-confirm">Повторіть пароль</label><input id="team-new-password-confirm" class="form-control" type="password" minlength="12" maxlength="128" required autocomplete="new-password"><div class="team-actions"><button type="submit" class="btn btn-primary">Зберегти пароль</button>${!mandatory ? button('Скасувати', 'cancel-password') : ''}</div></form>`;
  }
  function archivePage() {
    const archive = workspace.legacyArchive;
    return `<div class="team-card"><h2>Локальний архів прототипу</h2><p class="team-note">Старі команди збережені у просторі та JSON-копії. Вони не надсилаються у Firebase: для мережевої команди створіть нові ключі й запрошення.</p>${Object.values(archive?.teams || {}).map(team => `<details class="team-history"><summary>${esc(team.name)}</summary>${Object.values(team.tasks || {}).map(task => `<article><strong>${esc(task.title)}</strong><p>${esc(task.date)} · ${esc(task.time)}${task.completedAt ? ' · Виконано ' + esc(dateLabel(task.completedAt)) : ''}</p>${task.steps.map(step => `<p>${step.done ? '✓' : '○'} ${esc(step.title)}${step.completedAt ? ' · ' + esc(dateLabel(step.completedAt)) : ''}</p>`).join('')}</article>`).join('') || '<p>Задач немає.</p>'}</details>`).join('')}</div>`;
  }
  function render(force = false) {
    if (!active) return;
    if ((['create', 'join', 'task', 'config', 'auth', 'password'].includes(mode) && !force && root.querySelector('form')) || document.querySelector('#setup-guide[open]')) {
      const box = root.querySelector('[data-team-error]'); if (box) box.textContent = error;
      const meta = root.querySelector('[data-auth-meta]'); if (meta) meta.innerHTML = authMeta();
      return;
    }
    const heading = `<div class="team-header"><h1>Команди</h1>${button('?', 'help', 'aria-label="Інструкція: база та команди"')}${workspace && (projectId || mode !== 'projects') ? button('Бази', 'projects') : ''}</div>`;
    const feedback = `<p class="team-note" role="status" data-team-status>${esc(status)}</p><p class="form-error" role="alert" data-team-error>${esc(error)}</p>`;
    if (!workspace) { root.innerHTML = `${heading}${feedback}<p>Відкриваємо локальне сховище…</p>`; return; }
    const projectBar = projectId ? `<p class="team-project-bar">${esc(projectId)} · ${transport?.authStatus()?.mustChangePassword ? 'встановлення пароля' : cloudUser ? 'Firebase підключено' : 'локальна історія'}</p>` : '';
    let content = '';
    if (mode === 'config') content = `<form id="team-config-form" class="team-form"><h2>Підключити базу</h2><label for="team-firebase-config">Налаштування Firebase</label><textarea id="team-firebase-config" class="form-control" required maxlength="10000" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder='{"apiKey":"…","authDomain":"…","projectId":"…","appId":"…"}'></textarea><p class="team-note">Вставте firebaseConfig із Web app. Підходить JSON або const firebaseConfig = { … }. Не вставляйте службові ключі.</p><div class="team-actions"><button class="btn btn-primary" type="submit">Зберегти базу</button>${button('Скасувати', 'projects')}</div></form>`;
    else if (mode === 'projects') content = `<div class="team-actions">${button('Підключити базу', 'config', '', 'btn btn-primary')}</div><div class="teams-panel">${Object.entries(workspace.projects).map(([id, saved]) => `<button class="team-card" type="button" data-team-action="project" data-project-id="${esc(id)}"><strong>${esc(id)}</strong><span>Команд: ${Object.keys(saved.teams).length} · ${saved.authUid ? 'акаунт прив’язано' : 'потрібен вхід'}</span></button>`).join('') || '<p class="team-note">Додайте власну базу або налаштування від адміністратора. Покрокова інструкція — на кнопці «?».</p>'}</div>${workspace.legacyArchive ? button('Архів локального прототипу', 'legacy') : ''}`;
    else if (mode === 'legacy') content = archivePage();
    else if (state && transport?.authStatus() && (transport.authStatus().mustChangePassword || mode === 'password')) content = `<div data-auth-meta>${authMeta()}</div>${passwordForm()}`;
    else if (state && !cloudUser && mode !== 'history' && !selected) content = `<div data-auth-meta>${authMeta()}</div>${authForm()}<div class="team-actions">${Object.keys(state.teams).length ? button('Переглянути локальну історію', 'history') : ''}</div>`;
    else if (mode === 'create') content = `<form id="team-create-form" class="team-form"><h2>Нова команда</h2><label for="team-name">Назва</label><input id="team-name" class="form-control" maxlength="80" required autocomplete="off"><div class="team-actions"><button class="btn btn-primary" type="submit">Створити команду</button>${button('Скасувати', 'back')}</div></form>`;
    else if (mode === 'join') content = `<form id="team-join-form" class="team-form"><h2>Приєднатися</h2><label for="team-invite-code">Одноразовий код</label><input id="team-invite-code" class="form-control" maxlength="60" required autocomplete="off" spellcheck="false"><p class="team-note">Налаштування бази мають збігатися з базою адміністратора. Код діє до 15 хвилин; потрібне погодження адміністратора.</p>${fingerprintCard()}<div class="team-actions"><button class="btn btn-primary" type="submit">Подати запит</button>${button('Скасувати', 'back')}</div></form>`;
    else if (mode === 'task' && currentTeam()) content = taskForm(currentTeam());
    else if (selected && currentTeam()) content = teamPage(currentTeam());
    else if (state) content = `<div data-auth-meta>${authMeta()}</div><div class="team-actions">${cloudUser ? `${state.isProjectOwner ? button('Створити команду', 'create', '', 'btn btn-primary') : ''}${button('Приєднатися', 'join')}${button('Оновити', 'sync')}` : button('Увійти', 'auth')}</div>${cloudUser && !state.isProjectOwner && !Object.keys(state.teams).length ? '<p class="team-note">Якщо ви власник цієї бази, додайте свій UID у system/bootstrap → ownerUid, як описано у ?, і перевірте підключення.</p>' : ''}<div class="teams-panel">${Object.values(state.teams).map(team => `<button class="team-card" type="button" data-team-action="open" data-team-id="${esc(team.id)}"><strong>${esc(team.name)}</strong><span>${team.status === 'pending' ? 'Очікує погодження' : roleFor(team) === 'owner' ? 'Ви власник' : roleFor(team) === 'admin' ? 'Ви адміністратор' : 'Ви учасник'}</span></button>`).join('') || '<p class="team-note">Команд ще немає. Створіть команду або введіть код запрошення.</p>'}</div>`;
    const queued = state && state.outbox.length ? `<div class="team-note"><strong>У локальній черзі: ${state.outbox.length}</strong>${state.outbox.map(item => `<p>${esc(item.failed || (item.accepted ? 'Firebase прийняв · очікує локального збереження' : 'Очікує передавання у Firebase'))}${item.failed ? button('Прибрати невідправлену дію', 'discard', `data-message-id="${esc(item.envelope.header.id)}"`) : ''}</p>`).join('')}</div>` : '';
    const expandedTasks = new Set([...root.querySelectorAll('[data-team-task-id] .team-history[open]')].map(details => details.closest('[data-team-task-id]').dataset.teamTaskId));
    root.innerHTML = `${heading}${projectBar}${feedback}${queued}${content}`;
    for (const details of root.querySelectorAll('[data-team-task-id] .team-history')) if (expandedTasks.has(details.closest('[data-team-task-id]').dataset.teamTaskId)) details.open = true;
  }
  function taskForm(team) {
    const options = team.members.map(m => `<option value="${esc(m.id)}">${esc(m.alias)}</option>`).join('');
    return `<form id="team-task-form" class="team-form"><h2>Нова командна задача</h2><label for="team-task-title">Що зробити</label><input class="form-control" id="team-task-title" maxlength="240" required autocomplete="off"><label for="team-task-assignee">Виконавець задачі</label><select id="team-task-assignee" class="form-select">${options}</select><div class="team-actions"><label>Дата<input class="form-control" id="team-task-date" type="date" required value="${localDate()}"></label><label>Час<input class="form-control" id="team-task-time" type="time" required value="${localTime()}"></label></div><div id="team-step-fields"></div>${button('+ Етап', 'add-step')}<div class="team-actions"><button class="btn btn-primary" type="submit">Поставити задачу</button>${button('Скасувати', 'back')}</div></form>`;
  }
  function teamPage(team) {
    const ready = Boolean(cloudUser) && team.reachable !== false && !team.rosterError;
    const admin = isAdmin(roleFor(team)) && ready, me = state.identity.id;
    let content = `<div class="team-actions">${button('← Команди', 'list')}<h2>${esc(team.name)}</h2>${button('Оновити', 'sync')}</div>`;
    if (team.rosterError) content += `<p class="team-note" role="alert">Склад або ключ команди не пройшли перевірку. Обмін зупинено; локальна історія збережена.<br>${esc(team.rosterError)}</p>`;
    if (team.invalidPending) content += `<p class="team-note" role="alert">Заявок із неперевіреним відбитком: ${team.invalidPending}. Їх не можна погодити. Звірте особу та її початковий простір окремим каналом.</p>`;
    if (team.status === 'pending') return `${content}<p class="team-note">Запит надіслано. Звірте відбиток з адміністратором і дочекайтеся погодження.</p>${fingerprintCard()}`;
    const quarantined = Object.values(team.quarantine || {});
    if (quarantined.length) content += `<div class="team-note" role="alert"><strong>Не застосовано подій: ${quarantined.length}</strong><p>Їх отримання не підтверджено. Інші задачі синхронізуються. Попросіть адміністратора надіслати знімок історії; пошкоджений підпис не можна прийняти як виконання.</p><details><summary>Подробиці</summary>${quarantined.slice(0, 10).map(item => `<p>${esc(item.reason)}${item.taskId ? `<br>Задача: ${esc(item.taskId)}` : ''}</p>`).join('')}</details></div>`;
    content += `<div class="team-actions">${button('+ Задача', 'task', !cloudUser || !team.members.length || team.reachable === false ? 'disabled' : '', 'btn btn-primary')}${admin ? button('Запросити', 'invite', team.reachable === false ? 'disabled' : '') : ''}${button('Учасники', 'members')}</div>`;
    if (invitation?.teamId === team.id) content += `<div class="team-card"><label for="team-invitation">Код · діє до 15 хвилин · одне використання</label><input id="team-invitation" class="form-control" readonly value="${esc(invitation.token)}">${button('Копіювати код', 'copy-invite')}<p class="team-note">Передайте код кандидату та звірте його відбиток окремим каналом.</p></div>`;
    if (mode === 'members') {
      content += `<div class="team-card"><h3>Учасники</h3>${team.members.map(m => `<div class="team-member"><strong>${esc(m.alias)}${m.id === me ? ' · ви' : ''}</strong><span>${({ owner: 'Власник', admin: 'Адміністратор', member: 'Учасник' })[m.role]}</span><small>Відбиток: ${esc(m.id)}</small>${ready && roleFor(team) === 'owner' && m.id !== me && m.role === 'member' ? button('Зробити адміністратором', 'role', `data-member-id="${esc(m.id)}" data-role="admin"`) : ''}${admin && m.id !== me ? button('Надіслати знімок історії', 'snapshot', `data-member-id="${esc(m.id)}"`) : ''}</div>`).join('')}<p class="team-note">Видалення учасників і пониження ролей ще недоступні: потрібні ротація ключів та історія прав. Усі погоджені учасники бачать вміст усієї команди.</p></div>`;
    }
    if (admin && team.pending.length) content += `<div class="team-card"><h3>Запити на вступ</h3>${team.pending.map(m => `<div class="team-member"><strong>${esc(m.alias)}</strong><small>Звірте відбиток: ${esc(m.id)}</small>${button('Погодити учасника', 'approve', `data-member-id="${esc(m.id)}"`, 'btn btn-primary')}</div>`).join('')}</div>`;
    content += `<div class="team-actions" role="group" aria-label="Фільтр командних задач">${[['mine', 'Мені'], ['given', 'Від мене'], ['all', 'Усі']].map(([value, label]) => button(label, 'filter', `data-filter="${value}" aria-pressed="${filter === value}"`, `btn ${filter === value ? 'btn-primary' : 'btn-outline-secondary'}`)).join('')}</div>`;
    const tasks = Object.values(team.tasks).filter(t => filter === 'all' || (filter === 'given' ? t.creator === me : t.assignee === me || t.steps.some(s => s.assignee === me))).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    content += `<div class="teams-panel">${tasks.map(task => {
      const canComplete = ready && (task.assignee === me || admin), delivery = team.delivery[task.lastMessage];
      return `<article class="team-task" data-team-task-id="${esc(task.id)}"><div class="team-actions"><h3>${esc(task.title)}</h3>${canComplete ? button(task.done ? '✓' : '✓', 'complete', `data-task-id="${esc(task.id)}" aria-label="${task.done ? 'Повернути задачу до роботи' : 'Виконати задачу'}" aria-pressed="${task.done}" ${!task.done && task.steps.some(s => !s.done) ? 'disabled title="Спочатку виконайте всі етапи"' : ''}`, `btn ${task.done ? 'btn-primary' : 'btn-outline-secondary'}`) : ''}</div><p class="team-note">${esc(task.date)} · ${esc(task.time)} · ${esc(memberName(team, task.assignee))}<br>Поставив: ${esc(memberName(team, task.creator))}</p>${task.completedAt ? `<p class="team-note">Виконано ${esc(dateLabel(task.completedAt))}</p>` : ''}${task.steps.map(step => `<div class="team-step"><span>${esc(step.title)}<small>${esc(memberName(team, step.assignee))}${step.completedAt ? ` · ${esc(dateLabel(step.completedAt))}` : ''}</small></span>${ready && (step.assignee === me || admin) ? button('✓', 'step', `data-task-id="${esc(task.id)}" data-step-id="${esc(step.id)}" aria-label="${step.done ? 'Повернути етап до роботи' : 'Виконати етап'}: ${esc(step.title)}" aria-pressed="${step.done}"`, `btn ${step.done ? 'btn-primary' : 'btn-outline-secondary'}`) : `<span aria-label="${step.done ? 'Виконано' : 'Очікує виконання'}">${step.done ? '✓' : '○'}</span>`}</div>`).join('')}${delivery ? `<p class="team-note">${delivery.status === 'delivered' ? 'Отримано пристроями' : delivery.status === 'expired' ? 'Строк минув · доставку не підтверджено' : 'Підтверджено отримання'}: ${delivery.received}/${delivery.total}</p>` : ''}<details class="team-history"><summary>Історія · ${task.history.length}</summary>${task.history.map(item => `<p>${esc(dateLabel(item.at))} · ${esc(memberName(team, item.actor))}<br>${item.kind === 'task-create' ? 'Створив задачу' : item.kind === 'task-step' ? `Етап: ${esc(task.steps.find(s => s.id === item.stepId)?.title || '')} · ${item.done ? 'виконано' : 'повернуто до роботи'}` : item.done ? 'Виконав задачу' : 'Повернув задачу до роботи'}</p>`).join('')}<small>Час із пристрою автора; не незалежний доказ виконання.</small></details></article>`;
    }).join('') || '<p class="team-note">У цій стрічці поки немає задач.</p>'}</div>`;
    return content;
  }
  function clearPasswords() { for (const input of root.querySelectorAll('input[type="password"]')) input.value = ''; }
  async function disconnect(epoch) {
    clearPasswords();
    const old = transport; transport = null; cloudUser = null;
    if (old) await old.logout();
    check(epoch);
    invitation = null; selected = null; status = '';
  }
  async function bindAccount(epoch) {
    const user = transport?.authStatus();
    if (!user) throw new Error('Увійдіть у Firebase.');
    if (user.mustChangePassword) throw new Error('Спочатку встановіть власний пароль.');
    if (state.authUid && state.authUid !== user.uid) { await disconnect(epoch); throw new Error('Цей простір уже прив’язано до іншого Firebase-акаунта. Увійдіть у свій акаунт або створіть окремий простір.'); }
    if (!state.authUid || state.authLogin !== user.login) { const next = clone(state); next.authUid = user.uid; next.authLogin = user.login; await persist(next, epoch); }
    cloudUser = user;
  }
  async function ensureTransport(epoch) {
    check(epoch);
    if (!state) throw new Error('Спочатку підключіть базу Firebase.');
    if (!transport) {
      const client = await createFirebaseTransport({ config: state.config, identity: state.identity, check: () => check(epoch) });
      try { check(epoch); } catch (problem) { await client.logout(); throw problem; }
      transport = client;
    }
    return transport;
  }
  async function saveWorkspace(next, epoch) {
    check(epoch); await saveState(clone(next)); check(epoch); workspace = next; onChange();
  }
  function openMode(nextMode) { clearPasswords(); mode = nextMode; error = ''; render(true); root.querySelector('form input, form textarea')?.focus(); }
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-team-action]');
    if (!target || !active || working || isBusy()) return;
    const action = target.dataset.teamAction;
    if (action === 'help') { openGuide('owner'); return; }
    if (action === 'config' || action === 'legacy' || action === 'history' || action === 'auth') { selected = null; openMode(action); return; }
    if (action === 'projects') { selected = null; openMode('projects'); return; }
    if (action === 'create' || action === 'join' || action === 'task' || action === 'members') { if (!cloudUser && action !== 'members') { selected = null; openMode('auth'); } else openMode(action); return; }
    if (action === 'open') { selected = target.dataset.teamId; openMode('team'); return; }
    if (action === 'list') { selected = null; invitation = null; openMode('list'); return; }
    if (action === 'back') { openMode(selected ? 'team' : 'list'); return; }
    if (action === 'filter') { filter = target.dataset.filter; render(true); return; }
    if (action === 'add-step') {
      const fields = root.querySelector('#team-step-fields');
      if (fields.children.length >= 12) { toast('У задачі максимум 12 етапів.'); return; }
      const row = document.createElement('div'); row.className = 'team-step team-step-input';
      row.innerHTML = `<input class="form-control" data-step-title aria-label="Назва етапу" maxlength="240" required placeholder="Що зробити на цьому етапі"><select class="form-select" data-step-assignee aria-label="Виконавець етапу">${currentTeam().members.map(m => `<option value="${esc(m.id)}">${esc(m.alias)}</option>`).join('')}</select>${button('×', 'remove-step', 'aria-label="Прибрати етап"')}`;
      row.querySelector('select').value = root.querySelector('#team-task-assignee').value;
      fields.append(row); row.querySelector('input').focus(); return;
    }
    if (action === 'remove-step') { target.closest('.team-step-input').remove(); return; }
    run(async epoch => {
      const team = currentTeam();
      if (action === 'project') {
        await disconnect(epoch);
        projectId = target.dataset.projectId;
        state = workspace.projects[projectId];
        await saveWorkspace({ ...workspace, activeProject: projectId }, epoch);
        mode = 'auth'; render(true); return;
      }
      if (action === 'cloud-logout') { await disconnect(epoch); mode = 'auth'; render(true); return; }
      if (action === 'copy-fingerprint') { await navigator.clipboard.writeText(state.identity.id); check(epoch); toast('Відбиток скопійовано'); return; }
      if (action === 'copy-uid') { const user = transport?.authStatus(); if (user) { await navigator.clipboard.writeText(user.uid); check(epoch); toast('UID скопійовано'); } return; }
      if (action === 'change-password') { selected = null; openMode('password'); return; }
      if (action === 'cancel-password') { if (transport?.authStatus()?.mustChangePassword) return; openMode(cloudUser ? 'list' : 'auth'); return; }
      if (action === 'sync') {
        if (transport?.authStatus()?.mustChangePassword) { cloudUser = null; mode = 'password'; render(true); return; }
        if (transport?.authStatus()) {
          cloudUser = transport.authStatus();
          await bindAccount(epoch);
          await sync(epoch); mode = selected ? 'team' : 'list'; render(true);
        } else { mode = 'auth'; render(true); }
        return;
      }
      if (action === 'invite') { invitation = { teamId: team.id, ...await rpc('invite', { teamId: team.id }, epoch) }; return; }
      if (action === 'copy-invite') { await navigator.clipboard.writeText(invitation.token); check(epoch); toast('Код скопійовано'); return; }
      if (action === 'discard') { const next = clone(state); next.outbox = next.outbox.filter(q => q.envelope.header.id !== target.dataset.messageId); await persist(next, epoch); return; }
      if (action === 'role') { await rpc('role', { teamId: team.id, memberId: target.dataset.memberId, role: target.dataset.role }, epoch); await sync(epoch); return; }
      if (action === 'approve') {
        const candidate = team.pending.find(m => m.id === target.dataset.memberId);
        const wrap = await wrapTeamKey(state.identity, candidate, team.id, team.key);
        check(epoch);
        await rpc('approve', { teamId: team.id, memberId: candidate.id, wrap }, epoch);
        await sync(epoch);
        await queue(currentTeam(), 'snapshot', uid(), {}, { name: currentTeam().name, tasks: Object.values(currentTeam().tasks) }, epoch, [candidate.id]);
        await sync(epoch); return;
      }
      if (action === 'snapshot') { await queue(team, 'snapshot', uid(), {}, { name: team.name, tasks: Object.values(team.tasks) }, epoch, [target.dataset.memberId]); await sync(epoch); return; }
      if (action === 'step' || action === 'complete') {
        if (state.outbox.some(q => q.envelope.header.taskId === target.dataset.taskId)) throw new Error('Попередня зміна цієї задачі ще в черзі. Спочатку синхронізуйте її.');
        const task = team.tasks[target.dataset.taskId], step = task.steps.find(s => s.id === target.dataset.stepId);
        if (task.history.length >= 2000) throw new Error('Ліміт історії задачі досягнуто. Створіть нову задачу.');
        await queue(team, action === 'step' ? 'task-step' : 'task-complete', task.id, { version: task.version + 1, done: !(step || task).done, ...(step ? { stepId: step.id } : {}) }, { at: new Date().toISOString() }, epoch);
        await sync(epoch);
      }
    });
  });
  root.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const formData = form.id === 'team-config-form' ? { source: root.querySelector('#team-firebase-config').value } : form.id === 'team-auth-form' ? { login: root.querySelector('#team-login').value.trim(), password: root.querySelector('#team-password').value } : form.id === 'team-password-form' ? { password: root.querySelector('#team-new-password').value, confirm: root.querySelector('#team-new-password-confirm').value } : form.id === 'team-create-form' ? { name: root.querySelector('#team-name').value.trim() } : form.id === 'team-join-form' ? { token: root.querySelector('#team-invite-code').value.trim() } : form.id === 'team-task-form' ? {
      title: root.querySelector('#team-task-title').value.trim(), assignee: root.querySelector('#team-task-assignee').value,
      date: root.querySelector('#team-task-date').value, time: root.querySelector('#team-task-time').value,
      steps: [...root.querySelectorAll('.team-step-input')].map(row => ({ id: uid(), title: row.querySelector('[data-step-title]').value.trim(), assignee: row.querySelector('[data-step-assignee]').value, done: false, completedAt: null })) } : null;
    if (['team-auth-form', 'team-password-form'].includes(form.id)) for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
    run(async epoch => {
      if (form.id === 'team-config-form') {
        const config = parseFirebaseConfig(formData.source);
        await disconnect(epoch);
        const existing = workspace.projects[config.projectId];
        if (!existing && Object.keys(workspace.projects).length >= 20) throw new Error('У просторі вже 20 баз. Створіть окремий простір для наступної.');
        const identity = existing?.identity || await makeIdentity(session.name); check(epoch);
        const project = existing ? { ...existing, config } : { version: 1, config, identity, teams: {}, outbox: [] };
        const next = { ...workspace, activeProject: config.projectId, projects: { ...workspace.projects, [config.projectId]: project } };
        await saveWorkspace(next, epoch);
        projectId = config.projectId; state = project; mode = 'auth'; render(true);
      } else if (form.id === 'team-auth-form') {
        const client = await ensureTransport(epoch);
        try {
          await client.signIn(normalizeLogin(formData.login), formData.password); check(epoch);
          const account = client.authStatus();
          if (state.authUid && account?.uid !== state.authUid) { await disconnect(epoch); throw new Error('Цей простір уже прив’язано до іншого акаунта. Увійдіть у свій акаунт або відкрийте окремий простір.'); }
          if (account?.mustChangePassword) { cloudUser = null; mode = 'password'; render(true); return; }
          await bindAccount(epoch); await sync(epoch); mode = 'list'; render(true);
        } finally { formData.password = ''; check(epoch); }
      } else if (form.id === 'team-password-form') {
        try {
          validateNewPassword(formData.password);
          if (formData.password !== formData.confirm) throw new Error('Паролі не збігаються. Введіть обидва ще раз.');
          const client = await ensureTransport(epoch);
          await client.changePassword(formData.password); check(epoch);
          await bindAccount(epoch); status = 'Власний пароль збережено.';
          mode = 'list'; await sync(epoch); render(true); toast('Пароль змінено');
        } finally { formData.password = ''; formData.confirm = ''; check(epoch); }
      } else if (form.id === 'team-create-form') {
        if (!formData.name) throw new Error('Вкажіть назву команди.');
        const teamId = uid();
        // Save key first: losing a local commit must never orphan an already created server team.
        const next = clone(state); next.teams[teamId] = { ...emptyTeam(teamId), name: formData.name, key: toBase64(crypto.getRandomValues(new Uint8Array(32))), status: 'approved', creationPending: true };
        await persist(next, epoch);
        selected = teamId; mode = 'team'; await sync(epoch); render(true);
      } else if (form.id === 'team-join-form') {
        const { teamId } = await rpc('join', { token: formData.token }, epoch);
        selected = teamId; mode = 'team'; await sync(epoch); render(true);
      } else if (form.id === 'team-task-form') {
        if (!formData.title || formData.steps.some(step => !step.title)) throw new Error('Заповніть назву задачі та всіх етапів.');
        const team = currentTeam(), at = new Date().toISOString(), task = { id: uid(), ...formData, creator: state.identity.id, version: 1, done: false, completedAt: null, history: [{ actor: state.identity.id, kind: 'task-create', at }] };
        await queue(team, 'task-create', task.id, { version: 1, assignee: task.assignee, steps: task.steps.map(s => ({ id: s.id, assignee: s.assignee })) }, { at, task }, epoch);
        mode = 'team'; await sync(epoch); render(true);
      }
    });
  });
  function lock() {
    clearPasswords();
    active = false; generation++; aborter?.abort(); clearInterval(timer); timer = null;
    const old = transport; transport = null; cloudUser = null;
    if (old) Promise.resolve(old.logout()).catch(() => {});
    session = null; state = null; workspace = null; projectId = null; selected = null; invitation = null; error = ''; status = ''; mode = 'list'; working = false;
    document.querySelector('#setup-guide[open]')?.close();
    root.setAttribute('aria-busy', 'false'); root.replaceChildren();
  }
  async function refresh() {
    if (!getSession()) return;
    if (active && session === getSession()) { if (cloudUser && !transport?.authStatus()?.mustChangePassword) await run(sync); else render(); return; }
    lock(); active = true; session = getSession(); aborter = new AbortController(); const epoch = generation;
    await run(async () => {
      const saved = readState();
      if (saved.version === 1) {
        await validateState(saved); check(epoch);
        // Keep every original key, queued event and history in the encrypted backup.
        await saveWorkspace({ version: 2, projects: {}, activeProject: null, legacyArchive: saved }, epoch);
      } else if (saved.version === 2) {
        if (!saved.projects || Array.isArray(saved.projects) || Object.keys(saved.projects).length > 20) throw new Error('Некоректний список Firebase-баз. Дані не змінено.');
        for (const [id, project] of Object.entries(saved.projects)) {
          const config = parseFirebaseConfig(JSON.stringify(project.config));
          if (id !== config.projectId || (project.authUid && !validId(project.authUid))) throw new Error('Некоректна прив’язка Firebase-бази.');
          await validateState(project); check(epoch);
        }
        if (saved.legacyArchive) { await validateState(saved.legacyArchive); check(epoch); }
        workspace = saved;
      } else if (Object.keys(saved).length) throw new Error('Невідомий формат команд. Існуючі дані не змінено.');
      else workspace = { version: 2, projects: {}, activeProject: null };
      projectId = workspace.activeProject && Object.hasOwn(workspace.projects, workspace.activeProject) ? workspace.activeProject : null;
      state = projectId ? workspace.projects[projectId] : null;
      mode = state ? 'auth' : 'projects'; render(true);
    });
    check(epoch);
    timer = setInterval(() => { if (state && cloudUser && document.visibilityState === 'visible' && !['create', 'join', 'task', 'config', 'auth', 'password'].includes(mode) && !document.querySelector('#setup-guide[open]')) run(sync); }, 60000);
  }
  return { refresh, lock, handleAdd: () => {
    if (!active || !workspace || working) return;
    if (!state) { openMode('config'); return; }
    if (transport?.authStatus()?.mustChangePassword) { selected = null; openMode('password'); return; }
    if (!cloudUser) { selected = null; openMode('auth'); return; }
    if (selected && (!currentTeam()?.members.length || currentTeam()?.reachable === false)) return;
    openMode(selected && currentTeam()?.status === 'approved' ? 'task' : state.isProjectOwner ? 'create' : 'join');
  } };
}
