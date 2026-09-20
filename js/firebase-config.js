/** Parse the public Firebase Web configuration. Never evaluates pasted JavaScript. */
const fields = new Set(['apiKey', 'authDomain', 'projectId', 'appId', 'storageBucket', 'messagingSenderId', 'measurementId', 'databaseURL']);
const reject = () => { throw new Error('Вставте лише firebaseConfig із налаштувань Web app. Службові ключі, паролі й код не підходять.'); };
export function parseFirebaseConfig(input) {
  if (typeof input !== 'string' || input.length > 10000) reject();
  let source = input.trim();
  // Accept the exact assignment Firebase Console presents, but no executable suffix.
  source = source.replace(/^(?:(?:const|let|var)\s+)?firebaseConfig\s*=\s*/, '');
  source = source.replace(/;\s*$/, '').trim();
  let index = 0;
  const skip = () => { while (/\s/.test(source[index] || '') && index < source.length) index++; };
  const quoted = () => {
    const quote = source[index++];
    let result = '';
    while (index < source.length) {
      const char = source[index++];
      if (char === quote) return result;
      if (char === '\\') {
        const next = source[index++];
        if (next === quote || next === '\\' || next === '/') result += next;
        else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) { result += String.fromCharCode(parseInt(source.slice(index, index + 4), 16)); index += 4; }
        else reject();
      } else if (char.charCodeAt(0) < 32) reject();
      else result += char;
    }
    reject();
  };
  skip(); if (source[index++] !== '{') reject();
  const config = Object.create(null);
  while (true) {
    skip(); if (source[index] === '}') { index++; break; }
    let key;
    if (source[index] === '"' || source[index] === "'") key = quoted();
    else { const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(index)); if (!match) reject(); key = match[0]; index += key.length; }
    if (!fields.has(key) || Object.hasOwn(config, key)) reject();
    skip(); if (source[index++] !== ':') reject(); skip();
    if (source[index] !== '"' && source[index] !== "'") reject();
    config[key] = quoted();
    if (config[key].length > 300 || !config[key] || /[\x00-\x20\x7f]/.test(config[key])) reject();
    skip(); if (source[index] === '}') { index++; break; }
    if (source[index++] !== ',') reject();
  }
  skip(); if (index !== source.length) reject();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId || '')) throw new Error('Перевірте projectId: потрібен ідентифікатор Firebase-проєкту.');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(config.apiKey || '') || !/^\d+:[A-Za-z0-9]+:web:[A-Za-z0-9]+$/.test(config.appId || '')) throw new Error('У налаштуваннях відсутні коректні apiKey або appId Web app.');
  if (config.authDomain !== `${config.projectId}.firebaseapp.com`) throw new Error('Використайте стандартний authDomain із Firebase Console: projectId.firebaseapp.com.');
  if (config.databaseURL && !/^https:\/\/[A-Za-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)\/?$/.test(config.databaseURL)) reject();
  return { ...config };
}
