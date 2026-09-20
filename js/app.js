import { listProfiles, createProfile, unlockProfile, saveTasks, saveWorkspace, deleteProfile, exportProfile, importProfile, requestPersistence, parseBackup, revokeSession, transitionCompletion, changePin, readTeamData, saveTeamData } from './store.js';
import { localToday, localTime, addDays, nextHalfHour, parseDate, formatDate, relativeDate } from './dates.js';
import { materializeRoutines, reconcileRoutine, occurrenceDates } from './recurrence.js';
import { upcomingAlerts, AlertLedger } from './alerts.js';
import { StepEditor } from './steps.js';
import { PinPad } from './pin-pad.js';
import { createTeamsController } from './teams.js';
import { setupGuide } from './guide.js';

setupGuide();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const pinPads = new Map($$('form').filter((form) => form.querySelector('[data-pin-pad]')).map((form) => [form.id, new PinPad(form)]));
const filters = { today: 'Сьогодні', upcoming: 'Заплановані', done: 'Виконані' };
let session = null;
let profiles = [];
let currentView = 'tasks';
let currentFilter = 'today';
let timelineDays = 7;
let revealDate = null;
let editingRoutineId = null;
let selectedWeekdays = new Set();
const weekdayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
let generatedThrough = null;
let editingTaskId = null;
let detailTaskId = null;
let historyLimit = 100;
let unlockingId = null;
let importText = null;
let confirmAction = null;
let busy = false;
let toastTimer;
let hiddenAt = null;
let hiddenTimer;
let deferredInstall = null;
let offlineReady = false;
let registration = null;
let channel;
let lastToday = localToday();
let sessionEpoch = 0;
let pendingLock = false;
let repairWarning = '';
let alertStorage = null;
try { alertStorage = window.localStorage; } catch { /* Foreground alerts remain available in memory. */ }
const alertScope = new URL('.', location.href).pathname;
const alertPreferenceKey = `na-kontroli-alert-settings:${alertScope}`;
const alertLedger = new AlertLedger({ storage: alertStorage, key: `na-kontroli-alert-receipts:${alertScope}` });
let alertPreferences = { enabled: true, system: false };
try {
  const saved = JSON.parse(alertStorage?.getItem(alertPreferenceKey) || 'null');
  if (saved && typeof saved.enabled === 'boolean' && typeof saved.system === 'boolean') alertPreferences = saved;
} catch { /* Invalid preferences reset to safe defaults. */ }
let alertNotices = [];
let alertCheckRunning = false;
let requestingNotificationPermission = false;
let notificationError = '';
const stepsEditor = new StepEditor({
  list: $('#steps-edit-list'), input: $('#step-title'), addButton: $('#add-step-button'),
  count: $('#step-count'), status: $('#step-reorder-status'), dialog: $('#task-dialog'),
  error: $('#task-form .form-error'), isBusy: () => busy, icon,
});
const routineStepsEditor = new StepEditor({
  list: $('#routine-steps-list'), input: $('#routine-step-title'), addButton: $('#add-routine-step'),
  count: $('#routine-step-count'), status: $('#routine-step-drag-status'), dialog: $('#routine-dialog'),
  error: $('#routine-form .form-error'), isBusy: () => busy, icon, helpId: 'routine-step-drag-help',
});
try { channel = new BroadcastChannel('na-kontroli-changes'); } catch { /* Storage remains functional without cross-tab notifications. */ }
const teamsController = createTeamsController({
  root: $('#teams-view'),
  getSession: () => session,
  readState: () => readTeamData(session),
  saveState: async (data) => {
    if (busy || !session) throw new Error('Простір зайнятий. Спробуй синхронізувати ще раз.');
    const expectedSession = session;
    const epoch = sessionEpoch;
    let committed = false;
    let failure;
    await work(null, async () => {
      try {
        if (session !== expectedSession || epoch !== sessionEpoch) throw new DOMException('Сеанс завершено.', 'AbortError');
        await saveTeamData(expectedSession, data);
        committed = true;
      } catch (error) { failure = error; throw error; }
    });
    // work() reports errors to the UI; the team protocol also needs a rejection
    // so it never acknowledges data that failed to commit locally.
    if (!committed) throw failure || new Error('Командні дані не збережено.');
    if (session !== expectedSession || epoch !== sessionEpoch) throw new DOMException('Сеанс завершено.', 'AbortError');
  },
  onChange: () => { if (session) notifyChange(session.id); },
  toast,
  isBusy: () => busy,
});
function refreshTeams() {
  teamsController.refresh().catch((error) => {
    if (error.name !== 'AbortError' && session && currentView === 'teams') toast(error.message, true);
  });
}


function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const completionFormatter = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function completionTime(at) {
  const time = document.createElement('time');
  time.dateTime = at;
  time.textContent = completionFormatter.format(new Date(at));
  return time;
}

function renderCompletion(container, entity) {
  container.replaceChildren();
  if (entity.completedAt) container.append(document.createTextNode('Виконано '), completionTime(entity.completedAt));
  else container.textContent = 'Час виконання не зафіксовано';
}

function hasIncompleteSteps(task) { return task.steps.some((step) => !step.done); }

function repairIncompleteTasks(tasks, at) {
  return tasks.map((task) => task.done && hasIncompleteSteps(task)
    ? { ...transitionCompletion(task, false, at), updatedAt: at } : task);
}

async function saveTaskChanges(tasks, routines = null) {
  // Retry any legacy status repairs with the next user-initiated write.
  const repaired = repairIncompleteTasks(tasks, new Date().toISOString());
  if (routines) await saveWorkspace(session, { tasks: repaired, routines });
  else await saveTasks(session, repaired);
  await closeSystemAlerts();
  repairWarning = '';
  $('#storage-repair-note').textContent = '';
  $('#storage-repair-note').hidden = true;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 4200);
}

function showDialog(id, focusId) {
  const dialog = $(id);
  if (dialog.open) return;
  const error = dialog.querySelector('.form-error');
  if (error) error.textContent = '';
  dialog.showModal();
  if (focusId) $(focusId).focus();
}

function closeDialog(dialog) {
  if (busy) return;
  dialog.close();
}

function notifyChange(id) { channel?.postMessage({ id }); }

async function work(form, operation) {
  if (busy) return;
  busy = true;
  const startedAtEpoch = sessionEpoch;
  const originalFocus = document.activeElement;
  const focusTaskId = originalFocus?.closest('[data-task-id]')?.dataset.taskId || (form?.id === 'task-form' ? editingTaskId : null);
  const focusTaskAction = ['toggle', 'view', 'edit'].includes(originalFocus?.dataset.action) ? originalFocus.dataset.action : 'edit';
  const focusStepId = originalFocus?.closest('#detail-steps [data-step-id]')?.dataset.stepId;
  const focusRoutineId = originalFocus?.closest('#routine-list [data-routine-id]')?.dataset.routineId || (form?.id === 'routine-form' ? editingRoutineId : null);
  const focusRoutineAction = originalFocus?.dataset.routineAction || 'edit';
  const errorEl = form?.querySelector('.form-error');
  if (errorEl) errorEl.textContent = '';
  const buttons = $$('button, input, textarea, select');
  const disabled = buttons.map((button) => button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  form?.setAttribute('aria-busy', 'true');
  try {
    await operation();
  } catch (error) {
    if (startedAtEpoch !== sessionEpoch) return;
    const message = error.message || 'Не вдалося виконати дію. Спробуй ще раз.';
    if (error.code === 'CONFLICT' || error.code === 'PROFILE_NOT_FOUND' || error.code === 'INVALID_SESSION') {
      await lockSpace();
      toast('Простір змінено в іншому вікні. Увійди знову, щоб побачити актуальні дані.', true);
    } else if (errorEl && form.closest('dialog')?.open) {
      errorEl.textContent = message;
    } else toast(message, true);
  } finally {
    busy = false;
    buttons.forEach((button, i) => { button.disabled = disabled[i]; });
    form?.removeAttribute('aria-busy');
    if (session && focusStepId && $('#task-detail-dialog').open) {
      $$('#detail-steps [data-step-id]').find((item) => item.dataset.stepId === focusStepId)?.focus({ preventScroll: true });
    } else if (session && currentView === 'tasks' && !document.querySelector('dialog[open]') && (focusTaskId || form?.id === 'task-form')) {
      const row = $$('#task-list [data-task-id]').find((item) => item.dataset.taskId === focusTaskId);
      const target = row?.querySelector(`[data-action="${focusTaskAction}"]`) || $('#task-list [data-action="toggle"]') || $('#nav-add');
      target.focus({ preventScroll: true });
    } else if (session && currentView === 'routines' && !document.querySelector('dialog[open]') && (focusRoutineId || form?.id === 'routine-form')) {
      const row = $$('#routine-list [data-routine-id]').find((item) => item.dataset.routineId === focusRoutineId);
      (row?.querySelector(`[data-routine-action="${focusRoutineAction}"]`) || $('#nav-add')).focus({ preventScroll: true });
    } else if (originalFocus?.isConnected && originalFocus.getClientRects().length) {
      originalFocus.focus({ preventScroll: true });
    }
    if (pendingLock || (document.hidden && hiddenAt && Date.now() - hiddenAt >= 300000)) {
      pendingLock = false;
      await lockSpace();
    }
    checkTaskAlerts();
  }
}

async function renderProfiles() {
  profiles = await listProfiles();
  $('#profile-list').replaceChildren();
  $('#profile-picker').hidden = profiles.length === 0;
  $('#first-space-art').hidden = profiles.length !== 0;
  $('#profile-count').textContent = String(profiles.length).padStart(2, '0');
  for (const profile of profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'profile-button';
    button.dataset.spaceId = profile.id;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = profile.name;
    const hint = document.createElement('small');
    hint.textContent = profile.damaged ? 'Дані пошкоджені · потрібна резервна копія' : 'Увійти за PIN-кодом';
    copy.append(name, hint);
    button.append(icon('space'), copy, icon('arrow'));
    button.addEventListener('click', () => {
      if (busy) return;
      unlockingId = profile.id;
      $('#unlock-form').reset();
      pinPads.get('unlock-form').configure('unlock-pin', { length: profile.pinLength });
      $('#unlock-space-name').textContent = profile.name;
      $('#unlock-pin-note').hidden = profile.pinLength === 4;
      $('#unlock-pin-note').textContent = 'Старий PIN залишається чинним. Після входу його можна змінити на 4 цифри у «Просторі».';
      showDialog('#unlock-dialog', '#unlock-pin');
    });
    $('#profile-list').append(button);
  }
}

function renderView() {
  $('#welcome-view').hidden = Boolean(session);
  $('#welcome-controls').hidden = Boolean(session);
  $('#app-nav').hidden = !session;
  $('#tasks-view').hidden = !session || currentView !== 'tasks';
  $('#space-view').hidden = !session || currentView !== 'space';
  $('#routines-view').hidden = !session || currentView !== 'routines';
  $('#teams-view').hidden = !session || currentView !== 'teams';
  for (const view of ['tasks', 'routines', 'teams', 'space']) {
    const button = $(`#nav-${view}`);
    button.classList.toggle('active', currentView === view);
    if (currentView === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('#nav-add').setAttribute('aria-label', currentView === 'teams' ? 'Додати в командах' : currentView === 'routines' ? 'Додати повтор' : 'Додати задачу');
  if (!session) return;
  $('#storage-repair-note').textContent = repairWarning;
  $('#storage-repair-note').hidden = !repairWarning;
  $('#space-current-name').textContent = session.name;
  $('#space-created').textContent = `Створено ${new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(session.createdAt))}`;
  renderTasks();
  renderRoutines();
  renderNotificationSettings();
}

function persistAlertPreferences() {
  try { alertStorage?.setItem(alertPreferenceKey, JSON.stringify(alertPreferences)); } catch { /* Preference remains valid for this open session. */ }
}

function systemAlertSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !standalone) return 'На iPhone спочатку встанови додаток на головний екран і відкрий його з іконки (iOS 16.4 або новіша).';
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'Цей браузер не підтримує системні сповіщення. Нагадування всередині додатка працюють.';
  if (Notification.permission === 'denied') return 'Дозвіл на сповіщення вимкнено в налаштуваннях браузера або системи. Нагадування всередині додатка працюють.';
  if (!registration?.active) return 'Спочатку дочекайся статусу «Офлайн готово».';
  return '';
}

function renderNotificationSettings() {
  $('#alerts-enabled').checked = alertPreferences.enabled;
  const unsupported = systemAlertSupport();
  const active = alertPreferences.system && 'Notification' in window && Notification.permission === 'granted';
  $('#enable-system-alerts').textContent = requestingNotificationPermission ? 'Очікуємо дозвіл…' : active ? 'Вимкнути системні сповіщення' : 'Увімкнути системні сповіщення';
  $('#enable-system-alerts').disabled = busy || requestingNotificationPermission || (!active && (Boolean(unsupported) || !alertPreferences.enabled));
  $('#alerts-system-status').textContent = !alertPreferences.enabled ? 'Нагадування на цьому пристрої вимкнені.' : notificationError || unsupported || (active
    ? 'Системні сповіщення ввімкнені для відкритого додатка. Назви задач у них не показуються.'
    : 'Можна додатково дозволити системні сповіщення. Це не вмикає роботу у фоні.');
}

function notificationTag() { return `na-kontroli-advance:${alertScope}`; }
async function closeSystemAlerts() {
  try { (await registration?.getNotifications({ tag: notificationTag() }) || []).forEach((notification) => notification.close()); } catch { /* Some browsers cannot enumerate already dismissed notifications. */ }
}

function renderAdvanceAlerts(candidates) {
  const current = new Map(candidates.map((alert) => [alert.schedule, alert]));
  alertNotices = alertNotices.flatMap((alert) => current.has(alert.schedule) ? [current.get(alert.schedule)] : []);
  $('#advance-alerts').hidden = !session || !alertPreferences.enabled || alertNotices.length === 0;
  const list = $('#advance-alert-list');
  const focusedId = document.activeElement?.dataset.alertTaskId;
  list.replaceChildren();
  for (const alert of alertNotices.slice(0, 3)) {
    const item = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.dataset.alertTaskId = alert.task.id;
    const title = document.createElement('span'); title.textContent = alert.task.title;
    const time = document.createElement('small'); time.textContent = `За ${alert.minutes} хв · ${alert.task.time}`;
    button.append(title, time);
    button.addEventListener('click', () => openTaskDetail(alert.task.id));
    item.append(button); list.append(item);
  }
  $('#advance-alert-more').hidden = alertNotices.length <= 3;
  $('#advance-alert-more').textContent = alertNotices.length > 3 ? `Ще ${alertNotices.length - 3} — у стрічці задач.` : '';
  if (focusedId) $$('#advance-alert-list button').find((button) => button.dataset.alertTaskId === focusedId)?.focus({ preventScroll: true });
}

async function checkTaskAlerts() {
  if (alertCheckRunning || busy || !session || document.hidden || pendingLock) return;
  renderNotificationSettings();
  if (!alertPreferences.enabled) return;
  alertCheckRunning = true;
  const expected = session;
  const epoch = sessionEpoch;
  const revision = session.revision;
  const isCurrent = () => session === expected && sessionEpoch === epoch && session?.revision === revision && !busy && !document.hidden && !pendingLock && alertPreferences.enabled;
  try {
    const candidates = upcomingAlerts(session.tasks);
    const fresh = candidates.length ? await alertLedger.consume(session.id, candidates, Date.now(), isCurrent) : [];
    if (!isCurrent()) return;
    if (fresh.length) {
      const latest = new Map(alertNotices.map((alert) => [alert.schedule, alert]));
      fresh.forEach((alert) => latest.set(alert.schedule, alert));
      alertNotices = [...latest.values()].sort((a, b) => a.dueAt - b.dueAt);
      $('#advance-alert-announcement').textContent = `Наближається час. Нових нагадувань: ${fresh.length}.`;
    }
    renderAdvanceAlerts(candidates);
    if (!candidates.length) closeSystemAlerts();
    if (fresh.length && alertPreferences.system && !systemAlertSupport() && Notification.permission === 'granted' && isCurrent()) {
      try {
        await registration.showNotification('НА КОНТРОЛІ', {
          body: fresh.length === 1 ? `До запланованої справи ${fresh[0].minutes} хв. Відкрий додаток, щоб переглянути.` : `Наближаються заплановані справи: ${fresh.length}. Переглянь їх у додатку.`,
          icon: new URL('./icons/icon-192.png', location.href).href,
          badge: new URL('./icons/icon-192.png', location.href).href,
          tag: notificationTag(), renotify: true,
        });
        if (!isCurrent() || !alertPreferences.system || Notification.permission !== 'granted') await closeSystemAlerts();
      } catch {
        notificationError = 'Браузер не показав системне сповіщення. Нагадування всередині додатка залишається доступним.';
        renderNotificationSettings();
      }
    }
  } catch {
    // Optional system integration must never break viewing/saving local tasks.
    notificationError = 'Не вдалося перевірити сповіщення. Перевір годинник пристрою та відкрий додаток знову.';
    renderNotificationSettings();
  } finally { alertCheckRunning = false; }
}

$('#dismiss-alerts').addEventListener('click', () => {
  if (busy) return;
  alertNotices = []; $('#advance-alerts').hidden = true; $('#advance-alert-list').replaceChildren();
  $('#advance-alert-announcement').textContent = '';
  closeSystemAlerts();
});
$('#alerts-enabled').addEventListener('change', () => {
  alertPreferences.enabled = $('#alerts-enabled').checked;
  persistAlertPreferences();
  if (!alertPreferences.enabled) {
    alertNotices = []; $('#advance-alerts').hidden = true; $('#advance-alert-list').replaceChildren();
    $('#advance-alert-announcement').textContent = ''; closeSystemAlerts();
  }
  renderNotificationSettings(); checkTaskAlerts();
});
$('#enable-system-alerts').addEventListener('click', async () => {
  if (busy || !session || requestingNotificationPermission) return;
  notificationError = '';
  if (alertPreferences.system && 'Notification' in window && Notification.permission === 'granted') {
    alertPreferences.system = false; persistAlertPreferences(); closeSystemAlerts(); renderNotificationSettings(); return;
  }
  if (systemAlertSupport() || !alertPreferences.enabled) { renderNotificationSettings(); return; }
  const epoch = sessionEpoch;
  requestingNotificationPermission = true;
  // Call within this direct user gesture, before waiting on any other operation.
  try {
    const permissionPromise = Notification.requestPermission();
    renderNotificationSettings();
    const permission = await permissionPromise;
    if (!session || sessionEpoch !== epoch) return;
    alertPreferences.system = permission === 'granted';
    persistAlertPreferences();
    if (permission === 'default') notificationError = 'Дозвіл не надано. Нагадування всередині додатка працюють.';
    checkTaskAlerts();
  } catch { notificationError = 'Системні сповіщення тут недоступні. Нагадування всередині додатка працюють.'; }
  finally { requestingNotificationPermission = false; renderNotificationSettings(); }
});

function tasksForFilter(filter) {
  const today = localToday();
  return session.tasks.filter((task) => filter === 'done' ? task.done : !task.done && (filter === 'today' ? task.date <= today : task.date >= today && (task.date <= timelineEnd() || task.date === revealDate)));
}

function timelineEnd(days = timelineDays) {
  try { return addDays(localToday(), days - 1); } catch { return '9999-12-31'; }
}

function renderDueReminders() {
  if (!session) return;
  const today = localToday();
  const due = session.tasks.filter((task) => task.kind === 'reminder' && !task.done && (task.date < today || task.date === today && task.time <= localTime()));
  $('#reminder-due').hidden = due.length === 0 || currentFilter === 'done';
  $('#reminder-due').replaceChildren(icon('bell'), document.createTextNode(`Нагадування на зараз: ${due.length}`));
}

function renderTasks() {
  if (!session) return;
  const today = localToday();
  $('#tasks-view').dataset.feed = currentFilter;
  $('#tasks-view').setAttribute('aria-label', `Задачі: ${filters[currentFilter]}`);
  $('#feed-title').textContent = filters[currentFilter];
  const feedIndex = Object.keys(filters).indexOf(currentFilter);
  $$('#feed-dots span').forEach((dot, index) => dot.classList.toggle('active', index === feedIndex));
  $('#feed-prev').setAttribute('aria-label', `Попередня стрічка: ${Object.values(filters)[(feedIndex + 2) % 3]}`);
  $('#feed-next').setAttribute('aria-label', `Наступна стрічка: ${Object.values(filters)[(feedIndex + 1) % 3]}`);
  renderDueReminders();
  const tasks = tasksForFilter(currentFilter).sort((a, b) => currentFilter === 'done'
    ? (b.completedAt || '').localeCompare(a.completedAt || '') || b.date.localeCompare(a.date)
    : a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.createdAt.localeCompare(b.createdAt));
  const list = $('#task-list');
  list.replaceChildren();
  $('#tasks-empty').hidden = tasks.length > 0 || currentFilter === 'upcoming';
  $('#timeline-more').hidden = currentFilter !== 'upcoming' || timelineEnd() === '9999-12-31';
  const empty = currentFilter === 'done'
    ? ['Кожна справа має значення', 'Відмічай виконане галочкою праворуч.\nЗавершені справи з’являться тут.']
    : ['Сьогодні вільно', 'Додай задачу кнопкою «+»\nабо налаштуй регулярні справи в «Повторах».'];
  $('#empty-title').textContent = empty[0];
  $('#empty-text').textContent = empty[1];
  const groups = new Map();
  if (currentFilter === 'upcoming') {
    for (let date = today; date <= timelineEnd(); date = addDays(date)) {
      groups.set(date, []);
      if (date === '9999-12-31') break;
    }
  }
  for (const task of tasks) {
    const date = currentFilter === 'done' ? (task.completedAt ? localToday(new Date(task.completedAt)) : 'unknown') : task.date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  for (const [date, items] of groups) {
    const section = document.createElement('section');
    section.className = 'timeline-day';
    section.dataset.date = date;
    const label = document.createElement('h2');
    const overdue = currentFilter === 'today' && date < today;
    label.className = `task-group-label${overdue ? ' overdue' : ''}`;
    label.textContent = date === 'unknown' ? 'Без часу виконання' : `${date === today ? 'Сьогодні · ' : date === timelineEnd(2) ? 'Завтра · ' : ''}${date.split('-').reverse().join('.')}${overdue ? ' · Прострочено' : ''}`;
    section.append(label);
    for (const task of items) section.append(taskRow(task));
    if (!items.length) {
      const emptyDay = document.createElement('p');
      emptyDay.className = 'empty-day'; emptyDay.textContent = 'Нічого не заплановано';
      section.append(emptyDay);
    }
    list.append(section);
  }
}

function taskRow(task) {
  const today = localToday();
    const row = document.createElement('article');
    row.className = `task-row${task.done ? ' done' : ''}`;
    row.dataset.taskId = task.id;
    row.dataset.kind = task.kind;
    if (task.routineId) { row.dataset.routineId = task.routineId; row.dataset.occurrenceDate = task.occurrenceDate; }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'task-action task-toggle';
    toggle.dataset.action = 'toggle';
    toggle.setAttribute('aria-label', `${task.done ? 'Повернути в активні' : 'Виконати'}: ${task.title}`);
    toggle.setAttribute('aria-pressed', String(task.done));
    const blocked = !task.done && hasIncompleteSteps(task);
    toggle.setAttribute('aria-disabled', String(blocked));
    toggle.classList.toggle('completion-blocked', blocked);
    toggle.title = task.done ? 'Повернути в активні' : 'Виконати задачу';
    if (blocked) toggle.title = 'Спочатку виконай усі етапи';
    toggle.append(icon('check'));
    toggle.addEventListener('click', () => work(null, async () => {
      const current = session.tasks.find((item) => item.id === task.id);
      if (!current) return;
      if (!current.done && hasIncompleteSteps(current)) throw new Error('Спочатку виконай усі етапи задачі.');
      const now = new Date().toISOString();
      const changed = session.tasks.map((item) => item.id === task.id ? { ...transitionCompletion(item, !item.done, now), updatedAt: now } : item);
      await saveTaskChanges(changed);
      notifyChange(session.id);
      renderTasks();
      toast(current.done ? 'Задачу повернуто в активні' : 'Задачу виконано. Час збережено.');
    }));
    const content = document.createElement('button');
    content.type = 'button';
    content.className = 'task-content';
    content.dataset.action = 'view';
    content.setAttribute('aria-label', `Відкрити задачу: ${task.title}`);
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    const meta = document.createElement('span');
    meta.className = `task-meta${task.date < today && !task.done ? ' overdue-text' : ''}`;
    meta.append(icon('calendar'), document.createTextNode(formatDate(task.date, { year: 'numeric' })));
    if (task.time) {
      const time = document.createElement('span');
      time.className = 'task-time';
      time.append(icon('clock'), document.createTextNode(task.time));
      meta.append(time);
    }
    content.append(title, meta);
    if (task.routineId || task.kind === 'reminder') {
      const badge = document.createElement('span');
      badge.className = 'task-repeat-badge';
      badge.append(icon(task.kind === 'reminder' ? 'bell' : 'repeat'), document.createTextNode(task.kind === 'reminder' ? 'Нагадування' : 'Повтор'));
      content.append(badge);
    }
    if (task.steps.length) {
      const progress = document.createElement('span');
      progress.className = 'task-step-summary';
      progress.textContent = `Етапи: ${task.steps.filter((step) => step.done).length} / ${task.steps.length}`;
      content.append(progress);
    }
    if (task.done) {
      const completed = document.createElement('span');
      completed.className = 'task-completed-at';
      renderCompletion(completed, task);
      content.append(completed);
    }
    content.addEventListener('click', () => openTaskDetail(task.id));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'task-action task-edit';
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-label', `Редагувати: ${task.title}`);
    edit.title = 'Редагувати задачу';
    edit.append(icon('edit'));
    edit.addEventListener('click', () => openTask(task));
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    actions.append(edit, toggle);
    row.append(content, actions);
    return row;
}

async function refreshOccurrences(through = timelineEnd(), allowRead = false) {
  const expectedSession = session;
  if (!expectedSession) return;
  try {
    const tasks = materializeRoutines(expectedSession.tasks, expectedSession.routines, through);
    if (tasks.length !== expectedSession.tasks.length) {
      await saveWorkspace(expectedSession, { tasks, routines: expectedSession.routines });
      notifyChange(expectedSession.id);
    }
    if (session === expectedSession) generatedThrough = through;
  } catch (error) {
    if (!allowRead || ['CONFLICT', 'PROFILE_NOT_FOUND', 'INVALID_SESSION'].includes(error.code)) throw error;
    // Keep read/export access and don't retry a full disk on every timer tick.
    if (session === expectedSession) {
      generatedThrough = through;
      repairWarning = `Не вдалося додати повторення. ${error.message} Збережені дані доступні для перегляду й експорту.`;
    }
  }
}

function refreshCalendar() {
  if (!session || busy || document.querySelector('dialog[open]')) return;
  work(null, async () => {
    if (lastToday !== localToday()) { lastToday = localToday(); timelineDays = 7; }
    await refreshOccurrences(timelineEnd(), true);
    renderView();
  });
}

function renderRoutines() {
  if (!session) return;
  const list = $('#routine-list');
  list.replaceChildren();
  $('#routines-empty').hidden = session.routines.length > 0;
  for (const rule of [...session.routines].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt))) {
    const row = document.createElement('article');
    row.className = `routine-row${rule.enabled ? '' : ' paused'}`;
    row.dataset.routineId = rule.id;
    const copy = document.createElement('div'); copy.className = 'routine-copy';
    const kind = document.createElement('span'); kind.className = 'routine-kind';
    kind.append(icon(rule.kind === 'reminder' ? 'bell' : 'repeat'), document.createTextNode(rule.kind === 'reminder' ? 'Нагадування' : 'Задача'));
    const title = document.createElement('h2'); title.textContent = rule.title;
    const schedule = document.createElement('p'); schedule.className = 'routine-schedule';
    const repeat = rule.frequency === 'daily' ? 'Щодня' : rule.frequency === 'weekly' ? rule.weekdays.map((day) => weekdayNames[day - 1]).join(', ') : `Щомісяця · ${Number(rule.startDate.slice(8))}-го`;
    schedule.textContent = `${repeat} · ${rule.time}${rule.enabled ? '' : ' · На паузі'}`;
    const detail = document.createElement('p'); detail.className = 'routine-detail';
    detail.textContent = rule.startDate > localToday() ? `Початок ${rule.startDate.split('-').reverse().join('.')}` : '';
    if (rule.frequency === 'monthly' && Number(rule.startDate.slice(8)) > 28) detail.textContent += `${detail.textContent ? ' · ' : ''}У короткому місяці — останній день`;
    copy.append(kind, title, schedule);
    if (detail.textContent) copy.append(detail);
    const actions = document.createElement('div'); actions.className = 'routine-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'task-action'; edit.dataset.routineAction = 'edit';
    edit.setAttribute('aria-label', `Редагувати повтор: ${rule.title}`); edit.append(icon('edit')); edit.addEventListener('click', () => openRoutine(rule));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'task-action'; toggle.dataset.routineAction = 'toggle';
    toggle.setAttribute('aria-label', `${rule.enabled ? 'Призупинити' : 'Продовжити'} повтор: ${rule.title}`);
    toggle.title = rule.enabled ? 'Призупинити повтор' : 'Продовжити від сьогодні';
    toggle.setAttribute('aria-pressed', String(rule.enabled)); toggle.append(icon(rule.enabled ? 'pause' : 'play'));
    toggle.addEventListener('click', () => work(null, async () => {
      const current = session.routines.find((item) => item.id === rule.id);
      if (!current) return;
      const today = localToday();
      let excludedDates = current.excludedDates;
      if (!current.enabled && current.pausedOn && current.pausedOn < today) {
        excludedDates = [...new Set([...excludedDates, ...occurrenceDates({ ...current, enabled: true }, current.pausedOn, addDays(today, -1))])];
      }
      const changed = { ...current, enabled: !current.enabled, pausedOn: current.enabled ? today : null, excludedDates, updatedAt: new Date().toISOString() };
      await saveRoutineChange(current, changed);
      renderView();
      toast(changed.enabled ? 'Повтор продовжено від сьогодні' : 'Повтор на паузі. Історія збережена.');
    }));
    actions.append(edit, toggle); row.append(copy, actions); list.append(row);
  }
}

function openRoutine(rule = null) {
  if (busy || !session) return;
  editingRoutineId = rule?.id || null;
  $('#routine-form').reset();
  $('#routine-title').value = rule?.title || '';
  $('#routine-kind').value = rule?.kind || 'task';
  const now = new Date();
  $('#routine-start-date').value = rule?.startDate || localToday(now);
  $('#routine-time').value = rule?.time || localTime(now);
  selectedWeekdays = new Set(rule?.frequency === 'weekly' ? rule.weekdays : rule?.frequency === 'monthly' ? [] : [1, 2, 3, 4, 5, 6, 7]);
  renderWeekdays();
  $('#routine-dialog-title').textContent = rule ? 'Редагувати повтор' : 'Новий повтор';
  $('#save-routine-button').replaceChildren(document.createTextNode(rule ? 'Зберегти зміни' : 'Додати повтор'), icon('check'));
  $('#delete-routine-button').hidden = !rule;
  $('#routine-steps-editor').hidden = !rule;
  $('#routine-edit-note').hidden = !rule;
  routineStepsEditor.reset((rule?.steps || []).map((step) => ({ ...step, done: false, completedAt: null, completionHistory: [] })));
  updateRoutineFields();
  showDialog('#routine-dialog', '#routine-title');
  $('#routine-dialog').scrollTop = 0;
}

function updateRoutineFields() {
  $('#routine-reminder-note').hidden = $('#routine-kind').value !== 'reminder';
}

function routineSchedule() {
  const weekdays = [...selectedWeekdays].sort((a, b) => a - b);
  if (weekdays.length === 7) return { frequency: 'daily', weekdays: [] };
  if (weekdays.length === 0) return { frequency: 'monthly', weekdays: [] };
  return { frequency: 'weekly', weekdays };
}

function renderWeekdays() {
  $$('#routine-week-options [data-weekday]').forEach((button) => {
    button.setAttribute('aria-pressed', String(selectedWeekdays.has(Number(button.dataset.weekday))));
  });
  const { frequency, weekdays } = routineSchedule();
  const date = parseDate($('#routine-start-date').value);
  $('#routine-schedule-summary').textContent = frequency === 'daily' ? 'Щодня' : frequency === 'weekly'
    ? `Щотижня · ${weekdays.map((day) => weekdayNames[day - 1]).join(', ')}`
    : date ? `Щомісяця · ${date.getDate()}-го${date.getDate() > 28 ? ' або в останній день' : ''}` : 'Щомісяця · обери початкову дату';
}
$$('#routine-week-options [data-weekday]').forEach((button) => button.addEventListener('click', () => {
  if (busy) return;
  const day = Number(button.dataset.weekday);
  if (selectedWeekdays.has(day)) selectedWeekdays.delete(day); else selectedWeekdays.add(day);
  renderWeekdays();
  $('#routine-form .form-error').textContent = '';
}));
$('#routine-start-date').addEventListener('input', renderWeekdays);
$('#routine-kind').addEventListener('change', updateRoutineFields);

$('#routine-help-button').addEventListener('click', () => {
  if (!busy) showDialog('#routine-help-dialog');
});
$('#routine-help-dialog').addEventListener('click', (event) => {
  event.stopPropagation();
  closeDialog(event.currentTarget);
});
$('#routine-help-dialog').addEventListener('close', () => {
  if ($('#routine-dialog').open) $('#routine-help-button').focus({ preventScroll: true });
});

async function saveRoutineChange(oldRule, newRule) {
  const rules = session.routines.filter((rule) => rule.id !== oldRule?.id);
  if (newRule) rules.push(newRule);
  const reconciled = reconcileRoutine(session.tasks, oldRule, newRule, localToday());
  // Stopping a rule must remain possible even when another rule cannot generate.
  const tasks = newRule?.enabled ? materializeRoutines(reconciled, [newRule], timelineEnd()) : reconciled;
  await saveTaskChanges(tasks, rules);
  generatedThrough = null;
  notifyChange(session.id);
}

$('#routine-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const oldRule = session.routines.find((rule) => rule.id === editingRoutineId) || null;
    const now = new Date().toISOString();
    const title = $('#routine-title').value.trim();
    if (!title) throw new Error('Напиши, що потрібно зробити.');
    const { frequency, weekdays } = routineSchedule();
    const rule = {
      id: oldRule?.id || crypto.randomUUID(), title, kind: $('#routine-kind').value,
      frequency, startDate: $('#routine-start-date').value, time: $('#routine-time').value,
      monthOverflow: 'last-day', weekdays, enabled: oldRule?.enabled ?? true, pausedOn: oldRule?.pausedOn ?? null,
      createdAt: oldRule?.createdAt || now, updatedAt: now,
      steps: oldRule ? routineStepsEditor.collect().map(({ id, title }) => ({ id, title })) : [],
      excludedDates: oldRule?.excludedDates || [],
    };
    if (oldRule && (oldRule.frequency !== rule.frequency || oldRule.startDate !== rule.startDate || JSON.stringify(oldRule.weekdays) !== JSON.stringify(rule.weekdays)) && rule.startDate < localToday()) {
      // Editing a schedule affects today onward; never invent new historical tasks.
      rule.excludedDates = [...new Set([...rule.excludedDates, ...occurrenceDates({ ...rule, enabled: true }, rule.startDate, addDays(localToday(), -1))])];
    }
    await saveRoutineChange(oldRule, rule);
    $('#routine-dialog').close(); currentView = 'routines'; renderView();
    toast(oldRule ? 'Повтор оновлено. Історія збережена.' : 'Повтор додано до стрічки');
  });
});

$('#delete-routine-button').addEventListener('click', () => {
  if (busy) return;
  const rule = session.routines.find((item) => item.id === editingRoutineId);
  if (!rule) return;
  $('#routine-dialog').close();
  askConfirm({ title: 'Видалити повтор?', text: 'Майбутні нерозпочаті повторення зникнуть. Попередні дати, виконані й розпочаті задачі залишаться у стрічці.', action: async () => {
    await saveRoutineChange(rule, null); renderView(); toast('Повтор видалено. Історія збережена.');
  } });
});

async function enterSpace(newSession, expectedEpoch = sessionEpoch) {
  if (expectedEpoch !== sessionEpoch || pendingLock) { revokeSession(newSession); return; }
  let pendingRepairWarning = '';
  // Earlier versions allowed a completed task to contain unfinished steps.
  // Reopen those tasks, recording only this real transition, never an invented
  // historical completion time.
  if (newSession.tasks.some((task) => task.done && hasIncompleteSteps(task))) {
    const now = new Date().toISOString();
    try {
      await saveTasks(newSession, repairIncompleteTasks(newSession.tasks, now));
      notifyChange(newSession.id);
    } catch (error) {
      if (['CONFLICT', 'PROFILE_NOT_FOUND', 'INVALID_SESSION'].includes(error.code)) { revokeSession(newSession); throw error; }
      // A full disk must not block read access or exporting an existing backup.
      // saveTasks changes session.tasks only after commit: preserve those saved
      // statuses and do not display timestamps for a repair that did not save.
      pendingRepairWarning = `Не вдалося повернути задачі з невиконаними етапами в активні. ${error.message} Збережені дані доступні для перегляду й експорту.`;
    }
    if (expectedEpoch !== sessionEpoch || pendingLock) { revokeSession(newSession); return; }
  }
  revokeSession(session);
  session = newSession;
  repairWarning = pendingRepairWarning;
  currentView = 'tasks';
  currentFilter = 'today';
  timelineDays = 7;
  revealDate = null;
  generatedThrough = null;
  await refreshOccurrences(timelineEnd(), true);
  if (expectedEpoch !== sessionEpoch || pendingLock) return;
  renderView();
  window.scrollTo(0, 0);
  // Failure to obtain persistence does not prevent IndexedDB from working.
  requestPersistence().catch(() => {});
}

function clearSession() {
  sessionEpoch += 1;
  teamsController.lock();
  alertNotices = [];
  $('#advance-alert-list').replaceChildren();
  $('#advance-alert-more').textContent = '';
  $('#advance-alert-announcement').textContent = '';
  $('#advance-alerts').hidden = true;
  closeSystemAlerts();
  revokeSession(session);
  session = null;
  repairWarning = '';
  $('#storage-repair-note').textContent = '';
  $('#storage-repair-note').hidden = true;
  editingTaskId = null;
  editingRoutineId = null;
  generatedThrough = null;
  detailTaskId = null;
  stepsEditor.reset();
  routineStepsEditor.reset();
  $('#routine-list').replaceChildren();
  confirmAction = null;
  importText = null;
  $$('dialog[open]').forEach((dialog) => dialog.close());
  $$('form').forEach((form) => form.reset());
  $('#task-list').replaceChildren();
  $('#space-current-name').textContent = '';
  $('#space-created').textContent = '';
  $('#unlock-space-name').textContent = '';
  $('#confirm-text').textContent = '';
  clearTaskDetail();
  $('#toast').hidden = true;
  renderView();
}

async function lockSpace() {
  clearSession();
  await renderProfiles();
  window.scrollTo(0, 0);
}

function openTask(task = null) {
  if (busy || !session) return;
  editingTaskId = task?.id || null;
  $('#task-form').reset();
  $('#task-title').value = task?.title || '';
  const now = new Date();
  $('#task-date').value = task?.date || localToday(now);
  $('#task-time').value = task ? task.time || '' : localTime(now);
  $('#task-time').required = !task || Boolean(task.time);
  $('#legacy-time-note').hidden = !task || Boolean(task.time);
  $('#steps-editor').hidden = !task;
  $('#task-occurrence-note').hidden = !task?.routineId;
  stepsEditor.reset(task?.steps || []);
  $('#task-dialog-title').textContent = task ? 'Редагувати задачу' : 'Нова задача';
  $('#save-task-button').replaceChildren(document.createTextNode(task ? 'Зберегти зміни' : 'Додати задачу'), icon('check'));
  $('#delete-task-button').hidden = !task;
  updateRelativeDate();
  showDialog('#task-dialog', '#task-title');
  $('#task-dialog').scrollTop = 0;
}

function openTaskDetail(id) {
  if (busy || !session) return;
  detailTaskId = id;
  historyLimit = 100;
  $('#detail-history').open = false;
  $('#detail-feedback').textContent = '';
  renderTaskDetail();
  showDialog('#task-detail-dialog', '#detail-title');
  $('#task-detail-dialog').scrollTop = 0;
}

function clearTaskDetail() {
  detailTaskId = null;
  $('#detail-title').textContent = '';
  $('#detail-date').replaceChildren();
  $('#detail-state').textContent = '';
  $('#detail-completed-at').replaceChildren();
  $('#detail-completed-at').hidden = true;
  $('#detail-feedback').textContent = '';
  $('#detail-history-list').replaceChildren();
  $('#detail-history').hidden = true;
  $('#detail-history').open = false;
  $('#detail-history-count').textContent = '';
  historyLimit = 100;
  $('#detail-progress-label').textContent = '';
  $('#detail-progress').value = 0;
  $('#detail-steps').replaceChildren();
  $('#task-detail-content .form-error').textContent = '';
}

function renderTaskDetail() {
  const task = session?.tasks.find((item) => item.id === detailTaskId);
  if (!task) return;
  const scrollTop = $('#task-detail-dialog').scrollTop;
  $('#detail-title').textContent = task.title;
  $('#detail-date').replaceChildren(icon('calendar'), document.createTextNode(`${formatDate(task.date, { year: 'numeric' })}${task.time ? ` · ${task.time}` : ' · Час не задано'}`));
  $('#detail-state').textContent = task.done ? 'Виконана' : 'Активна';
  $('#detail-completed-at').hidden = !task.done;
  if (task.done) renderCompletion($('#detail-completed-at'), task);
  else $('#detail-completed-at').replaceChildren();
  const complete = task.steps.filter((step) => step.done).length;
  $('#detail-progress-label').textContent = `${complete} з ${task.steps.length} виконано`;
  $('#detail-progress').max = task.steps.length || 1;
  $('#detail-progress').value = complete;
  $('#detail-progress').hidden = task.steps.length === 0;
  $('#detail-empty').hidden = task.steps.length > 0;
  $('#detail-save-note').hidden = task.steps.length === 0;
  $('#detail-steps').replaceChildren();
  task.steps.forEach((step, index) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `detail-step${step.done ? ' done' : ''}`;
    button.dataset.stepId = step.id;
    button.dataset.stepAction = 'toggle';
    button.setAttribute('aria-pressed', String(step.done));
    button.setAttribute('aria-label', `${step.done ? 'Повернути в активні' : 'Виконати'} етап ${index + 1}: ${step.title}`);
    const check = document.createElement('span');
    check.className = 'detail-step-check';
    check.append(icon('check'));
    const text = document.createElement('span');
    text.className = 'detail-step-title';
    text.textContent = step.title;
    const number = document.createElement('span');
    number.className = 'detail-step-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'detail-step-copy';
    copy.append(text);
    if (step.done) {
      const completed = document.createElement('span');
      completed.className = 'detail-step-completed-at';
      renderCompletion(completed, step);
      copy.append(completed);
    }
    button.append(check, copy, number);
    button.addEventListener('click', () => work($('#task-detail-content'), async () => {
      const now = new Date().toISOString();
      let reopened = false;
      const changed = session.tasks.map((item) => {
        if (item.id !== task.id) return item;
        let updated = {
          ...item, updatedAt: now,
          steps: item.steps.map((part) => part.id === step.id ? transitionCompletion(part, !part.done, now) : part),
        };
        if (updated.done && hasIncompleteSteps(updated)) { updated = transitionCompletion(updated, false, now); reopened = true; }
        return updated;
      });
      await saveTaskChanges(changed);
      notifyChange(session.id);
      renderTasks();
      renderTaskDetail();
      $('#detail-feedback').textContent = reopened ? 'Задачу повернуто в активні: є невиконаний етап.' : '';
    }));
    row.append(button);
    $('#detail-steps').append(row);
  });
  renderCompletionHistory(task);
  $('#task-detail-dialog').scrollTop = scrollTop;
}

function renderCompletionHistory(task) {
  const events = task.completionHistory.map((event) => ({ ...event, title: event.done ? 'Задачу виконано' : 'Задачу повернуто в активні' }));
  task.steps.forEach((step) => step.completionHistory.forEach((event) => {
    events.push({ ...event, title: `Етап «${step.title}» ${event.done ? 'виконано' : 'повернуто в активні'}` });
  }));
  events.sort((a, b) => b.at.localeCompare(a.at));
  $('#detail-history').hidden = events.length === 0;
  $('#detail-history-count').textContent = String(events.length);
  $('#detail-history-list').replaceChildren();
  for (const event of events.slice(0, historyLimit)) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'completion-event-title';
    title.textContent = event.title;
    row.append(title, completionTime(event.at));
    $('#detail-history-list').append(row);
  }
  $('#detail-history-more').hidden = events.length <= historyLimit;
}

$('#detail-history-more').addEventListener('click', () => {
  if (busy) return;
  const task = session?.tasks.find((item) => item.id === detailTaskId);
  if (task) { historyLimit += 100; renderCompletionHistory(task); }
});

function updateRelativeDate() {
  $('#date-relative').textContent = parseDate($('#task-date').value) ? relativeDate($('#task-date').value) : '';
}

function askConfirm({ title, text, action, pin = false }) {
  $('#confirm-form').reset();
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#delete-pin-field').hidden = !pin;
  $('#delete-pin').required = pin;
  $('#delete-pin').disabled = !pin;
  if (pin) pinPads.get('confirm-form').configure('delete-pin', { length: session.pinLength });
  confirmAction = action;
  showDialog('#confirm-dialog', pin ? '#delete-pin' : '#confirm-submit');
}

function updateConnection() {
  $('#connection-status').classList.toggle('offline', !navigator.onLine);
  $('#connection-text').textContent = !navigator.onLine ? 'Без зв’язку' : offlineReady ? 'Офлайн готово' : 'Локально';
  $('#offline-detail').textContent = offlineReady ? 'Додаток готовий до роботи без інтернету. Задачі зберігаються лише на цьому пристрої.' : 'Підключись до інтернету та дочекайся завантаження офлайн-копії додатка.';
}

async function setupOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext || location.protocol === 'file:') {
    $('#offline-detail').textContent = 'Для встановлення й офлайн-режиму відкрий додаток через HTTPS або localhost.';
    return;
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    const onReady = () => { offlineReady = true; updateConnection(); renderNotificationSettings(); };
    if (registration.active) onReady();
    navigator.serviceWorker.ready.then(onReady);
    const watchWaiting = () => {
      if (registration.waiting && registration.active) toast('Оновлення готове. Закрий усі вікна додатка й відкрий його знову.');
    };
    watchWaiting();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', watchWaiting);
    });
  } catch {
    $('#offline-detail').textContent = 'Офлайн-копію ще не завантажено. Перевір інтернет і відкрий додаток знову.';
    toast('Не вдалося підготувати офлайн-режим. Перевір з’єднання та перезавантаж сторінку.', true);
  }
}

$('#create-space-button').addEventListener('click', () => {
  if (busy) return;
  $('#space-form').reset();
  showDialog('#space-dialog', '#space-name');
});

$('#space-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const epoch = sessionEpoch;
    if ($('#space-pin').value !== $('#space-pin-confirm').value) throw new Error('PIN-коди не збігаються. Перевір повторний PIN.');
    const newSession = await createProfile($('#space-name').value, $('#space-pin').value);
    $('#space-dialog').close();
    await enterSpace(newSession, epoch);
    notifyChange(newSession.id);
    toast('Простір створено.');
  });
});

$('#unlock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const epoch = sessionEpoch;
    const newSession = await unlockProfile(unlockingId, $('#unlock-pin').value);
    $('#unlock-dialog').close();
    await enterSpace(newSession, epoch);
  });
});

$('#change-pin-button').addEventListener('click', () => {
  if (busy || !session) return;
  $('#change-pin-form').reset();
  pinPads.get('change-pin-form').configure('current-pin', { length: session.pinLength });
  showDialog('#change-pin-dialog', '#current-pin');
});

$('#change-pin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const expectedSession = session;
    const epoch = sessionEpoch;
    if (!expectedSession) return;
    if ($('#new-pin').value !== $('#new-pin-confirm').value) throw new Error('Нові PIN-коди не збігаються. Перевір повторний PIN.');
    await changePin(expectedSession, $('#current-pin').value, $('#new-pin').value);
    if (session !== expectedSession || sessionEpoch !== epoch) return;
    notifyChange(expectedSession.id);
    $('#change-pin-dialog').close();
    toast('PIN змінено. Збережи нову JSON-копію простору.');
  });
});

$('#nav-add').addEventListener('click', () => currentView === 'teams' ? teamsController.handleAdd() : currentView === 'routines' ? openRoutine() : openTask());
$('#task-date').addEventListener('input', updateRelativeDate);
[$('#task-date'), $('#task-time')].forEach((input) => input.addEventListener('click', () => {
  // Desktop Chromium needs showPicker to open the calendar from the whole field.
  // Safari keeps its native date control when this method is unavailable.
  try { input.showPicker?.(); } catch { /* Native control remains usable. */ }
}));
$('#next-day-button').addEventListener('click', () => {
  try { $('#task-date').value = addDays($('#task-date').value); updateRelativeDate(); }
  catch (error) { $('#task-form .form-error').textContent = error.message; }
});
$('#next-time-button').addEventListener('click', () => {
  try {
    const next = nextHalfHour($('#task-date').value, $('#task-time').value || localTime());
    $('#task-date').value = next.date;
    $('#task-time').value = next.time;
    updateRelativeDate();
    $('#task-form .form-error').textContent = '';
  } catch (error) { $('#task-form .form-error').textContent = error.message; }
});
$('#task-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const title = $('#task-title').value.trim();
    const date = $('#task-date').value;
    const time = $('#task-time').value || null;
    if (!title) throw new Error('Напиши, що потрібно зробити.');
    if (!parseDate(date)) throw new Error('Вибери коректну дату.');
    const now = new Date().toISOString();
    const steps = editingTaskId ? stepsEditor.collect() : [];
    let reopened = false;
    const changed = editingTaskId ? session.tasks.map((task) => {
      if (task.id !== editingTaskId) return task;
      let updated = { ...task, title, date, time, steps, updatedAt: now };
      if (updated.done && hasIncompleteSteps(updated)) { updated = transitionCompletion(updated, false, now); reopened = true; }
      return updated;
    }) : [...session.tasks, { id: crypto.randomUUID(), title, date, time, steps, done: false, completedAt: null, completionHistory: [], createdAt: now, updatedAt: now, kind: 'task', routineId: null, occurrenceDate: null }];
    await saveTaskChanges(changed);
    notifyChange(session.id);
    const wasEditing = Boolean(editingTaskId);
    $('#task-dialog').close();
    currentView = 'tasks';
    // Newly added tasks are always visible, even when adding from the Done filter.
    currentFilter = session.tasks.find((task) => task.id === editingTaskId)?.done ? 'done' : date <= localToday() ? 'today' : 'upcoming';
    if (currentFilter === 'upcoming' && date > timelineEnd()) revealDate = date;
    renderView();
    toast(reopened ? 'Задачу повернуто в активні: є невиконані етапи.' : wasEditing ? 'Зміни збережено' : 'Задача на контролі');
  });
});

$('#delete-task-button').addEventListener('click', () => {
  if (busy) return;
  const id = editingTaskId;
  $('#task-dialog').close();
  askConfirm({ title: 'Видалити задачу?', text: 'Цю дію неможливо скасувати.', action: async () => {
    const task = session.tasks.find((item) => item.id === id);
    const routines = session.routines.map((rule) => rule.id === task?.routineId ? { ...rule, excludedDates: [...new Set([...rule.excludedDates, task.occurrenceDate])], updatedAt: new Date().toISOString() } : rule);
    await saveTaskChanges(session.tasks.filter((task) => task.id !== id), routines);
    notifyChange(session.id);
    renderView();
    toast('Задачу видалено');
  } });
});

for (const view of ['tasks', 'routines', 'teams']) {
  $(`#nav-${view}`).addEventListener('click', () => {
    if (busy || !session) return;
    if (view !== 'teams') teamsController.lock();
    currentView = view; renderView(); window.scrollTo(0, 0);
    if (view === 'teams') refreshTeams();
  });
}

function changeFeed(direction) {
  if (busy || !session || document.querySelector('dialog[open]')) return;
  const keys = Object.keys(filters);
  currentFilter = keys[(keys.indexOf(currentFilter) + direction + keys.length) % keys.length];
  renderTasks(); window.scrollTo(0, 0);
}
$('#feed-prev').addEventListener('click', () => changeFeed(-1));
$('#feed-next').addEventListener('click', () => changeFeed(1));
// Touch handling preserves native vertical scrolling and does not capture drag handles.
let swipe = null;
let suppressTaskClickUntil = 0;
$('#tasks-view').addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1 || event.target.closest('.task-action, .feed-arrow, #load-more-days') || busy) { swipe = null; return; }
  const point = event.touches[0];
  swipe = { x: point.clientX, y: point.clientY, at: Date.now() };
}, { passive: true });
$('#tasks-view').addEventListener('touchend', (event) => {
  if (!swipe || event.changedTouches.length !== 1) return;
  const point = event.changedTouches[0];
  const dx = point.clientX - swipe.x, dy = point.clientY - swipe.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - swipe.at < 1500) {
    suppressTaskClickUntil = Date.now() + 500;
    changeFeed(dx < 0 ? 1 : -1);
  }
  swipe = null;
}, { passive: true });
$('#tasks-view').addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
$('#tasks-view').addEventListener('click', (event) => {
  if (Date.now() < suppressTaskClickUntil) { event.preventDefault(); event.stopPropagation(); }
}, true);

async function loadMoreDays() {
  if (busy || !session || currentView !== 'tasks' || currentFilter !== 'upcoming' || document.querySelector('dialog[open]')) return;
  await work(null, async () => {
    const nextDays = timelineDays + 7;
    await refreshOccurrences(timelineEnd(nextDays));
    timelineDays = nextDays;
    renderTasks();
  });
}
$('#load-more-days').addEventListener('click', loadMoreDays);
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && window.scrollY > 100) loadMoreDays();
  }, { rootMargin: '0px 0px 120px 0px' }).observe($('#timeline-more'));
}
let scrollFrame = null;
window.addEventListener('scroll', () => {
  if (scrollFrame !== null) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const more = $('#timeline-more');
    if (!more.hidden && window.scrollY > 100 && more.getBoundingClientRect().top < innerHeight + 120) loadMoreDays();
  });
}, { passive: true });
function dismissOnBackdrop(dialog) {
  let startedOutside = false;
  const outside = (event) => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', (event) => { startedOutside = outside(event); });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
  dialog.addEventListener('close', () => { startedOutside = false; });
  dialog.addEventListener('click', (event) => {
    if (startedOutside && outside(event)) closeDialog(dialog);
    startedOutside = false;
  });
}
dismissOnBackdrop($('#task-detail-dialog'));
$('#nav-space').addEventListener('click', () => {
  if (busy) return;
  teamsController.lock();
  currentView = 'space'; renderView(); window.scrollTo(0, 0);
});
$('#logout-button').addEventListener('click', () => work(null, async () => { await lockSpace(); toast('Простір заблоковано. Дані збережені.'); }));

$('#export-button').addEventListener('click', () => work(null, async () => {
  const json = await exportProfile(session);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `na-kontroli-${session.name.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40)}-${localToday()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Копію підготовлено. Збережи файл і пам’ятай його PIN.');
}));

function chooseImport() { if (!busy) { $('#import-file').value = ''; $('#import-file').click(); } }
$('#import-button').addEventListener('click', chooseImport);
$('#import-welcome-button').addEventListener('click', chooseImport);
$('#import-file').addEventListener('change', (event) => work(null, async () => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('Файл завеликий. Максимальний розмір — 10 МБ.');
  const text = await file.text();
  const backup = parseBackup(text);
  importText = text;
  $('#import-form').reset();
  pinPads.get('import-form').configure('import-pin', { length: backup.profile.pinLength });
  $('#import-filename').textContent = file.name;
  showDialog('#import-dialog', '#import-pin');
}));
$('#import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => {
    const epoch = sessionEpoch;
    const newSession = await importProfile(importText, $('#import-pin').value);
    $('#import-dialog').close();
    await enterSpace(newSession, epoch);
    notifyChange(newSession.id);
    toast('Копію відновлено як окремий простір');
  });
});

$('#delete-space-button').addEventListener('click', () => {
  if (busy) return;
  askConfirm({ title: 'Видалити простір?', text: `«${session.name}» і всі його задачі буде видалено з цього пристрою. Відновлення можливе лише з раніше збереженої JSON-копії.`, pin: true, action: async () => {
    const expectedSession = session;
    const verified = await unlockProfile(expectedSession.id, $('#delete-pin').value);
    try {
      if (session !== expectedSession) return;
      // Delete only the version the user has actually reviewed.
      if (verified.revision !== expectedSession.revision) { const error = new Error('Простір змінено в іншому вікні.'); error.code = 'CONFLICT'; throw error; }
      await deleteProfile(verified);
    } finally { revokeSession(verified); }
    const id = expectedSession.id;
    notifyChange(id);
    await lockSpace();
    toast('Простір видалено з пристрою');
  } });
});
$('#confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  work(event.currentTarget, async () => { if (confirmAction) await confirmAction(); $('#confirm-dialog').close(); confirmAction = null; });
});

$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
$$('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.querySelectorAll('form').forEach((form) => pinPads.get(form.id)?.reset());
    dialog.querySelectorAll('input[type="password"], textarea').forEach((input) => { input.value = ''; });
    if (dialog.id === 'import-dialog') importText = null;
    if (dialog.id === 'task-dialog') stepsEditor.reset();
    if (dialog.id === 'routine-dialog') routineStepsEditor.reset();
    if (dialog.id === 'task-detail-dialog') {
      const closedTaskId = detailTaskId;
      clearTaskDetail();
      if (session && !document.querySelector('dialog[open]')) {
        const row = $$('#task-list [data-task-id]').find((item) => item.dataset.taskId === closedTaskId);
        (row?.querySelector('[data-action="view"]') || $('#nav-add')).focus({ preventScroll: true });
      }
    }
  });
});

function showInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const root = $('#install-instructions');
  root.replaceChildren();
  const lines = standalone ? ['Додаток уже відкрито з головного екрана. Усе готово.'] : ios ? ['Відкрий цю сторінку в Safari.', 'Натисни «Поширити» — значок квадрата зі стрілкою.', 'Обери «На початковий екран» → «Додати».'] : ['Відкрий цю сторінку в Chrome на Android.', 'У меню ⋮ обери «Встановити додаток» або «Додати на головний екран».', 'Підтвердь установлення. На комп’ютері скористайся значком установлення в адресному рядку.'];
  const list = document.createElement('ol');
  list.className = 'install-steps';
  lines.forEach((line) => { const item = document.createElement('li'); item.textContent = line; list.append(item); });
  root.append(list);
  $('#native-install-button').hidden = !deferredInstall || standalone;
  showDialog('#install-dialog');
}
$$('.install-button').forEach((button) => button.addEventListener('click', showInstall));
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event; });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('#native-install-button').hidden = true; toast('Додаток встановлено'); });
$('#native-install-button').addEventListener('click', async () => {
  if (!deferredInstall) return;
  try { await deferredInstall.prompt(); await deferredInstall.userChoice; }
  catch { toast('Скористайся меню браузера для встановлення.', true); }
  deferredInstall = null;
  $('#native-install-button').hidden = true;
});

window.addEventListener('online', updateConnection);
window.addEventListener('offline', updateConnection);
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    hiddenTimer = setTimeout(() => {
      pendingLock = true;
      if (!busy) { pendingLock = false; lockSpace().catch(() => {}); }
    }, 300000);
  } else {
    if (hiddenAt && Date.now() - hiddenAt >= 300000) {
      pendingLock = true;
      if (!busy) { pendingLock = false; lockSpace().catch(() => {}); }
    }
    hiddenAt = null;
    if (session) { refreshCalendar(); checkTaskAlerts(); }
  }
});
window.addEventListener('pagehide', () => {
  // Never retain decrypted content in a back/forward page snapshot.
  clearSession();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) lockSpace().catch(() => {}); });
channel?.addEventListener('message', ({ data }) => {
  if (busy) return; // A concurrent write will still fail the storage revision check.
  if (session?.id === data?.id) work(null, async () => { await lockSpace(); toast('Простір змінено в іншому вікні. Увійди повторно.'); });
  else if (!session) renderProfiles().catch(() => {});
});
setInterval(() => {
  const today = localToday();
  if (session && !document.hidden) {
    if (today !== lastToday || generatedThrough !== timelineEnd()) refreshCalendar();
    else renderDueReminders();
    checkTaskAlerts();
  }
}, 30000);

async function boot() {
  try {
    if (!window.isSecureContext || location.protocol === 'file:') throw new Error('Відкрий додаток через HTTPS або локальний сервер localhost. Це потрібно для збереження й захисту даних.');
    if (!window.crypto?.subtle || !window.indexedDB) throw new Error('Браузер не підтримує локальне захищене сховище. Відкрий додаток у сучасному Safari або Chrome.');
    await renderProfiles();
    renderView();
    updateConnection();
    await setupOffline();
  } catch (error) {
    $('#welcome-title').textContent = 'ПОТРІБЕН БРАУЗЕР';
    $('.welcome-intro').textContent = error.message;
    $('#create-space-button').disabled = true;
    $('#import-welcome-button').disabled = true;
  }
}
boot();
