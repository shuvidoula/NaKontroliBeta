// Calendar dates deliberately use local components, never UTC slicing.
export function localToday(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function localTime(now = new Date()) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return localToday(date) === value ? date : null;
}

export function addDays(value, count = 1) {
  const date = parseDate(value);
  if (!date || !Number.isInteger(count)) throw new Error('Вибери коректну дату.');
  date.setDate(date.getDate() + count);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) throw new Error('Це остання доступна дата.');
  return localToday(date);
}

export function addMinutes(date, time, minutes = 30) {
  if (time === null || time === undefined || time === '') throw new Error('Вибери час.');
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Вибери коректний час.');
  if (!parseDate(date)) throw new Error('Вибери коректну дату.');
  if (!Number.isSafeInteger(minutes)) throw new Error('Вкажи коректну кількість хвилин.');
  const [hours, minute] = time.split(':').map(Number);
  const total = hours * 60 + minute + minutes;
  if (!Number.isSafeInteger(total)) throw new Error('Вкажи коректну кількість хвилин.');
  const days = Math.floor(total / 1440);
  const clockMinutes = ((total % 1440) + 1440) % 1440;
  // Advance the calendar separately from the clock. Adding elapsed milliseconds
  // would skip/repeat an hour on daylight-saving transitions.
  return {
    date: addDays(date, days),
    time: `${String(Math.floor(clockMinutes / 60)).padStart(2, '0')}:${String(clockMinutes % 60).padStart(2, '0')}`,
  };
}

export function nextHalfHour(date, time) {
  addMinutes(date, time, 0); // Reuse strict date/time validation.
  return addMinutes(date, time, 30 - (Number(time.slice(3)) % 30));
}

export function formatDate(value, options = {}) {
  const date = parseDate(value);
  if (!date) return 'Без дати';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', ...options }).format(date);
}

export function relativeDate(value, today = localToday()) {
  if (value === today) return 'Сьогодні';
  if (value === addDays(today, 1)) return 'Завтра';
  if (value === addDays(today, -1)) return 'Вчора';
  return formatDate(value, { year: 'numeric' });
}
