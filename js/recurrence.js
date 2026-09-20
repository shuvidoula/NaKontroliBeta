import { addDays, parseDate } from './dates.js';
import { StorageError, validateTasks, validateRoutines } from './store.js';

const MAX_TASKS = 20000;

function requireDate(date) {
  if (typeof date !== 'string' || !parseDate(date)) {
    throw new StorageError('INVALID_RECURRENCE', 'Вибери коректну дату повторення.');
  }
}

function requireTimestamp(now) {
  if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) ||
      !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) {
    throw new StorageError('INVALID_RECURRENCE', 'Некоректний час створення повторення.');
  }
}

function limitReached() {
  throw new StorageError('TOO_MANY_TASKS', 'Повторення створює понад 20 000 задач. Скороти період або кількість правил.');
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function datesForRule(rule, from, to) {
  if (!rule.enabled || from > to || rule.startDate > to) return [];
  const first = from > rule.startDate ? from : rule.startDate;
  const excluded = new Set(rule.excludedDates);
  const dates = [];
  const include = (date) => {
    if (date < first || date > to || excluded.has(date)) return;
    if (dates.length >= MAX_TASKS) limitReached();
    dates.push(date);
  };
  if (rule.frequency === 'daily' || rule.frequency === 'weekly') {
    let date = first;
    let weekday = new Date(`${first}T12:00:00.000Z`).getUTCDay() || 7;
    let remaining = Math.round((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${first}T12:00:00.000Z`)) / 86400000);
    if (rule.frequency === 'weekly') {
      const firstOffset = Math.min(...rule.weekdays.map((day) => (day - weekday + 7) % 7));
      if (firstOffset > remaining) return dates;
      date = addDays(date, firstOffset);
      weekday = ((weekday - 1 + firstOffset) % 7) + 1;
      remaining -= firstOffset;
    }
    while (date <= to) {
      include(date);
      const increment = rule.frequency === 'daily' ? 1 : Math.min(...rule.weekdays.map((day) => (day - weekday + 7) % 7 || 7));
      if (increment > remaining) break; // Includes the 9999-12-31 upper bound.
      date = addDays(date, increment);
      weekday = ((weekday - 1 + increment) % 7) + 1;
      remaining -= increment;
    }
  } else {
    const anchorDay = Number(rule.startDate.slice(8));
    let [year, month] = first.slice(0, 7).split('-').map(Number);
    const endMonth = to.slice(0, 7);
    while (`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` <= endMonth) {
      const lastDay = daysInMonth(year, month);
      include(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(anchorDay, lastDay)).padStart(2, '0')}`);
      if (year === 9999 && month === 12) break;
      if (month === 12) { month = 1; year += 1; } else month += 1;
    }
  }
  return dates;
}

// Paused rules and explicitly excluded dates produce no new occurrences.
export function occurrenceDates(rule, from, to) {
  requireDate(from);
  requireDate(to);
  return datesForRule(validateRoutines([rule])[0], from, to);
}

export function materializeRoutines(tasks, routines, throughDate, { now = new Date().toISOString() } = {}) {
  requireDate(throughDate);
  requireTimestamp(now);
  const result = validateTasks(tasks);
  const rules = validateRoutines(routines);
  const ids = new Map(result.map((task) => [task.id, task]));
  const occurrences = new Set(result.filter((task) => task.routineId !== null)
    .map((task) => `${task.routineId}\0${task.occurrenceDate}`));
  for (const rule of rules) {
    for (const date of datesForRule(rule, rule.startDate, throughDate)) {
      const occurrenceKey = `${rule.id}\0${date}`;
      if (occurrences.has(occurrenceKey)) continue;
      const id = `r_${rule.id}_${date}`;
      // A conflicting ordinary task must not be overwritten or hide an occurrence.
      if (ids.has(id)) throw new StorageError('OCCURRENCE_CONFLICT', 'Ідентифікатор повторення вже зайнятий іншою задачею.');
      if (result.length >= MAX_TASKS) limitReached();
      const task = {
        id, title: rule.title, kind: rule.kind, date, time: rule.time,
        routineId: rule.id, occurrenceDate: date,
        steps: rule.steps.map((step) => ({ ...step, done: false, completedAt: null, completionHistory: [] })),
        done: false, completedAt: null, completionHistory: [], createdAt: now, updatedAt: now,
      };
      result.push(task);
      ids.set(id, task);
      occurrences.add(occurrenceKey);
    }
  }
  return result;
}

function isPristine(task, rule) {
  return !task.done && task.completedAt === null && task.completionHistory.length === 0 &&
    task.createdAt === task.updatedAt && task.title === rule.title && task.kind === rule.kind &&
    task.time === rule.time && task.date === task.occurrenceDate && task.steps.length === rule.steps.length &&
    task.steps.every((step, index) => !step.done && step.completedAt === null && step.completionHistory.length === 0 &&
      step.id === rule.steps[index].id && step.title === rule.steps[index].title);
}

// Prune replaceable future snapshots only. The caller then materializes its
// chosen horizon using the updated rule list and saves both arrays atomically.
export function reconcileRoutine(tasks, oldRule, newRule, today) {
  requireDate(today);
  const normalized = validateTasks(tasks);
  const previous = oldRule == null ? null : validateRoutines([oldRule])[0];
  const replacement = newRule == null ? null : validateRoutines([newRule])[0];
  if (previous && replacement && previous.id !== replacement.id) {
    throw new StorageError('INVALID_RECURRENCE', 'Не можна змінювати ідентифікатор правила повторення.');
  }
  if (!previous) return normalized;
  return normalized.filter((task) => task.routineId !== previous.id || task.occurrenceDate < today || !isPristine(task, previous));
}
