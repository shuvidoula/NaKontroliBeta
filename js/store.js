// All task data is encrypted before it reaches IndexedDB. A PIN and a decrypted
// key stay in memory, never in browser storage.
const DATABASE_NAME = 'na-kontroli';
const DATABASE_VERSION = 1;
const STORE_NAME = 'profiles';
const FORMAT = 'na-kontroli-backup';
// Version 6 authenticates PIN length for four-digit PINs and explicit legacy
// compatibility. Existing encrypted data remains readable without rekeying.
const BACKUP_VERSION = 6;
const SUPPORTED_BACKUP_VERSIONS = [1, 2, 3, 4, 5, 6];
const ITERATIONS = 310000;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_TASKS = 20000;
const MAX_STEPS = 100;
const MAX_COMPLETION_HISTORY = 10000;
const MAX_ROUTINES = 200;
const MAX_EXCLUDED_DATES = 10000;
const MAX_TEAM_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const sessions = new WeakMap();
let databasePromise;

export class StorageError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StorageError(code, message);
}

function mapStorageError(error) {
  if (error instanceof StorageError) return error;
  if (error?.name === 'QuotaExceededError') {
    return new StorageError('STORAGE_FULL', 'Недостатньо місця на пристрої. Звільніть пам’ять і повторіть спробу.', { cause: error });
  }
  return new StorageError('STORAGE_UNAVAILABLE', 'Браузер не дозволяє зберегти дані. Перевірте доступ до сховища та відкрийте застосунок у звичайному режимі.', { cause: error });
}

function getCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    fail('CRYPTO_UNAVAILABLE', 'Для захищеного сховища відкрийте застосунок через HTTPS або localhost.');
  }
  return globalThis.crypto;
}

export function normalizeProfileName(name) {
  if (typeof name !== 'string') fail('INVALID_NAME', 'Введіть назву простору.');
  const normalized = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 40 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('INVALID_NAME', 'Назва простору має містити від 1 до 40 символів.');
  }
  return normalized;
}

export function validatePin(pin, { allowLegacy = false } = {}) {
  if (typeof pin !== 'string' || !(allowLegacy ? /^(?:\d{4}|\d{6,12})$/u : /^\d{4}$/u).test(pin)) {
    fail('INVALID_PIN', allowLegacy ? 'Введи PIN із 4 цифр або старий PIN із 6–12 цифр.' : 'PIN має містити рівно 4 цифри.');
  }
  return pin;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000-')) return false;
  const time = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validateCompletion(entity, version) {
  const completedAt = version < 3 && !Object.prototype.hasOwnProperty.call(entity, 'completedAt') ? null : entity.completedAt;
  const history = version < 3 && !Object.prototype.hasOwnProperty.call(entity, 'completionHistory') ? [] : entity.completionHistory;
  if ((completedAt !== null && !isTimestamp(completedAt)) ||
      !Array.isArray(history) || history.length > MAX_COMPLETION_HISTORY) {
    fail('INVALID_TASKS', 'Некоректна дата або історія виконання. Історія може містити до 10 000 записів.');
  }
  const completionHistory = history.map((event) => {
    if (!isObject(event) || !isTimestamp(event.at) || typeof event.done !== 'boolean') {
      fail('INVALID_TASKS', 'Історія виконання містить некоректний запис.');
    }
    return { at: event.at, done: event.done };
  });
  const latest = completionHistory[completionHistory.length - 1];
  if ((latest && latest.done !== entity.done) ||
      completedAt !== (entity.done && latest ? latest.at : null)) {
    fail('INVALID_TASKS', 'Статус виконання не відповідає даті або історії виконання.');
  }
  // An old completed item may have no timestamp/history. Preserve that unknown
  // date instead of inventing completion evidence during migration.
  return { completedAt, completionHistory };
}

function checkCompletedSteps(task) {
  if (task.done && Array.isArray(task.steps) && task.steps.some((step) => !step.done)) {
    fail('INCOMPLETE_STEPS', 'Спочатку виконай усі кроки задачі.');
  }
}

export function transitionCompletion(entity, done, at = new Date().toISOString()) {
  if (!isObject(entity) || typeof entity.done !== 'boolean' || typeof done !== 'boolean') {
    fail('INVALID_TASKS', 'Некоректний статус виконання.');
  }
  const completion = validateCompletion(entity, 2);
  if (entity.done === done) return { ...entity, ...completion };
  if (!isTimestamp(at)) fail('INVALID_TASKS', 'Некоректна дата виконання.');
  if (completion.completionHistory.length >= MAX_COMPLETION_HISTORY) {
    fail('INVALID_TASKS', 'Історія виконання вже містить 10 000 записів.');
  }
  const updated = {
    ...entity,
    done,
    completedAt: done ? at : null,
    completionHistory: [...completion.completionHistory, { at, done }],
  };
  checkCompletedSteps(updated);
  return updated;
}

function validateSteps(steps, version) {
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) {
    fail('INVALID_TASKS', `Задача може містити до ${MAX_STEPS} кроків.`);
  }
  const ids = new Set();
  return steps.map((step) => {
    if (!isObject(step) || !isId(step.id) || ids.has(step.id) ||
        typeof step.title !== 'string' || !step.title.trim() || step.title.trim().length > 500 ||
        typeof step.done !== 'boolean') {
      fail('INVALID_TASKS', 'Крок задачі має містити текст до 500 символів і коректну позначку виконання.');
    }
    ids.add(step.id);
    return { id: step.id, title: step.title.trim(), done: step.done, ...validateCompletion(step, version) };
  });
}

export function validateTasks(tasks, { version = BACKUP_VERSION, enforceCompletion = false } = {}) {
  if (!SUPPORTED_BACKUP_VERSIONS.includes(version)) {
    fail('INVALID_TASKS', 'Формат задач не підтримано.');
  }
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) {
    fail('INVALID_TASKS', `Простір може містити до ${MAX_TASKS.toLocaleString('uk-UA')} задач.`);
  }
  const ids = new Set();
  const occurrenceKeys = new Set();
  return tasks.map((task) => {
    if (!isObject(task) || !isId(task.id) || ids.has(task.id) ||
        typeof task.title !== 'string' || !task.title.trim() || task.title.length > 500 ||
        !isCalendarDate(task.date) || typeof task.done !== 'boolean' ||
        !isTimestamp(task.createdAt) || !isTimestamp(task.updatedAt)) {
      fail('INVALID_TASKS', 'Дані задачі некоректні: перевірте текст, дату та формат резервної копії.');
    }
    const time = version === 1 && !Object.prototype.hasOwnProperty.call(task, 'time') ? null : task.time;
    if (time !== null && (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))) {
      fail('INVALID_TASKS', 'Час задачі має бути у форматі ГГ:ХХ, від 00:00 до 23:59.');
    }
    const steps = validateSteps(version === 1 && !Object.prototype.hasOwnProperty.call(task, 'steps') ? [] : task.steps, version);
    const routineId = version < 4 && !Object.prototype.hasOwnProperty.call(task, 'routineId') ? null : task.routineId;
    const occurrenceDate = version < 4 && !Object.prototype.hasOwnProperty.call(task, 'occurrenceDate') ? null : task.occurrenceDate;
    const kind = version < 4 && !Object.prototype.hasOwnProperty.call(task, 'kind') ? 'task' : task.kind;
    if ((kind !== 'task' && kind !== 'reminder') ||
        (routineId !== null && (!isId(routineId) || routineId.length > 114)) ||
        (occurrenceDate !== null && !isCalendarDate(occurrenceDate)) ||
        ((routineId === null) !== (occurrenceDate === null))) {
      fail('INVALID_TASKS', 'Некоректний тип задачі або зв’язок із повторенням.');
    }
    if (routineId !== null) {
      const key = `${routineId}\0${occurrenceDate}`;
      if (occurrenceKeys.has(key)) fail('INVALID_TASKS', 'Простір містить дубль повторюваної задачі за одну дату.');
      occurrenceKeys.add(key);
    }
    if (enforceCompletion) checkCompletedSteps({ done: task.done, steps });
    ids.add(task.id);
    return {
      id: task.id,
      title: task.title.trim(),
      date: task.date,
      time,
      steps,
      routineId,
      occurrenceDate,
      kind,
      done: task.done,
      ...validateCompletion(task, version),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  });
}

export function validateRoutines(routines, { version = BACKUP_VERSION } = {}) {
  if (!SUPPORTED_BACKUP_VERSIONS.includes(version)) fail('INVALID_ROUTINES', 'Формат повторюваних правил не підтримано.');
  if (!Array.isArray(routines) || routines.length > MAX_ROUTINES) {
    fail('INVALID_ROUTINES', `Простір може містити до ${MAX_ROUTINES} повторюваних правил.`);
  }
  const ids = new Set();
  return routines.map((rule) => {
    if (!isObject(rule) || !isId(rule.id) || rule.id.length > 114 || ids.has(rule.id) ||
        typeof rule.title !== 'string' || !rule.title.trim() || rule.title.trim().length > 500 ||
        !['task', 'reminder'].includes(rule.kind) || !(version < 5 ? ['daily', 'monthly'] : ['daily', 'weekly', 'monthly']).includes(rule.frequency) ||
        !isCalendarDate(rule.startDate) || typeof rule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(rule.time) ||
        typeof rule.enabled !== 'boolean' || !isTimestamp(rule.createdAt) || !isTimestamp(rule.updatedAt) ||
        (rule.pausedOn !== null && !isCalendarDate(rule.pausedOn)) ||
        !(version < 5 ? ['last-day', 'skip'] : ['last-day']).includes(rule.monthOverflow) ||
        !Array.isArray(rule.steps) || rule.steps.length > MAX_STEPS ||
        !Array.isArray(rule.excludedDates) || rule.excludedDates.length > MAX_EXCLUDED_DATES) {
      fail('INVALID_ROUTINES', 'Некоректне правило повторення: перевірте назву, дату, час і періодичність.');
    }
    const weekdays = version < 5 && !Object.prototype.hasOwnProperty.call(rule, 'weekdays') ? [] : rule.weekdays;
    if (!Array.isArray(weekdays) || weekdays.length > 7 ||
        weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
        new Set(weekdays).size !== weekdays.length ||
        (rule.frequency === 'weekly' ? weekdays.length === 0 : weekdays.length !== 0)) {
      fail('INVALID_ROUTINES', 'Вибери дні тижня для щотижневого повторення — від понеділка до неділі.');
    }
    ids.add(rule.id);
    const stepIds = new Set();
    const steps = rule.steps.map((step) => {
      if (!isObject(step) || !isId(step.id) || stepIds.has(step.id) ||
          typeof step.title !== 'string' || !step.title.trim() || step.title.trim().length > 500) {
        fail('INVALID_ROUTINES', 'Некоректний крок повторюваної задачі.');
      }
      stepIds.add(step.id);
      return { id: step.id, title: step.title.trim() };
    });
    const excluded = new Set();
    for (const date of rule.excludedDates) {
      if (!isCalendarDate(date) || excluded.has(date)) fail('INVALID_ROUTINES', 'Некоректний список пропущених дат повторення.');
      excluded.add(date);
    }
    return {
      id: rule.id, title: rule.title.trim(), kind: rule.kind, frequency: rule.frequency,
      startDate: rule.startDate, time: rule.time, enabled: rule.enabled,
      createdAt: rule.createdAt, updatedAt: rule.updatedAt, steps,
      excludedDates: [...excluded].sort(), monthOverflow: 'last-day', weekdays: [...weekdays].sort((a, b) => a - b),
      pausedOn: rule.pausedOn,
    };
  });
}

export function validateTeamData(data) {
  const ancestors = new WeakSet();
  let nodes = 0;
  const invalid = () => fail('INVALID_TEAM_DATA', 'Дані команд мають бути звичайним JSON-об’єктом без циклів і службових властивостей.');
  const tooLarge = () => fail('TEAM_DATA_TOO_LARGE', 'Дані команд перевищують дозволений розмір 2 МБ.');
  const visit = (value, depth) => {
    if (++nodes > 200000 || depth > 64) tooLarge();
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > MAX_TEAM_BYTES) tooLarge(); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
    if (typeof value !== 'object' || ancestors.has(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(value).length) invalid();
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (value.length > 200000) tooLarge();
      if (Object.keys(descriptors).length !== value.length + 1) invalid();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) invalid();
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) ||
            !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
        if (key.length > MAX_TEAM_BYTES) tooLarge();
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  if (!isObject(data)) invalid();
  visit(data, 0);
  const json = JSON.stringify(data);
  if (encoder.encode(json).length > MAX_TEAM_BYTES) tooLarge();
  return JSON.parse(json);
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value, exactLength) {
  if (typeof value !== 'string' || value.length > MAX_BACKUP_BYTES ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    fail('INVALID_BACKUP', 'Резервна копія містить некоректні зашифровані дані.');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    fail('INVALID_BACKUP', 'Резервна копія містить некоректні зашифровані дані.');
  }
  if ((exactLength !== undefined && bytes.length !== exactLength) || encodeBase64(bytes) !== value) {
    fail('INVALID_BACKUP', 'Резервна копія містить некоректні зашифровані дані.');
  }
  return bytes;
}

function validateBackupObject(backup) {
  if (!isObject(backup) || backup.format !== FORMAT) {
    fail('INVALID_BACKUP', 'Оберіть JSON-копію простору «НА КОНТРОЛІ».');
  }
  if (!SUPPORTED_BACKUP_VERSIONS.includes(backup.version)) {
    fail('UNSUPPORTED_BACKUP', 'Цю версію резервної копії не підтримано. Оновіть застосунок.');
  }
  const profile = backup.profile;
  const encrypted = backup.encrypted;
  if (!isObject(profile) || !isObject(encrypted) || !isTimestamp(profile.createdAt)) {
    fail('INVALID_BACKUP', 'Резервна копія пошкоджена або має невірний формат.');
  }
  if (backup.version >= 6 && !isPinLength(profile.pinLength)) {
    fail('INVALID_BACKUP', 'Резервна копія містить некоректну довжину PIN.');
  }
  let name;
  try { name = normalizeProfileName(profile.name); } catch {
    fail('INVALID_BACKUP', 'Резервна копія містить некоректну назву простору.');
  }
  if (name !== profile.name || encrypted.algorithm !== 'AES-GCM' ||
      encrypted.kdf !== 'PBKDF2' || encrypted.hash !== 'SHA-256' || encrypted.iterations !== ITERATIONS) {
    fail('INVALID_BACKUP', 'Формат шифрування резервної копії не підтримано.');
  }
  decodeBase64(encrypted.salt, 16);
  decodeBase64(encrypted.iv, 12);
  const ciphertext = decodeBase64(encrypted.ciphertext);
  if (ciphertext.length < 16) fail('INVALID_BACKUP', 'Зашифровані дані резервної копії неповні.');
  return {
    format: FORMAT,
    version: backup.version,
    profile: { name, createdAt: profile.createdAt, ...(backup.version >= 6 ? { pinLength: profile.pinLength } : {}) },
    encrypted: {
      algorithm: 'AES-GCM', kdf: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS,
      salt: encrypted.salt, iv: encrypted.iv, ciphertext: encrypted.ciphertext,
    },
  };
}

export function parseBackup(jsonText) {
  if (typeof jsonText !== 'string') fail('INVALID_BACKUP', 'Не вдалося прочитати JSON-файл.');
  if (jsonText.length > MAX_BACKUP_BYTES || encoder.encode(jsonText).length > MAX_BACKUP_BYTES) {
    fail('BACKUP_TOO_LARGE', 'Резервна копія має бути не більшою за 10 МБ.');
  }
  let backup;
  try { backup = JSON.parse(jsonText); } catch {
    fail('INVALID_BACKUP', 'Файл не є коректним JSON. Оберіть резервну копію простору.');
  }
  return validateBackupObject(backup);
}

function isPinLength(length) {
  return length === 4 || (Number.isInteger(length) && length >= 6 && length <= 12);
}

function checkPinLength(record, pin) {
  if (record.version >= 6 && record.profile.pinLength !== pin.length) {
    fail('WRONG_PIN', 'Невірний PIN або пошкоджені зашифровані дані.');
  }
}

function associatedData(profile, version = BACKUP_VERSION) {
  return encoder.encode(JSON.stringify({ format: FORMAT, version, name: profile.name, createdAt: profile.createdAt,
    ...(version >= 6 ? { pinLength: profile.pinLength } : {}),
  }));
}

async function deriveKey(pin, salt, { allowLegacy = false } = {}) {
  validatePin(pin, { allowLegacy });
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptWorkspace(profile, workspace, key, salt) {
  const crypto = getCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ version: BACKUP_VERSION, tasks: workspace.tasks, routines: workspace.routines, teamData: workspace.teamData }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(profile), tagLength: 128 }, key, plaintext,
  );
  const encrypted = {
    algorithm: 'AES-GCM', kdf: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS,
    salt: encodeBase64(salt), iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  const backup = { format: FORMAT, version: BACKUP_VERSION, profile: { name: profile.name, createdAt: profile.createdAt, pinLength: profile.pinLength }, encrypted };
  if (encoder.encode(JSON.stringify(backup, null, 2)).length > MAX_BACKUP_BYTES) {
    fail('BACKUP_TOO_LARGE', 'Простір перевищує 10 МБ. Скоротіть кількість або довжину задач.');
  }
  return encrypted;
}

async function decryptWorkspace(backup, key) {
  let plaintext;
  try {
    plaintext = await getCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64(backup.encrypted.iv, 12), additionalData: associatedData(backup.profile, backup.version), tagLength: 128 },
      key, decodeBase64(backup.encrypted.ciphertext),
    );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('WRONG_PIN', 'Невірний PIN або пошкоджені зашифровані дані.', { cause: error });
  }
  let data;
  try { data = JSON.parse(decoder.decode(plaintext)); } catch {
    fail('INVALID_BACKUP', 'Зашифровані дані пошкоджено.');
  }
  if (!isObject(data) || data.version !== backup.version) fail('INVALID_BACKUP', 'Формат даних простору не підтримано.');
  return {
    tasks: validateTasks(data.tasks, { version: backup.version }),
    routines: backup.version < 4 && !Object.prototype.hasOwnProperty.call(data, 'routines') ? [] : validateRoutines(data.routines, { version: backup.version }),
    teamData: backup.version < 6 && !Object.prototype.hasOwnProperty.call(data, 'teamData') ? {} : validateTeamData(data.teamData),
  };
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let request;
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) { reject(mapStorageError(error)); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    let rejected = false;
    request.onblocked = () => {
      rejected = true;
      reject(new StorageError('STORAGE_BLOCKED', 'Закрийте інші вкладки «НА КОНТРОЛІ» й повторіть спробу.'));
    };
    request.onerror = () => reject(mapStorageError(request.error));
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) { database.close(); return; }
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      database.onclose = () => { databasePromise = undefined; };
      resolve(database);
    };
  }).catch((error) => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function transaction(mode, run, session) {
  const database = await openDatabase();
  const sessionState = session ? getSession(session) : null;
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    let failure;
    try {
      tx = database.transaction(STORE_NAME, mode);
      sessionState?.transactions.add(tx);
      tx.oncomplete = () => {
        sessionState?.transactions.delete(tx);
        resolve(result);
      };
      tx.onabort = () => {
        sessionState?.transactions.delete(tx);
        const revoked = session && !sessions.has(session);
        reject(failure ?? (revoked ? new StorageError('INVALID_SESSION', 'Увійдіть у простір ще раз.') : mapStorageError(tx.error)));
      };
      tx.onerror = (event) => { failure ??= mapStorageError(event.target?.error ?? tx.error); };
      run(tx.objectStore(STORE_NAME), (value) => { result = value; }, (error) => {
        failure = mapStorageError(error);
        tx.abort();
      });
    } catch (error) {
      failure = mapStorageError(error);
      if (tx) { try { tx.abort(); } catch { reject(failure); } }
      else reject(failure);
    }
  });
}

function validateRecord(record) {
  if (!isObject(record) || !isId(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    fail('INVALID_BACKUP', 'Локальні дані простору пошкоджено.');
  }
  return { id: record.id, revision: record.revision, ...validateBackupObject(record) };
}

async function readRecord(id) {
  if (!isId(id)) fail('PROFILE_NOT_FOUND', 'Простір не знайдено.');
  const record = await transaction('readonly', (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => setResult(request.result);
  });
  if (!record) fail('PROFILE_NOT_FOUND', 'Простір уже видалено або його немає на цьому пристрої.');
  return validateRecord(record);
}

function newId() {
  const crypto = getCrypto();
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createSession(record, workspace, key, pinLength) {
  const session = {
    id: record.id, name: record.profile.name, createdAt: record.profile.createdAt,
    tasks: workspace.tasks, routines: workspace.routines, key, revision: record.revision, pinLength,
  };
  sessions.set(session, {
    id: record.id, name: record.profile.name, createdAt: record.profile.createdAt,
    key, salt: decodeBase64(record.encrypted.salt, 16), revision: record.revision, pinLength,
    transactions: new Set(),
    routines: validateRoutines(workspace.routines),
    tasks: validateTasks(workspace.tasks),
    teamData: validateTeamData(workspace.teamData),
  });
  return session;
}

function getSession(session) {
  const state = isObject(session) && sessions.get(session);
  if (!state) fail('INVALID_SESSION', 'Увійдіть у простір ще раз.');
  return state;
}

export function revokeSession(session) {
  if (!isObject(session)) return;
  const state = sessions.get(session);
  sessions.delete(session);
  if (state) {
    for (const tx of state.transactions) {
      try { tx.abort(); } catch { /* An already committed transaction cannot be aborted. */ }
    }
    state.transactions.clear();
    state.key = null;
    state.routines = [];
    state.tasks = [];
    state.teamData = {};
    state.salt.fill(0);
  }
  session.key = null;
  session.tasks = [];
  session.routines = [];
}

function checkRevision(record, expected) {
  if (!record) fail('PROFILE_NOT_FOUND', 'Простір уже видалено. Поверніться до вибору простору.');
  if (record.revision !== expected) {
    fail('CONFLICT', 'Простір змінено в іншій вкладці. Вийдіть і ввійдіть знову, щоб завантажити актуальні дані.');
  }
}

export function summarizeProfiles(records) {
  const profiles = [];
  for (const record of records) {
    // An unusable ID cannot be selected, but its record is never deleted here.
    if (!isObject(record) || !isId(record.id)) continue;
    try {
      const validated = validateRecord(record);
      profiles.push({ id: validated.id, name: validated.profile.name, createdAt: validated.profile.createdAt, pinLength: validated.profile.pinLength ?? null });
    } catch {
      profiles.push({ id: record.id, name: 'Пошкоджений простір', createdAt: null, damaged: true });
    }
  }
  return profiles.sort((a, b) => Number(Boolean(a.damaged)) - Number(Boolean(b.damaged)) ||
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
}

export async function listProfiles() {
  const records = await transaction('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result);
  });
  return summarizeProfiles(records);
}

export async function createProfile(name, pin) {
  validatePin(pin);
  const profile = { name: normalizeProfileName(name), createdAt: new Date().toISOString(), pinLength: pin.length };
  const salt = getCrypto().getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  const record = {
    id: newId(), revision: 1, format: FORMAT, version: BACKUP_VERSION, profile,
    encrypted: await encryptWorkspace(profile, { tasks: [], routines: [], teamData: {} }, key, salt),
  };
  await transaction('readwrite', (store) => store.add(record));
  return createSession(record, { tasks: [], routines: [], teamData: {} }, key, pin.length);
}

export async function unlockProfile(id, pin) {
  validatePin(pin, { allowLegacy: true });
  const record = await readRecord(id);
  checkPinLength(record, pin);
  const key = await deriveKey(pin, decodeBase64(record.encrypted.salt, 16), { allowLegacy: true });
  return createSession(record, await decryptWorkspace(record, key), key, pin.length);
}

export async function saveTasks(session, tasks) {
  return saveWorkspace(session, { tasks, routines: getSession(session).routines });
}

export async function saveWorkspace(session, workspace) {
  return commitWorkspace(session, workspace, getSession(session).teamData, true);
}

export function readTeamData(session) {
  return validateTeamData(getSession(session).teamData);
}

export async function saveTeamData(session, data) {
  const state = getSession(session);
  return commitWorkspace(session, { tasks: state.tasks, routines: state.routines }, data, false);
}

async function commitWorkspace(session, workspace, teamData, enforceCompletion) {
  const state = getSession(session);
  const revision = state.revision;
  if (!isObject(workspace)) fail('INVALID_TASKS', 'Некоректні дані простору.');
  const validatedTasks = validateTasks(workspace.tasks, { enforceCompletion });
  const validatedRoutines = validateRoutines(workspace.routines);
  const validatedTeamData = validateTeamData(teamData);
  const profile = { name: state.name, createdAt: state.createdAt, pinLength: state.pinLength };
  const encrypted = await encryptWorkspace(profile, { tasks: validatedTasks, routines: validatedRoutines, teamData: validatedTeamData }, state.key, state.salt);
  getSession(session);
  const updated = { id: state.id, revision: revision + 1, format: FORMAT, version: BACKUP_VERSION, profile, encrypted };
  await transaction('readwrite', (store, setResult, abort) => {
    const request = store.get(state.id);
    request.onsuccess = () => {
      try { getSession(session); checkRevision(request.result, revision); store.put(updated); }
      catch (error) { abort(error); }
    };
  }, session);
  getSession(session);
  state.revision = updated.revision;
  state.routines = validateRoutines(validatedRoutines);
  state.tasks = validateTasks(validatedTasks);
  state.teamData = validatedTeamData;
  session.revision = updated.revision;
  session.tasks = validatedTasks;
  session.routines = validatedRoutines;
  return session;
}

export async function changePin(session, currentPin, newPin) {
  const state = getSession(session);
  const revision = state.revision;
  validatePin(currentPin, { allowLegacy: true });
  validatePin(newPin);
  const record = await readRecord(state.id);
  getSession(session);
  checkRevision(record, revision);
  checkPinLength(record, currentPin);
  // Verify the supplied current PIN afresh; possession of an unlocked session
  // alone does not authorize replacing the PIN.
  const currentKey = await deriveKey(currentPin, decodeBase64(record.encrypted.salt, 16), { allowLegacy: true });
  getSession(session);
  const workspace = await decryptWorkspace(record, currentKey);
  getSession(session);
  const salt = getCrypto().getRandomValues(new Uint8Array(16));
  const key = await deriveKey(newPin, salt);
  getSession(session);
  const profile = { name: record.profile.name, createdAt: record.profile.createdAt, pinLength: newPin.length };
  const encrypted = await encryptWorkspace(profile, workspace, key, salt);
  getSession(session);
  const updated = { id: state.id, revision: revision + 1, format: FORMAT, version: BACKUP_VERSION, profile, encrypted };
  await transaction('readwrite', (store, setResult, abort) => {
    const request = store.get(state.id);
    request.onsuccess = () => {
      try { getSession(session); checkRevision(request.result, revision); store.put(updated); }
      catch (error) { abort(error); }
    };
  }, session);
  getSession(session);
  // No session state is changed until the encrypted replacement commits.
  state.key = key;
  state.salt = salt;
  state.pinLength = newPin.length;
  state.revision = updated.revision;
  state.routines = validateRoutines(workspace.routines);
  state.tasks = validateTasks(workspace.tasks);
  state.teamData = validateTeamData(workspace.teamData);
  session.key = key;
  session.pinLength = newPin.length;
  session.revision = updated.revision;
  session.tasks = workspace.tasks;
  session.routines = workspace.routines;
  return session;
}

export async function deleteProfile(session) {
  const state = getSession(session);
  const revision = state.revision;
  await transaction('readwrite', (store, setResult, abort) => {
    const request = store.get(state.id);
    request.onsuccess = () => {
      try { getSession(session); checkRevision(request.result, revision); store.delete(state.id); }
      catch (error) { abort(error); }
    };
  }, session);
  revokeSession(session);
}

export async function exportProfile(session) {
  const state = getSession(session);
  const revision = state.revision;
  const key = state.key;
  const salt = state.salt.slice();
  const pinLength = state.pinLength;
  const record = await readRecord(state.id);
  checkRevision(getSession(session), revision);
  checkRevision(record, revision);
  const profile = { name: record.profile.name, createdAt: record.profile.createdAt, pinLength };
  let encrypted = record.encrypted;
  if (record.version !== BACKUP_VERSION) {
    // Export never changes the saved record or its revision. Legacy data is
    // upgraded inside the portable copy, with matching v6 AES associated data.
    const workspace = await decryptWorkspace(record, key);
    checkRevision(getSession(session), revision);
    encrypted = await encryptWorkspace(profile, workspace, key, salt);
    checkRevision(getSession(session), revision);
  }
  const json = JSON.stringify({ format: FORMAT, version: BACKUP_VERSION, profile, encrypted }, null, 2);
  if (encoder.encode(json).length > MAX_BACKUP_BYTES) fail('BACKUP_TOO_LARGE', 'Резервна копія перевищує 10 МБ.');
  return json;
}

export async function importProfile(jsonText, pin) {
  const backup = parseBackup(jsonText);
  validatePin(pin, { allowLegacy: true });
  checkPinLength(backup, pin);
  const key = await deriveKey(pin, decodeBase64(backup.encrypted.salt, 16), { allowLegacy: true });
  const workspace = await decryptWorkspace(backup, key);
  // Authentication and task validation always finish before any database write.
  // Reencrypt even legacy backups with a fresh IV and a v6 envelope/payload,
  // preserving the user's existing PIN rather than silently replacing it.
  const profile = { name: backup.profile.name, createdAt: backup.profile.createdAt, pinLength: pin.length };
  const encrypted = await encryptWorkspace(profile, workspace, key, decodeBase64(backup.encrypted.salt, 16));
  const record = { id: newId(), revision: 1, ...backup, version: BACKUP_VERSION, profile, encrypted };
  await transaction('readwrite', (store) => store.add(record));
  return createSession(record, workspace, key, pin.length);
}

export async function requestPersistence() {
  try {
    if (!globalThis.navigator?.storage?.persist) return false;
    if (await globalThis.navigator.storage.persisted?.()) return true;
    return Boolean(await globalThis.navigator.storage.persist());
  } catch { return false; }
}
