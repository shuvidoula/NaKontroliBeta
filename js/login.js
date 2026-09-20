/** Shared between the browser and the trusted administrator account tool. */
export function normalizeLogin(value) {
  if (typeof value !== 'string') throw new Error('Вкажіть логін.');
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(login)) throw new Error('Логін: 3–32 латинські літери, цифри, дефіс або підкреслення. Перший і останній символ — літера або цифра.');
  return login;
}

export function loginToEmail(value, projectId) {
  const login = normalizeLogin(value);
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('Некоректний projectId Firebase.');
  return `${login}@${projectId}.invalid`;
}

export function validateNewPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || !/\S/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Новий пароль: від 12 до 128 символів, без керівних символів і не лише пробіли.');
  return value;
}
