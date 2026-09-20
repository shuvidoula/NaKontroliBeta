/** Firebase Spark transport. Personal task data never enters this module. */
import { initializeApp, deleteApp, initializeAuth, inMemoryPersistence,
  signInWithEmailAndPassword, updatePassword, getIdTokenResult, signOut,
  initializeFirestore, memoryLocalCache, connectAuthEmulator, connectFirestoreEmulator, doc, collection, getDocFromServer, getDocsFromServer,
  query, where, runTransaction, serverTimestamp, Timestamp, limit, orderBy, terminate } from './vendor/firebase.js';
import { normalizeLogin, loginToEmail, validateNewPassword } from './login.js';

const clone = value => JSON.parse(JSON.stringify(value));
const bytes64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const digest = async value => bytes64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const publicIdentity = identity => ({ id: identity.id, alias: identity.alias, sign: cleanKey(identity.sign), box: cleanKey(identity.box) });
const cleanKey = key => ({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
// Firestore sorts map keys. Protocol v1 signs JSON in this fixed field order.
// Rebuild it (including nested step records) before signature/AES-GCM verification.
const restoreEnvelope = envelope => {
  const h = envelope.header;
  const header = { v: h.v, epoch: h.epoch, id: h.id, teamId: h.teamId, senderId: h.senderId, kind: h.kind, taskId: h.taskId, recipients: h.recipients };
  if (h.kind === 'task-create') Object.assign(header, { version: h.version, assignee: h.assignee, steps: h.steps.map(step => ({ id: step.id, assignee: step.assignee })) });
  else if (h.kind === 'task-step') Object.assign(header, { version: h.version, done: h.done, stepId: h.stepId });
  else if (h.kind === 'task-complete') Object.assign(header, { version: h.version, done: h.done });
  return { header, iv: envelope.iv, cipher: envelope.cipher, signature: envelope.signature };
};
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function translate(error) {
  if (error.status || error.name === 'AbortError') return error;
  const messages = {
    'permission-denied': 'Firebase відхилив доступ. Перевірте правила, власника проєкту та погодження учасника.',
    'unavailable': 'Firebase тимчасово недоступний. Черга залишається у вашому просторі.',
    'resource-exhausted': 'Вичерпано квоту Firebase. Дані та невідправлені дії залишилися локально.',
    'auth/invalid-credential': 'Неправильний логін або пароль.',
    'auth/user-not-found': 'Неправильний логін або пароль.',
    'auth/wrong-password': 'Неправильний логін або пароль.',
    'auth/user-disabled': 'Акаунт вимкнено. Зверніться до адміністратора.',
    'auth/weak-password': 'Пароль не відповідає вимогам Firebase. Використайте щонайменше 12 символів.',
    'auth/invalid-email': 'Перевірте логін і налаштування Firebase.',
    'auth/requires-recent-login': 'Для зміни пароля вийдіть із Firebase та увійдіть знову.',
    'auth/operation-not-allowed': 'У Firebase увімкніть Authentication → Email/Password.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Перевірте apiKey у налаштуваннях Firebase.',
    'auth/too-many-requests': 'Firebase тимчасово обмежив спроби входу. Спробуйте пізніше.',
    'auth/network-request-failed': 'Немає з’єднання з Firebase. Перевірте мережу.',
  };
  const result = new Error(messages[error.code] || `Firebase: ${error.message || error.code || 'помилка з’єднання'}`);
  result.code = error.code;
  if (error.code === 'permission-denied') result.status = 403;
  return result;
}

export async function createFirebaseTransport({ config, identity, check = () => {}, emulator = null }) {
  check();
  const app = initializeApp(config, `nk-${crypto.randomUUID()}`), auth = initializeAuth(app, { persistence: inMemoryPersistence }), db = initializeFirestore(app, { localCache: memoryLocalCache() });
  let closed = false, boundUid = null, accountInfo = null, temporaryPasswordHash = null;
  const guard = () => { if (closed) throw new DOMException('Сеанс завершено.', 'AbortError'); check(); };
  const hook = globalThis.__NA_KONTROLI_FIREBASE_EMULATORS__;
  if (!emulator && hook && ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) && config.projectId.startsWith('demo-')) emulator = hook;
  if (emulator) {
    if (!['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) || !config.projectId.startsWith('demo-')) { await deleteApp(app); fail('Емулятори дозволені лише локально для demo-проєктів.'); }
    const authPort = emulator.authPort || 9099, firestorePort = emulator.firestorePort || 8080;
    if (emulator.auth && emulator.auth !== 'http://127.0.0.1:9099' || emulator.firestore && (emulator.firestore.host !== '127.0.0.1' || emulator.firestore.port !== 8080)) { await deleteApp(app); fail('Некоректна адреса емулятора.'); }
    connectAuthEmulator(auth, `http://127.0.0.1:${authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', firestorePort);
  }
  guard();
  const ref = (...path) => doc(db, ...path);
  const teamRef = teamId => ref('teams', teamId);
  const memberRef = (teamId, id) => ref('teams', teamId, 'members', id);
  const membershipRef = (id, teamId) => ref('identities', id, 'teams', teamId);
  const actor = publicIdentity(identity);
  const authStatus = () => auth.currentUser && accountInfo ? { uid: auth.currentUser.uid, login: accountInfo.login, mustChangePassword: accountInfo.mustChangePassword } : null;
  async function safe(operation) { guard(); try { const result = await operation(); guard(); return result; } catch (error) { throw translate(error); } }
  async function bind(validateOnly = false) {
    guard();
    const uid = auth.currentUser?.uid; if (!uid) fail('Увійдіть до Firebase.', 401);
    if (boundUid === uid) return;
    await runTransaction(db, async tx => {
      guard();
      const user = await tx.get(ref('users', uid)); guard();
      const known = await tx.get(ref('identities', identity.id)); guard();
      if (user.exists() || known.exists()) {
        if (!user.exists() || !known.exists() || user.data().identityId !== identity.id || known.data().uid !== uid || ['sign', 'box'].some(type => ['kty', 'crv', 'x', 'y'].some(part => known.data()[type][part] !== actor[type][part]))) fail('Цей акаунт Firebase уже прив’язаний до іншого простору. Відкрийте його початковий простір або імпортуйте його резервну копію.', 403);
        return;
      }
      if (validateOnly) return;
      guard(); tx.set(ref('users', uid), { identityId: identity.id });
      tx.set(ref('identities', identity.id), { ...actor, uid });
    }); guard(); if (!validateOnly) boundUid = uid;
  }
  async function readGrant(login) {
    const current = auth.currentUser;
    if (!current) fail('Увійдіть до Firebase.', 401);
    const snapshot = await getDocFromServer(ref('USERS', login)); guard();
    const grant = snapshot.exists() ? snapshot.data() : null;
    if (!grant || grant.uid !== current.uid || typeof grant.mustChangePassword !== 'boolean' || !Number.isInteger(grant.resetAfter) || grant.resetAfter < 0) fail('Адміністратор ще не надав доступ цьому логіну.', 403);
    if (grant.enabled !== true) fail('Акаунт вимкнено. Зверніться до адміністратора.', 403);
    const token = await getIdTokenResult(current); guard();
    if (!Number.isFinite(token.claims.auth_time) || token.claims.auth_time <= grant.resetAfter) fail('Попередній сеанс скинуто адміністратором. Увійдіть ще раз із новим тимчасовим паролем.', 401);
    return { login, mustChangePassword: grant.mustChangePassword, resetAfter: grant.resetAfter };
  }
  async function account(loginValue, password) {
    return safe(async () => {
      const login = normalizeLogin(loginValue);
      accountInfo = null; boundUid = null; temporaryPasswordHash = null;
      try {
        await signInWithEmailAndPassword(auth, loginToEmail(login, config.projectId), password); guard();
        accountInfo = await readGrant(login);
        if (accountInfo.mustChangePassword) { temporaryPasswordHash = await digest(password); guard(); }
        // Validate an existing Space before allowing any password mutation.
        await bind(accountInfo.mustChangePassword);
      } catch (error) {
        accountInfo = null; boundUid = null; temporaryPasswordHash = null;
        if (auth.currentUser) await signOut(auth);
        throw error;
      }
      return authStatus();
    });
  }
  async function changePassword(newPassword) {
    return safe(async () => {
      validateNewPassword(newPassword);
      if (!auth.currentUser || !accountInfo) fail('Спочатку увійдіть з логіном і паролем адміністратора.', 401);
      if (temporaryPasswordHash && await digest(newPassword) === temporaryPasswordHash) fail('Оберіть власний пароль, відмінний від тимчасового.');
      guard();
      accountInfo = await readGrant(accountInfo.login);
      await bind(accountInfo.mustChangePassword);
      const current = auth.currentUser, previousGrant = { ...accountInfo };
      await updatePassword(current, newPassword); guard();
      try {
        if (previousGrant.mustChangePassword) await runTransaction(db, async tx => {
          guard();
          const target = ref('USERS', previousGrant.login), grant = await tx.get(target); guard();
          if (!grant.exists() || grant.data().uid !== current.uid || grant.data().enabled !== true || grant.data().resetAfter !== previousGrant.resetAfter) fail('Доступ змінився під час зміни пароля. Зверніться до адміністратора.', 403);
          if (grant.data().mustChangePassword) tx.update(target, { mustChangePassword: false });
        });
        guard(); accountInfo = await readGrant(previousGrant.login);
        await bind();
        temporaryPasswordHash = null;
      } catch (error) {
        // Auth and Firestore are separate services; retrying with the new password is safe.
        const failure = translate(error);
        failure.message = `Пароль у Firebase Auth уже змінено. Завершення налаштування не вдалося: ${failure.message} Повторіть дію; для наступного входу використайте новий пароль.`;
        throw failure;
      }
      return authStatus();
    });
  }
  async function refreshAccount() {
    const login = accountInfo?.login;
    if (!login) fail('Увійдіть до Firebase.', 401);
    try { accountInfo = await readGrant(login); }
    catch (error) {
      if (error.status === 401 || error.status === 403 || ['permission-denied', 'unauthenticated', 'auth/user-disabled', 'auth/user-token-expired', 'auth/id-token-revoked', 'auth/invalid-user-token'].includes(error.code)) {
        accountInfo = null; boundUid = null; temporaryPasswordHash = null;
        await signOut(auth);
        fail('Доступ до Firebase змінено або сеанс скинуто. Увійдіть з актуальним логіном і паролем адміністратора. Локальні дані та черга збережені.', 401);
      }
      throw error;
    }
    if (accountInfo.mustChangePassword) fail('Адміністратор запросив зміну пароля. Спочатку встановіть власний пароль; локальна черга збережена.', 401);
  }
  async function index() {
    await refreshAccount(); guard();
    const entries = await getDocsFromServer(collection(db, 'identities', identity.id, 'teams')); guard();
    const teams = [];
    for (const entry of entries.docs) {
      const item = entry.data();
      if (item.status === 'pending') { teams.push({ id: entry.id, status: 'pending', members: [], pending: [] }); continue; }
      const members = await getDocsFromServer(collection(db, 'teams', entry.id, 'members')); guard();
      const people = members.docs.map(d => ({ ...d.data() }));
      const mine = people.find(m => m.id === identity.id);
      let pending = [];
      if (['owner', 'admin'].includes(mine?.role)) {
        const requests = await getDocsFromServer(collection(db, 'teams', entry.id, 'requests')); guard();
        pending = requests.docs.map(d => { const { inviteId, ...person } = d.data(); return person; });
      }
      teams.push({ id: entry.id, status: 'approved', members: people.map(({ wrap, ...person }) => person), pending, wrap: mine?.wrap || null });
    }
    const bootstrap = await getDocFromServer(ref('system', 'bootstrap')); guard();
    return { serverId: `firebase:${config.projectId}`, isProjectOwner: bootstrap.exists() && bootstrap.data().ownerUid === auth.currentUser.uid, teams };
  }
  async function create({ teamId }) {
    return runTransaction(db, async tx => {
      guard(); const previous = await tx.get(teamRef(teamId)); guard();
      if (previous.exists()) { if (previous.data().ownerId !== identity.id) fail('Такий ідентифікатор команди вже існує.', 409); return { teamId }; }
      tx.set(teamRef(teamId), { ownerId: identity.id, memberIds: [identity.id], lastAdded: identity.id, epoch: 1, createdAt: serverTimestamp() });
      tx.set(memberRef(teamId, identity.id), { ...actor, role: 'owner', wrap: null });
      tx.set(membershipRef(identity.id, teamId), { teamId, status: 'approved' });
      return { teamId };
    });
  }
  async function invite({ teamId }) {
    const token = bytes64(crypto.getRandomValues(new Uint8Array(32))), id = await digest(token); guard();
    const expires = Date.now() + 14 * 60000;
    await runTransaction(db, async tx => { guard(); tx.set(ref('invites', id), { teamId, creator: identity.id, expiresAt: Timestamp.fromMillis(expires), claimedBy: null }); });
    return { token, expires };
  }
  async function join({ token }) {
    const inviteId = await digest(token); guard();
    return runTransaction(db, async tx => {
      guard(); const invitation = await tx.get(ref('invites', inviteId)); guard();
      if (!invitation.exists() || invitation.data().claimedBy || invitation.data().expiresAt.toMillis() <= Date.now()) fail('Запрошення використане або прострочене.', 403);
      const { teamId } = invitation.data();
      tx.update(ref('invites', inviteId), { claimedBy: identity.id });
      tx.set(ref('teams', teamId, 'requests', identity.id), { ...actor, inviteId });
      tx.set(membershipRef(identity.id, teamId), { teamId, status: 'pending' });
      return { teamId };
    });
  }
  async function approve({ teamId, memberId, wrap }) {
    return runTransaction(db, async tx => {
      guard(); const team = await tx.get(teamRef(teamId)); guard();
      const candidate = await tx.get(ref('teams', teamId, 'requests', memberId)); guard();
      if (!candidate.exists()) fail('Запит уже опрацьовано.', 409);
      const { inviteId, ...person } = candidate.data();
      if (team.data().memberIds.length >= 30) fail('Максимум 30 учасників у команді.');
      tx.update(teamRef(teamId), { memberIds: [...team.data().memberIds, memberId], lastAdded: memberId });
      tx.set(memberRef(teamId, memberId), { ...person, role: 'member', wrap });
      tx.delete(ref('teams', teamId, 'requests', memberId));
      tx.update(membershipRef(memberId, teamId), { status: 'approved' });
      return { approved: true };
    });
  }
  async function role({ teamId, memberId, role: nextRole }) {
    await runTransaction(db, async tx => { guard(); tx.update(memberRef(teamId, memberId), { role: nextRole }); });
    return { changed: true };
  }
  async function send({ envelope }) {
    const h = envelope.header, hash = await digest(JSON.stringify(['NK-TEAM-EVENT-1', h, envelope.iv, envelope.cipher])); guard();
    const receiptRef = ref('teams', h.teamId, 'receipts', h.id), eventRef = ref('teams', h.teamId, 'events', h.id), taskRef = ref('teams', h.teamId, 'tasks', h.taskId);
    return runTransaction(db, async tx => {
      guard(); const previous = await tx.get(receiptRef); guard();
      if (previous.exists()) {
        const receipt = previous.data();
        if (receipt.hash !== hash || receipt.senderId !== identity.id) fail('ID події вже має інший вміст.', 409);
        return { accepted: true, status: receipt.acks.length === receipt.recipients.length ? 'delivered' : 'pending' };
      }
      let task;
      if (h.kind !== 'snapshot') {
        const old = await tx.get(taskRef); guard();
        if (h.kind === 'task-create') {
          if (old.exists()) fail('Така задача вже є.', 409);
          task = { creator: identity.id, assignee: h.assignee, version: 1, done: false, steps: h.steps, stepIds: h.steps.map(s => s.id), completed: [], lastMessage: h.id };
        } else {
          if (!old.exists() || old.data().version + 1 !== h.version) fail('Версія задачі змінилася. Оновіть дані та повторіть дію.', 409);
          task = old.data(); task.version = h.version; task.lastMessage = h.id;
          if (h.kind === 'task-step') { task.completed = h.done ? [...new Set([...task.completed, h.stepId])] : task.completed.filter(id => id !== h.stepId); if (!h.done) task.done = false; }
          else if (h.kind === 'task-complete') task.done = h.done;
          else fail('Невідома подія.');
        }
      }
      guard();
      if (task) tx.set(taskRef, task);
      tx.set(eventRef, { envelope: clone(envelope), hash, senderId: identity.id, recipients: h.recipients, pending: h.recipients, createdAt: serverTimestamp() });
      tx.set(receiptRef, { hash, senderId: identity.id, recipients: h.recipients, acks: [], createdAt: serverTimestamp(), kind: h.kind, taskId: h.taskId });
      return { accepted: true, status: 'pending' };
    });
  }
  async function inbox({ teamId }) {
    const messages = await getDocsFromServer(query(collection(db, 'teams', teamId, 'events'), where('pending', 'array-contains', identity.id), orderBy('createdAt'), limit(25))); guard();
    const pending = [];
    for (const message of messages.docs) {
      const receipt = await getDocFromServer(ref('teams', teamId, 'receipts', message.id)); guard();
      if (receipt.exists() && !receipt.data().acks.includes(identity.id)) pending.push({ envelope: restoreEnvelope(message.data().envelope), hash: message.data().hash });
    }
    pending.sort((a, b) => Number(b.envelope.header.kind === 'snapshot') - Number(a.envelope.header.kind === 'snapshot'));
    return { messages: pending };
  }
  async function ack({ teamId, id, hash, epoch, recipient }) {
    if (recipient !== identity.id || epoch !== 1) fail('Некоректне підтвердження.', 403);
    return runTransaction(db, async tx => {
      guard(); const receiptRef = ref('teams', teamId, 'receipts', id), receipt = await tx.get(receiptRef); guard();
      if (!receipt.exists() || receipt.data().hash !== hash || !receipt.data().recipients.includes(identity.id)) fail('Некоректне підтвердження.', 403);
      const data = receipt.data(), acks = [...new Set([...data.acks, identity.id])];
      if (acks.length !== data.acks.length) {
        tx.update(receiptRef, { acks });
        if (acks.length < data.recipients.length) tx.update(ref('teams', teamId, 'events', id), { pending: data.recipients.filter(p => !acks.includes(p)) });
      }
      if (acks.length === data.recipients.length) tx.delete(ref('teams', teamId, 'events', id));
      return { acknowledged: true };
    });
  }
  async function status({ teamId }) {
    const records = await getDocsFromServer(query(collection(db, 'teams', teamId, 'receipts'), where('senderId', '==', identity.id))); guard();
    return { messages: records.docs.map(d => { const r = d.data(); return { id: d.id, status: r.acks.length === r.recipients.length ? 'delivered' : 'pending', received: r.acks.length, total: r.recipients.length }; }) };
  }
  const actions = { index, create, invite, join, approve, role, send, inbox, ack, status };
  return {
    authStatus,
    signIn: account,
    changePassword,
    rpc: (action, payload = {}) => safe(async () => {
      if (!auth.currentUser || !accountInfo) fail('Увійдіть до Firebase.', 401);
      if (accountInfo.mustChangePassword) fail('Спочатку замініть тимчасовий пароль.', 403);
      await bind(); guard(); if (!actions[action]) fail('Невідома операція.');
      try { return await actions[action](payload); }
      catch (error) {
        // A reset between index and send must not turn a durable outbox item into a permanent failure.
        if (['permission-denied', 'unauthenticated'].includes(error.code)) await refreshAccount();
        throw error;
      }
    }),
    logout: async () => {
      if (closed) return;
      closed = true; accountInfo = null; boundUid = null; temporaryPasswordHash = null;
      try { await Promise.allSettled([signOut(auth), terminate(db)]); } finally { await deleteApp(app); }
    },
  };
}
