import { parseDate } from './dates.js';

export const ALERT_MILESTONES = [60, 30, 10];

// Each pass returns only the nearest reached milestone, so resuming the app
// never emits a backlog of 60-, 30- and 10-minute alerts for the same task.
export function upcomingAlerts(tasks, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Некоректний поточний час.');
  return tasks.flatMap((task) => {
    if (task.done || !parseDate(task.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.time || '')) return [];
    const dueAt = new Date(`${task.date}T${task.time}:00`).getTime();
    const remaining = (dueAt - now) / 60000;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 60) return [];
    const milestone = remaining <= 10 ? 10 : remaining <= 30 ? 30 : 60;
    return [{ task, dueAt, milestone, minutes: Math.ceil(remaining), schedule: `${task.id}|${task.date}|${task.time}` }];
  }).sort((a, b) => a.dueAt - b.dueAt || a.task.id.localeCompare(b.task.id));
}

const RECEIPT_TTL = 3 * 86400000;
// Keep all three milestones for the supported maximum of 20 000 tasks.
const MAX_RECEIPTS = 60000;
export class AlertLedger {
  constructor({ storage = null, key = 'na-kontroli-alert-receipts', digest = (bytes) => globalThis.crypto.subtle.digest('SHA-256', bytes) } = {}) {
    this.storage = storage;
    this.key = key;
    this.digest = digest;
    this.memory = new Map();
  }

  read(now) {
    let saved = [];
    try { saved = JSON.parse(this.storage?.getItem(this.key) || '[]'); } catch { /* Use the current session if browser storage is unavailable. */ }
    if (!Array.isArray(saved)) saved = [];
    const receipts = new Map(this.memory);
    for (const entry of saved.slice(-MAX_RECEIPTS)) {
      if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && Number.isFinite(entry[1])) receipts.set(entry[0], entry[1]);
    }
    for (const [key, timestamp] of receipts) if (timestamp < now - RECEIPT_TTL || timestamp > now + RECEIPT_TTL) receipts.delete(key);
    return receipts;
  }

  async hash(profileId, schedule, milestone) {
    const bytes = new TextEncoder().encode(`${profileId}|${schedule}|${milestone}`);
    return [...new Uint8Array(await this.digest(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async consume(profileId, candidates, now = Date.now(), isCurrent = () => true) {
    const prepared = await Promise.all(candidates.map(async (alert) => ({
      alert,
      hashes: await Promise.all(ALERT_MILESTONES.filter((value) => value >= alert.milestone).map((value) => this.hash(profileId, alert.schedule, value))),
    })));
    if (!isCurrent()) return [];
    // Read after hashing: other open tabs may have delivered in the meantime.
    const receipts = this.read(now);
    const fresh = [];
    for (const { alert, hashes } of prepared) {
      if (!receipts.has(hashes[hashes.length - 1])) fresh.push(alert);
      hashes.forEach((hash) => receipts.set(hash, now));
    }
    // Only opaque hashes and receipt timestamps leave memory, never task text,
    // IDs, names, planned dates, PINs or decrypted workspace content.
    const entries = [...receipts].sort((a, b) => a[1] - b[1]).slice(-MAX_RECEIPTS);
    this.memory = new Map(entries);
    try { this.storage?.setItem(this.key, JSON.stringify(entries)); } catch { /* In-memory deduplication still works. */ }
    return fresh;
  }
}
