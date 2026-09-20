/** Trusted administrator CLI. Never import this file into the browser bundle. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLogin, loginToEmail, validateNewPassword } from '../js/login.js';

export class AccountAdminError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AccountAdminError';
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => { throw new AccountAdminError(code, message, details); };
const safeCode = error => typeof error?.code === 'string' && /^[a-zA-Z0-9/_-]{1,80}$/u.test(error.code) ? error.code : 'remote-operation-failed';
export const temporaryPassword = () => randomBytes(24).toString('base64url');

export function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const [command, ...flags] = argv;
  if (!['create', 'reset'].includes(command)) fail('USAGE', 'Команда має бути create або reset. Довідка: --help.');
  const options = { command, dryRun: false, resume: false };
  const seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!['--project', '--login', '--dry-run', '--resume'].includes(flag) || seen.has(flag)) fail('USAGE', 'Невідомий або повторений параметр. Паролі й credentials не передаються аргументами.');
    seen.add(flag);
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--resume') options.resume = true;
    else {
      const value = flags[++i];
      if (!value || value.startsWith('--')) fail('USAGE', 'Для --project і --login потрібні значення.');
      options[flag.slice(2)] = value;
    }
  }
  return normalizeOptions(options);
}

function normalizeOptions(options) {
  if (!['create', 'reset'].includes(options?.command)) fail('USAGE', 'Команда має бути create або reset.');
  if (options.resume && options.command !== 'reset') fail('USAGE', '--resume дозволено тільки для reset після перевірки незавершеної операції.');
  let login, email;
  try {
    login = normalizeLogin(options.login);
    email = loginToEmail(login, options.project);
  } catch (error) { fail('USAGE', error.message); }
  return { command: options.command, project: options.project, login, email, dryRun: Boolean(options.dryRun), resume: Boolean(options.resume) };
}

function checkGrant(data) {
  if (!data || typeof data.uid !== 'string' || !data.uid || data.uid.length > 128 || typeof data.enabled !== 'boolean' || typeof data.mustChangePassword !== 'boolean' || !Number.isSafeInteger(data.resetAfter) || data.resetAfter < 0 || Object.keys(data).some(key => !['uid', 'enabled', 'mustChangePassword', 'resetAfter'].includes(key))) {
    fail('INVALID_GRANT', 'Документ USERS пошкоджено: потрібні uid, enabled, mustChangePassword, resetAfter.');
  }
  return data;
}

/** Injected adapters make all ordering/failure tests independent of Firebase. */
export async function manageAccount(rawOptions, { auth, grants, passwordFactory = temporaryPassword, now = Date.now } = {}) {
  const options = normalizeOptions(rawOptions);
  const { command, project, login, email, resume } = options;
  if (options.dryRun) return { command, project, login, email, grantPath: `USERS/${login}`, resume, dryRun: true };
  if (!auth || !grants) fail('ADAPTER_REQUIRED', 'Потрібне довірене адміністративне підключення.');
  const password = passwordFactory();
  validateNewPassword(password);
  if (password.length < 20) fail('WEAK_TEMPORARY_PASSWORD', 'Тимчасовий пароль має містити щонайменше 20 випадкових символів.');
  let uid, lock, stage = 'preflight';
  try {
    const existing = await grants.read(login);
    if (command === 'create') {
      if (existing) fail('LOGIN_EXISTS', 'Логін уже існує. Для відновлення використовуйте reset; новий UID не створюється.');
      try {
        await auth.getUserByEmail(email);
        fail('AUTH_EXISTS', 'Технічний Auth-акаунт уже існує. Перевірте його UID та документ USERS у Console; автоматичної заміни немає.');
      } catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
      stage = 'create-auth';
      const created = await auth.createUser({ email, password, disabled: true });
      uid = created.uid;
      if (typeof uid !== 'string' || !uid) fail('INVALID_AUTH_RESPONSE', 'Auth не повернув коректний UID.');
      stage = 'create-grant';
      lock = await grants.create(login, { uid, enabled: false, mustChangePassword: true, resetAfter: 0 });
      stage = 'enable-auth';
      await auth.updateUser(uid, { disabled: false });
      stage = 'enable-grant';
      await grants.enable(login, lock, { uid, enabled: true, mustChangePassword: true, resetAfter: 0 });
      return { command, project, login, email, uid, temporaryPassword: password, mustChangePassword: true, resetAfter: 0 };
    }
    if (!existing) fail('LOGIN_NOT_FOUND', 'Документ USERS для цього логіна не знайдено. Не видаляйте Auth-акаунт для відновлення.');
    const grant = checkGrant(existing.data);
    uid = grant.uid;
    const account = await auth.getUser(uid);
    if (account.uid !== uid || account.email?.toLowerCase() !== email) fail('UID_MISMATCH', 'UID у USERS не відповідає технічному Auth-акаунту. Жодного пароля не змінено.');
    stage = 'disable-grant';
    // A write-time precondition admits one default reset. Disabled records need
    // explicit --resume; another operator's edits invalidate our final enable.
    lock = await grants.disable(login, uid, { resume });
    stage = 'update-password';
    await auth.updateUser(uid, { password, disabled: false });
    stage = 'revoke-sessions';
    await auth.revokeRefreshTokens(uid);
    const seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 1) fail('INVALID_CLOCK', 'Перевірте годинник адміністративного пристрою.');
    const resetAfter = Math.max(grant.resetAfter, lock.resetAfter ?? 0, seconds);
    stage = 'enable-grant';
    await grants.enable(login, lock, { uid, enabled: true, mustChangePassword: true, resetAfter });
    return { command, project, login, email, uid, temporaryPassword: password, mustChangePassword: true, resetAfter, signInAfter: new Date((resetAfter + 1) * 1000).toISOString() };
  } catch (error) {
    if (!lock && error instanceof AccountAdminError) throw error;
    const details = { stage, uid, recoveryRequired: Boolean(uid) && stage !== 'preflight', remoteCode: safeCode(error), stateUncertain: stage === 'enable-grant' || stage === 'create-auth' || stage === 'disable-grant' || stage === 'create-grant' };
    let message = `Операцію не завершено на кроці ${stage}.`;
    if (lock && stage !== 'enable-grant') message += ' Доступ USERS залишено вимкненим; після усунення причини повторіть reset із --resume.';
    else if (details.stateUncertain) message += ' Перевірте стан Auth і USERS у Console: після мережевої помилки результат останнього запису може бути невідомий.';
    else message += ' Перевірте адміністративні права й підключення.';
    if (uid) message += ' UID збережено; не видаляйте Auth-акаунт.';
    throw new AccountAdminError('ADMIN_OPERATION_FAILED', message, details);
  }
}

/** Firestore compare-and-set adapter. SDK credentials never enter app files. */
export function firestoreGrants(db) {
  const ref = login => db.collection('USERS').doc(login);
  return {
    async read(login) {
      const snapshot = await ref(login).get();
      return snapshot.exists ? { data: snapshot.data(), revision: snapshot.updateTime } : null;
    },
    async create(login, data) {
      const result = await ref(login).create(checkGrant(data));
      return { uid: data.uid, revision: result.writeTime };
    },
    async disable(login, uid, { resume = false } = {}) {
      const snapshot = await ref(login).get();
      if (!snapshot.exists) fail('LOGIN_NOT_FOUND', 'Документ USERS уже відсутній.');
      const data = checkGrant(snapshot.data());
      if (data.uid !== uid) fail('UID_MISMATCH', 'Прив’язку UID змінено іншим адміністратором.');
      if (!data.enabled && !resume) fail('ALREADY_DISABLED', 'Доступ уже вимкнено або reset ще виконується. Після перевірки незавершеної операції використовуйте --resume; не запускайте його паралельно.');
      const result = await ref(login).update({ enabled: false }, { lastUpdateTime: snapshot.updateTime });
      return { uid, revision: result.writeTime, resetAfter: data.resetAfter };
    },
    async enable(login, lock, data) {
      checkGrant(data);
      if (!lock?.revision || lock.uid !== data.uid) fail('UID_MISMATCH', 'Немає чинного підтвердження адміністративної операції.');
      await ref(login).update(data, { lastUpdateTime: lock.revision });
    },
  };
}

export const HELP = `Створення: node scripts/manage-accounts.mjs create --project PROJECT_ID --login LOGIN
Скидання: node scripts/manage-accounts.mjs reset --project PROJECT_ID --login LOGIN
Перевірка без мережі: додайте --dry-run
Відновлення перевіреної перерваної операції: reset ... --resume
Пароль генерується випадково й показується тільки після успіху. Потрібні довірені ADC.
Не запускайте --resume паралельно; не передавайте паролі або service account JSON у параметрах.`;

export async function runCli(argv, { connect, output = console.log, errorOutput = console.error } = {}) {
  let connection;
  try {
    const options = parseArguments(argv);
    if (options.help) { output(HELP); return 0; }
    if (options.resume && !options.dryRun) errorOutput('УВАГА: --resume призначено для перевіреного відновлення одним адміністратором. Переконайтеся, що інша операція не виконується.');
    if (!options.dryRun) connection = await (connect || connectAdmin)(options.project);
    const result = await manageAccount(options, connection);
    output(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const controlled = error instanceof AccountAdminError ? error : new AccountAdminError('ADMIN_CONNECTION_FAILED', 'Не вдалося відкрити адміністративний сеанс. Перевірте ADC, projectId, права Auth/Firestore та інструкцію.', { remoteCode: safeCode(error) });
    errorOutput(JSON.stringify({ error: controlled.code, message: controlled.message, ...(controlled.stage ? { stage: controlled.stage } : {}), ...(controlled.uid ? { uid: controlled.uid } : {}), ...(controlled.remoteCode ? { remoteCode: controlled.remoteCode } : {}), ...(controlled.stateUncertain ? { stateUncertain: true } : {}) }, null, 2));
    return 1;
  } finally {
    try { await connection?.close?.(); }
    catch { errorOutput('Не вдалося закрити адміністративне підключення. Це не скасовує вже підтверджений результат операції.'); }
  }
}

async function connectAdmin(projectId) {
  const [{ initializeApp, applicationDefault, deleteApp }, { getAuth }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  const app = initializeApp({ projectId, credential: applicationDefault() }, `nk-admin-${randomBytes(8).toString('hex')}`);
  return { auth: getAuth(app), grants: firestoreGrants(getFirestore(app)), close: () => deleteApp(app) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
