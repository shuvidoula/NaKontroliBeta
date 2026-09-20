/** Offline, role-based instructions. The guide never reads or stores account data. */
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const snippets = new Map();
const external = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}<span class="guide-external" aria-hidden="true"> ↗</span></a>`;
const note = (title, text) => `<aside class="guide-note"><strong>${title}</strong><p>${text}</p></aside>`;
const list = items => `<ol class="guide-instructions">${items.map(item => `<li>${item}</li>`).join('')}</ol>`;
const code = (key, text, label = 'Команда') => {
  snippets.set(key, text);
  return `<div class="guide-code"><div class="guide-code-bar"><span>${label}</span><button type="button" data-guide-copy="${key}" aria-label="Копіювати: ${label}">Копіювати</button></div><pre tabindex="0"><code>${escapeHtml(text)}</code></pre></div>`;
};
const files = `<div class="guide-file-actions"><a class="guide-file" href="./firebase/firestore.rules" download="firestore.rules">Завантажити Rules <span aria-hidden="true">↓</span></a><button class="guide-file" type="button" data-guide-copy-file="rules">Копіювати Rules</button><a class="guide-file" href="./firebase/firestore.indexes.json" download="firestore.indexes.json">Завантажити індекс <span aria-hidden="true">↓</span></a><button class="guide-file" type="button" data-guide-copy-file="index">Копіювати індекс</button></div>`;
const accountFields = `<div class="guide-table-wrap"><table class="guide-table"><caption>Поля документа USERS / ваш_логін</caption><thead><tr><th scope="col">Поле</th><th scope="col">Тип</th><th scope="col">Значення</th></tr></thead><tbody><tr><th scope="row"><code>uid</code></th><td>string</td><td>UID з Authentication</td></tr><tr><th scope="row"><code>enabled</code></th><td>boolean</td><td><code>true</code></td></tr><tr><th scope="row"><code>mustChangePassword</code></th><td>boolean</td><td><code>true</code></td></tr><tr><th scope="row"><code>resetAfter</code></th><td>number</td><td><code>0</code></td></tr></tbody></table></div>`;
const sections = {
  owner: {
    label: 'Власна база', title: 'Створіть свою команду',
    intro: 'Один раз налаштуйте Firebase. Потім видавайте учасникам логіни й запрошення.',
    steps: [
      {
        title: 'Один сайт — незалежні бази', subtitle: 'Як усе пов’язано',
        body: `<p>Усі можуть користуватися цим самим сайтом «НА КОНТРОЛІ». Кожен адміністратор створює <strong>власний Firebase-проєкт</strong>, а учасники його команди підключають <strong>цей самий проєкт</strong>. Копіювати репозиторій для кожної команди не потрібно.</p><div class="guide-flow" aria-label="Сайт, простір і база"><span>Спільний сайт<small>код додатка</small></span><b aria-hidden="true">→</b><span>Ваш простір<small>локальні дані й ключі</small></span><b aria-hidden="true">→</b><span>Ваша база<small>тільки підключені команди</small></span></div>${note('Два різні входи', '<strong>Google-акаунт</strong> потрібен адміністратору на сайті Firebase Console. У нашому додатку користувач вводить <strong>окремий логін і пароль</strong>, які видав адміністратор. Учасникам Google-акаунт не потрібен.')}<p>Почніть із вигаданих задач. Це перша бета команд: її обмеження зібрані у вкладці <button class="guide-inline-button" type="button" data-guide-section="about">«Про бету»</button>.</p>`,
      },
      {
        title: 'Створіть Firebase-проєкт', subtitle: 'Google-акаунт потрібен лише тут',
        body: list([
          `Відкрийте ${external('https://console.firebase.google.com/', 'Firebase Console')} і увійдіть Google-акаунтом, якому належатиме база. Натисніть створення нового проєкту.`,
          'Вкажіть назву. Запишіть <strong>Project ID</strong>: він відрізняється від видимої назви й знадобиться для логінів.',
          'Залиште тариф <strong>Spark</strong>. Google Analytics для цього додатка не потрібна. Firebase Hosting, Cloud Functions і платний Blaze для цього налаштування не потрібні.',
          'Відкрийте <strong>Project settings → General → Your apps</strong> і додайте <strong>Web app</strong> кнопкою <code>&lt;/&gt;</code>. Дайте довільну назву, зареєструйте додаток.',
          'Скопіюйте об’єкт <code>firebaseConfig</code>. SDK уже включений у «НА КОНТРОЛІ»: нічого із запропонованого Firebase коду до репозиторію додавати не треба.',
        ]) + note('Config — налаштування підключення', 'Передавайте його учасникам своєї команди. Паролів у ньому немає. <strong>Service account JSON, private_key та Admin SDK credentials сюди не підходять.</strong> Зберігати config в GitHub або GitHub Secrets не потрібно.') + `<p class="guide-source">Довідка: ${external('https://firebase.google.com/docs/web/setup', 'створення Firebase Web app')}.</p>`,
      },
      {
        title: 'Увімкніть вхід і базу', subtitle: 'Authentication + Cloud Firestore',
        body: list([
          'У <strong>Build → Authentication → Get started → Sign-in method</strong> увімкніть звичайний <strong>Email/Password</strong> і збережіть. Додаток використовує технічні адреси; справжня поштова скринька учасникам не потрібна. Google sign-in, Email link та телефонний вхід не вмикайте заради цього майстра.',
          'У <strong>Authentication → Settings → Authorized domains</strong> додайте домен сайту, яким користуватиметься команда: наприклад <code>OWNER.github.io</code>. Без <code>https://</code> і без шляху репозиторію. Якщо всі заходять на сайт автора, вкажіть домен саме цього сайту.',
          'У <strong>Build → Firestore Database → Create database</strong> виберіть <strong>Standard edition</strong> і створіть базу <code>(default)</code>. Оберіть регіон зберігання свідомо. Почніть із <strong>production mode</strong>. Відкритий test mode та Enterprise/MongoDB для цього додатка не потрібні.',
        ]) + `<p class="guide-source">Довідка: ${external('https://firebase.google.com/docs/auth/web/password-auth', 'Email/Password')}.</p>`,
      },
      {
        title: 'Опублікуйте Rules та індекс', subtitle: 'Обов’язковий контроль доступу',
        body: list([
          'Натисніть <strong>«Копіювати Rules»</strong> нижче. У <strong>Firestore Database → Rules</strong> повністю замініть початковий текст правилами цього випуску й натисніть <strong>Publish</strong>. Можна також завантажити файл і скопіювати його вміст.',
          'У <strong>Indexes → Composite → Add index</strong> вкажіть <strong>Collection ID:</strong> <code>events</code>. Додайте поле <code>pending</code> з режимом <strong>Array contains</strong> та поле <code>createdAt</code> з режимом <strong>Ascending</strong>. <strong>Query scope:</strong> Collection.',
          'Збережіть і дочекайтеся готовності індексу. Файл індексу нижче містить точний опис для перевірки або розгортання через Firebase CLI; у Console його не вставляють у вкладку Rules.',
        ]) + files + note('Сайт і база оновлюються окремо', 'Публікація сайту на GitHub сама не змінює Rules та індекси. Не замінюйте правила на <code>allow read, write: if true</code>. Після оновлення додатка перевіряйте примітки до випуску.') + `<p class="guide-source">Довідка: ${external('https://firebase.google.com/docs/firestore/query-data/indexing', 'індекси Cloud Firestore')}.</p>`,
      },
      {
        title: 'Створіть свій перший логін', subtitle: 'Authentication і запис USERS',
        body: `<p>Логін: <strong>3–32 латинські символи</strong>, цифри, <code>_</code> або <code>-</code>; початок і кінець — літера або цифра. Використовуйте малі літери. Далі <code>ваш_логін</code> означає обраний логін, а <code>projectId</code> — реальний ID з кроку 2.</p>` + list([
          'У <strong>Authentication → Users → Add user</strong> введіть технічну адресу за формулою <code>логін@projectId.invalid</code>. Наприклад, лише для пояснення: логін <code>admin_1</code> та проєкт <code>my-project-123</code> дають <code>admin_1@my-project-123.invalid</code>. Підставте свої значення.',
          'Задайте випадковий тимчасовий пароль щонайменше з <strong>20 символів</strong> із менеджера паролів. Створіть акаунт і скопіюйте його <strong>UID</strong>.',
          'У <strong>Firestore Database → Data → Start collection</strong> створіть колекцію <code>USERS</code> — саме великими літерами. <strong>Document ID</strong> — ваш логін малими літерами, без <code>@</code>; не Auto-ID.',
          'Додайте чотири поля з таблиці. Для boolean вибирайте тип boolean, для числа — number; це не текстові рядки. Натисніть Save.',
        ]) + accountFields + note('Паролів у USERS немає', 'Паролем керує Firebase Authentication. Не додавайте у Firestore пароль або його хеш. Без правильної пари Auth-акаунт + USERS додаток не надасть доступу до команд.') + `<p>Для кожного учасника створюйте окремий логін так само. Власнику бази теж потрібен цей акаунт: Google-вхід у Console його не замінює.</p>`,
      },
      {
        title: 'Увійдіть у додатку', subtitle: 'Тимчасовий пароль → власний',
        body: list([
          'Відкрийте цей сайт через HTTPS. Створіть або розблокуйте свій локальний простір.',
          'Внизу відкрийте <strong>Команди → Бази → Підключити базу</strong>. Вставте <code>firebaseConfig</code> з Web app і натисніть <strong>«Зберегти базу»</strong>. Приймається JSON або блок <code>const firebaseConfig = { … }</code>.',
          'У формі входу введіть тільки <strong>логін</strong>, без <code>@projectId.invalid</code>, та тимчасовий пароль. Натисніть <strong>«Увійти»</strong>.',
          'У формі <strong>«Встановіть власний пароль»</strong> введіть новий пароль двічі: <strong>12–128 символів</strong>, можна довгу фразу; без керівних символів. Він має відрізнятися від тимчасового. Натисніть <strong>«Зберегти пароль»</strong>.',
          'Скопіюйте показаний <strong>Firebase UID</strong>. Він збігається з UID акаунта в Console. Налаштування бази залишаються у цьому локальному просторі; інші відвідувачі сайту автоматично їх не отримують.',
        ]) + note('PIN і пароль — різні речі', 'PIN відкриває локальний простір. Мережевий пароль потрібен для Firebase. Після виходу із простору або команд мережевий вхід потрібно повторити. Скидання пароля Firebase не відновить забутий PIN або втрачені ключі.') + `<p>Якщо застосунок повідомив, що пароль уже змінено, а завершити збереження не вдалося, повторіть операцію. Після перезавантаження входьте <strong>новим</strong> паролем.</p>`,
      },
      {
        title: 'Призначте власника бази', subtitle: 'Один точний UID через Console',
        body: list([
          'У <strong>Firestore Database → Data</strong> створіть колекцію <code>system</code> та документ <code>bootstrap</code>.',
          'Додайте поле <code>ownerUid</code>, тип <strong>string</strong>, значення — <strong>UID свого мережевого акаунта</strong> з попереднього кроку. Не Google email, не логін і не Project ID.',
          'Збережіть документ. Повний шлях: <code>/system/bootstrap</code>.',
          'Поверніться в «Команди», оновіть підключення або знову відкрийте базу. Тепер створіть команду й задайте назву.',
        ]) + note('Власника призначає адміністратор', 'З вебдодатка документ bootstrap змінити не можна. Створювати команди може тільки вказаний UID. Перший випадковий відвідувач сайту прав власника не отримує.'),
      },
      {
        title: 'Додайте учасників', subtitle: 'Окремий акаунт, запрошення, погодження',
        body: list([
          'Для людини повторіть крок <strong>«Створіть свій перший логін»</strong> з її окремим логіном, UID і тимчасовим паролем або використайте адміністративний скрипт із наступного кроку.',
          'У команді натисніть <strong>«Запросити»</strong>. Передайте учаснику адресу цього сайту, <strong>config цього самого Firebase-проєкту</strong>, його логін, тимчасовий пароль та код запрошення узгодженим захищеним каналом.',
          'Учасник створює власний простір, підключає базу, встановлює свій пароль і вводить код. Запрошення одноразове, діє менше <strong>15 хвилин</strong> і створює заявку.',
          'Порівняйте <strong>повний відбиток ключа</strong> у заявці з відбитком, який показує додаток цієї людини. Звірте його окремим узгодженим каналом. Лише після цього натисніть <strong>«Погодити учасника»</strong>.',
          'Дочекайтеся синхронізації. Створіть вигадану задачу, призначте учаснику, перевірте виконання етапу, дату й час на обох пристроях. Після цього зробіть резервні копії просторів.',
        ]) + note('Видимість команди', 'Усі погоджені учасники можуть читати вміст своєї команди. Призначення задачі конкретній людині не приховує її від решти. Не передавайте учасникам акаунт адміністратора.'),
      },
      {
        title: 'Видача та скидання паролів', subtitle: 'Інструмент адміністратора зі збереженням UID',
        body: `<p>Для першого акаунта достатньо Console. Для забутого пароля використовуйте готовий <code>scripts/manage-accounts.mjs</code> з вихідного архіву/репозиторію. Він зберігає UID, ключову прив’язку й історію. На опублікованій сторінці цей адміністративний файл не виконується.</p>` + list([
          'На довіреному комп’ютері встановіть <strong>Node.js 24</strong> та Google Cloud CLI (<code>gcloud</code>). Розпакуйте вихідний архів і відкрийте термінал у його корені.',
          'Потрібні <strong>Application Default Credentials (ADC)</strong> з правами керування Auth і Firestore у вашому проєкті. Звичайні користувацькі ADC gcloud можуть бути відхилені Firebase Auth: у Google Cloud Console цього проєкту налаштуйте consent screen та OAuth client типу <strong>Desktop app</strong>. Збережіть його JSON <strong>поза папкою сайту й репозиторієм</strong>. Права та consent screen залежать від організації.',
          'У наступній команді замініть шлях на свій OAuth client JSON. Увійдіть відповідним Google-акаунтом адміністратора та встановіть залежності. Відкритий Google-сеанс у браузері або Cloud Shell сам по собі не налаштовує ADC.',
        ]) + code('adc', 'gcloud auth application-default login --client-id-file=/private/path/oauth-desktop-client.json\nnpm ci', 'Налаштування довіреного комп’ютера') + `<p>Замініть <code>my-project-123</code> на свій Project ID, а <code>officer_1</code> — на потрібний логін. Спочатку можна перевірити назви без мережі та створення акаунта:</p>` + code('account-dry', 'node scripts/manage-accounts.mjs create --project my-project-123 --login officer_1 --dry-run', 'Безпечна перевірка параметрів') + code('account-create', 'node scripts/manage-accounts.mjs create --project my-project-123 --login officer_1', 'Створити нового учасника') + code('account-reset', 'node scripts/manage-accounts.mjs reset --project my-project-123 --login officer_1', 'Скинути пароль наявного учасника') + `<p>Після успіху скрипт покаже UID і <strong>новий випадковий тимчасовий пароль із 32 символів</strong>. Передайте його тільки цій людині. Під час reset відкликаються попередні сеанси; новий вхід — не раніше часу <code>signInAfter</code> у відповіді. Годинник комп’ютера має бути правильним. Учасник знову встановить власний пароль.</p>${note('Чого не робити', 'Не видаляйте Auth-користувача, не створюйте його заново та не стирайте «хеш» у Firestore: це не спосіб скидання. Не публікуйте вивід скрипта, ADC, OAuth client JSON або службові ключі. Скрипт не запускають у публічному CI.')}<h4>Якщо операція перервалася</h4><p>Auth і Firestore не є однією транзакцією. Після збою доступ може залишитися вимкненим. Перевірте відповідність технічної адреси, UID та <code>USERS</code>, усуньте причину й переконайтеся, що інший адміністратор не робить те саме. Лише після перевірки один адміністратор може продовжити:</p>` + code('account-resume', 'node scripts/manage-accounts.mjs reset --project my-project-123 --login officer_1 --resume', 'Продовжити перевірене відновлення') + `<p><code>--resume</code> генерує ще один новий пароль; не запускайте його паралельно. Якщо відповідь містить <code>stateUncertain</code>, спочатку перевірте Console. Якщо create створив тільки Auth, відновіть <code>USERS/логін</code> з тим самим UID, <code>enabled: false</code>, <code>mustChangePassword: true</code>, <code>resetAfter: 0</code>, потім застосуйте перевірений reset --resume.</p><p>Для старих акаунтів із реальною email-адресою автоматичної міграції немає: потрібна зміна адреси через довірений Admin SDK зі збереженням UID, далі — відповідний USERS і reset. Не створюйте заміну акаунта. Подробиці доступні також у <a href="./docs/FIREBASE-SETUP.md" download>повній інструкції</a>.</p><p class="guide-source">Офіційна довідка: ${external('https://firebase.google.com/docs/admin/setup#testing_with_gcloud_end_user_credentials', 'Firebase Admin та ADC')}, ${external('https://firebase.google.com/docs/auth/admin/manage-sessions', 'відкликання сеансів')}.</p>`,
      },
      {
        title: 'Якщо щось не працює', subtitle: 'Перевірка перед першим запуском',
        body: `<dl class="guide-faq"><dt>Просить Google-акаунт</dt><dd>На Firebase Console це нормально: ви входите як власник проєкту. У «НА КОНТРОЛІ» потрібен окремий логін, створений у кроці 5. Google-пароль у наш додаток не вводять.</dd><dt>Логін або пароль не підходить</dt><dd>Перевірте правильний projectId, увімкнений Email/Password, точну технічну адресу в Authentication і документ USERS/логін. Вводьте логін без @. Після скидання використайте новий тимчасовий пароль.</dd><dt>permission-denied або неможливо створити команду</dt><dd>Перевірте базу (default), опубліковані Rules, чотири поля USERS, enabled: true і UID. Для власника має існувати system/bootstrap з точним ownerUid.</dd><dt>failed-precondition або запит індексу</dt><dd>Створіть індекс events: pending — Array contains, createdAt — Ascending, scope Collection. Дочекайтеся готовності.</dd><dt>Застарілий сеанс чи вимкнений доступ</dt><dd>Увійдіть повторно після signInAfter. Якщо доступ вимкнено, лише адміністратор має перевірити USERS та результат reset; не змінюйте навмання UID і resetAfter.</dd><dt>Код запрошення не працює</dt><dd>Перевірте однаковий projectId в обох просторах. Одноразовий код швидко спливає — створіть новий, якщо минуло 15 хвилин.</dd><dt>Задача лишається в черзі</dt><dd>Потрібні інтернет, відкритий простір і чинний вхід. Перевірте квоти Spark у Console. Позначка черги не означає підтверджену доставку.</dd></dl>${note('Перший запуск завершено, коли…', 'На двох окремих пристроях перевірені вхід, погодження учасника, обмін вигаданою задачею, виконання етапів, точний час та повторний запуск без мережі. Збережені JSON-копії обох просторів. Безкоштовний Spark має квоти: стежте за використанням у Console; додаток сам не вмикає платний тариф.')}`,
      },
    ],
  },
  member: {
    label: 'Учасник', title: 'Приєднайтеся до команди',
    intro: 'Вам не потрібно створювати Firebase, Google-акаунт чи власний репозиторій.',
    steps: [
      { title: 'Отримайте доступ у адміністратора', subtitle: 'Сайт + база + логін + запрошення', body: `<p>Попросіть адресу цього сайту, <strong>firebaseConfig бази команди</strong>, свій логін, тимчасовий пароль та одноразове запрошення. Адміністратор створює для вас окремий акаунт; самостійної реєстрації немає.</p>${note('Уся команда — в одному проєкті', 'Не створюйте нову Firebase-базу, щоб вступити в наявну команду. Підключіть саме projectId, який передав адміністратор. Якщо код запрошення сплив, попросіть новий.')}` },
      { title: 'Створіть простір і увійдіть', subtitle: 'PIN для пристрою, пароль для бази', body: list(['Відкрийте сайт. Натисніть <strong>«Створити простір»</strong>, задайте назву й PIN із чотирьох цифр. Запам’ятайте його: відновлення PIN через пошту немає.', 'Відкрийте <strong>Команди → Бази → Підключити базу</strong>, вставте config адміністратора й натисніть <strong>«Зберегти базу»</strong>.', 'Введіть свій <strong>логін без @</strong> та тимчасовий пароль. Після входу встановіть власний пароль двічі — 12–128 символів, відмінний від тимчасового.', 'Збережіть новий пароль у менеджері паролів. Якщо забудете його, адміністратор має виконати reset; локальний PIN при цьому не змінюється.']) },
      { title: 'Вступіть і звірте відбиток', subtitle: 'Код не дає автоматичного доступу', body: list(['Введіть одноразове запрошення адміністратора. Термін дії — менше 15 хвилин.', 'У картці заявки натисніть <strong>«Копіювати відбиток»</strong>. Передайте адміністратору <strong>весь код</strong> окремим узгодженим каналом. Він має збігатися з відбитком у заявці.', 'Дочекайтеся погодження та синхронізації. Лише після отримання ключа команди з’являться її задачі.', 'Перевірте обмін вигаданою задачею. Виконані етапи й задача матимуть час виконання. Усі погоджені учасники можуть читати вміст команди.']) },
      { title: 'Збережіть простір і встановіть додаток', subtitle: 'Резервна копія потрібна навіть із Firebase', body: list(['У <strong>Простір → Експортувати JSON</strong> збережіть зашифровану копію в надійному місці. Вона містить ключі й локальну історію. Для відновлення потрібен PIN цієї копії.', 'Для перенесення імпортуйте JSON на новому пристрої й припиніть користуватися старою копією. Не запускайте клон одного простору одночасно на двох пристроях: окреме керування пристроями ще не готове.', 'На iPhone відкрийте сайт у Safari → «Поділитися» → «На початковий екран». На Android відкрийте меню браузера → «Встановити додаток» або «Додати на головний екран». Назва пункту залежить від браузера.', 'Дочекайтеся готовності офлайн-режиму в налаштуваннях простору. Особисті задачі й отримана історія доступні без мережі; для обміну новими командними подіями потрібен інтернет.']) + note('Сповіщення в цій беті', 'Нагадування за 60, 30 та 10 хвилин працюють, поки додаток відкритий на екрані й простір розблокований. У фоні та після закриття сповіщень немає.') },
    ],
  },
  publish: {
    label: 'GitHub', title: 'Опублікуйте свій сайт',
    intro: 'Цей розділ потрібен тільки тому, хто розміщує додаток. Учасники просто відкривають посилання.',
    steps: [
      { title: 'Підготуйте репозиторій', subtitle: 'Чисті вихідні файли з архіву', body: list(['Створіть репозиторій на GitHub. Для безкоштовного GitHub Pages використайте публічний репозиторій.', 'Розпакуйте <strong>NaKontroli-GitHub.zip</strong>. Завантажте <strong>вміст архіву в корінь</strong> репозиторію, щоб index.html був одразу в корені, а не всередині ще однієї папки. Основна гілка має називатися <code>main</code>.', 'Збережіть структуру папок. Переконайтеся, що прихована папка <code>.github</code> теж завантажена і файл <code>.github/workflows/pages.yml</code> видно в репозиторії. Через Git або GitHub Desktop приховані файли також мають бути включені.', 'Не додавайте JSON-копії просторів, паролі, OAuth client JSON, ADC або service account keys. Конфіг кожен підключає у власному просторі — спільного firebaseConfig у коді немає.']) },
      { title: 'Увімкніть GitHub Pages', subtitle: 'Готовий workflow у комплекті', body: list(['У репозиторії відкрийте <strong>Settings → Pages → Build and deployment</strong>. У <strong>Source</strong> виберіть <strong>GitHub Actions</strong>.', 'Відкрийте <strong>Actions → Publish GitHub Pages</strong>. Якщо GitHub попросить дозволити workflows, увімкніть їх для свого репозиторію. Запустіть <strong>Run workflow</strong> для гілки main, якщо запуск після завантаження вже не відбувся.', 'Дочекайтеся зеленого завершення build і deploy. Готовий workflow збирає тільки дозволені публічні файли в dist; адміністративні скрипти та залежності не публікуються на Pages.', 'Відкрийте адресу, показану в <strong>Settings → Pages</strong> або завершеному deploy. Для звичайного репозиторію вона матиме вигляд <code>https://OWNER.github.io/REPOSITORY/</code>. Користуйтеся HTTPS.']) + `<p class="guide-source">Довідка: ${external('https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages', 'публікація через GitHub Actions')}.</p>` },
      { title: 'Перевірте чистий запуск', subtitle: 'Перш ніж роздавати посилання', body: list(['Відкрийте HTTPS-адресу на телефоні. Новий браузер має показувати створення простору без готових профілів, задач або підключених баз.', 'Створіть свій простір, додайте вигадану задачу з часом та етапами. Перевірте виконання, редагування та JSON-експорт.', 'Встановіть додаток на головний екран. Дочекайтеся готовності офлайн-режиму, закрийте й відкрийте без інтернету — локальні дані мають лишитися.', 'Для команд виконайте вкладку <strong>«Власна база»</strong>. Кожен інший адміністратор може виконати ті самі кроки зі своїм Firebase-проєктом на цій самій адресі сайту. У Authorized domains кожного проєкту додається домен спільного сайту.']) },
      { title: 'Оновлюйте без втрати просторів', subtitle: 'Та сама адреса сайту', body: `<p>Нову версію файлів завантажуйте в той самий репозиторій і гілку main. Дочекайтеся успішного Actions. Встановлений додаток перевіряє оновлення; якщо він повідомляє про готовність, закрийте всі його вікна й відкрийте знову.</p><p>Перед оновленням збережіть JSON-копію важливих просторів. Не очищайте дані браузера заради оновлення: там лежать простори. Зміна домену або браузера створює інше локальне сховище, тож для перенесення потрібен експорт/імпорт.</p>${note('Хто відповідає за дані', 'Власник кожного Firebase-проєкту окремо керує своїми акаунтами, Rules і квотами. Власник спільного сайту постачає код, який працює на пристроях: користувачі мають довіряти цьому джерелу та його оновленням. Наявність окремої бази не усуває цю залежність.')}` },
    ],
  },
  about: {
    label: 'Про бету', title: 'Перша бета «НА КОНТРОЛІ»',
    intro: 'Особисте — локально. Команди — через власний Firebase. Поки перевіряємо на вигаданих даних.',
    steps: [
      { title: 'Що вже працює', subtitle: 'Задачі, повтори, командна взаємодія', body: `<p>Особисті задачі, час, етапи, повтори за днями тижня та щомісяця, історія виконання, локальні простори з PIN, зашифровані JSON-копії й встановлення на головний екран. Команди підключаються до Firebase-проєкту свого адміністратора: окремі логіни, заявки, погодження, призначення задач та етапів.</p><p>Дистрибутив не містить готових користувачів, паролів, задач чи налаштувань чужої бази. Перевірки з емулятором не замінюють перевірку вашого хмарного проєкту й двох справжніх телефонів.</p>${note('Статус безпеки', 'Бета ще не пройшла незалежний аудит. Використовуйте вигадані дані; бойові, секретні та реальні службові відомості сюди поки не вносьте. PIN із чотирьох цифр має обмежену стійкість.')}` },
      { title: 'Де дані та що означає доставка', subtitle: 'Локальні копії, Firebase і очищення', body: `<p>Особисті задачі залишаються у просторі браузера. Командний текст шифрується на пристрої. Firebase зберігає зашифровані конверти та службові метадані: акаунти, відкриті ключі, членство, ролі, призначення, версії, позначки виконання й квитанції. Паролями окремо керує Firebase Authentication.</p><p>Після підтвердження отримання всіма адресатами відкритий авторизований додаток може прибрати транспортний шифротекст. Історія на пристроях і мінімальні серверні записи лишаються. <strong>Автоматичного строку видалення немає</strong>: якщо хтось не підтвердив отримання, конверт може зберігатися невизначено довго. Закритий додаток нічого не очищає.</p><p>Firebase не замінює резервну копію ключів. Очищення даних браузера або видалення простору без JSON-копії може назавжди позбавити доступу до історії.</p>` },
      { title: 'Поточні межі', subtitle: 'Що врахувати перед перевіркою', body: `<ul class="guide-bullets"><li>До <strong>30 учасників</strong> у команді та до <strong>12 етапів</strong> у задачі.</li><li>Видалення учасників, пониження адміністратора, ротація ключів та окрема реєстрація другого пристрою ще не реалізовані. Зміна пароля чи блокування доступу не стирає вже отримані дані.</li><li>Один Firebase UID прив’язаний до ключів одного простору. Імпортована копія клонує цю ідентичність, тому не використовуйте дві її копії одночасно.</li><li>Обов’язкова зміна тимчасового пароля керує звичайним інтерфейсом. Firestore Rules не можуть криптографічно довести, що змінений клієнт справді оновив пароль Auth.</li><li>Rules не перевіряють криптографічні підписи: перевірка відбувається на пристрої. Зловживання допущеним учасником може змінити серверну версію задачі або затримати чергу. Потрібні подальший захист і надійна локальна копія адміністратора.</li><li>Сповіщення працюють тільки у відкритому на екрані додатку з розблокованим простором. Фонових і закритих push-сповіщень немає.</li></ul><p>Для наступного етапу потрібні перевірки на фізичних iPhone та Android, повна модель відкликання й відновлення, керування пристроями та незалежний аудит.</p>` },
    ],
  },
};

let dialog;
let activeSection = 'owner';
let activeStep = 0;
let returnFocus;
let pointerStartedOnBackdrop = false;
let copying = false;

function updateFooter() {
  const total = sections[activeSection].steps.length;
  dialog.querySelector('[data-guide-progress]').textContent = `${activeStep + 1} / ${total}`;
  dialog.querySelector('[data-guide-back]').disabled = activeStep === 0;
  dialog.querySelector('[data-guide-next]').textContent = activeStep === total - 1 ? 'Готово' : 'Наступний крок →';
}

function selectStep(index, { scroll = true, focus = false } = {}) {
  activeStep = Math.max(0, Math.min(index, sections[activeSection].steps.length - 1));
  dialog.querySelectorAll('.guide-step').forEach((step, position) => { step.open = position === activeStep; });
  updateFooter();
  const summary = dialog.querySelectorAll('.guide-step > summary')[activeStep];
  if (focus) summary.focus({ preventScroll: true });
  if (scroll) summary.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function renderSection(section) {
  activeSection = Object.hasOwn(sections, section) ? section : 'owner';
  activeStep = 0;
  const content = sections[activeSection];
  dialog.querySelectorAll('[data-guide-section][role="tab"]').forEach(tab => {
    const selected = tab.dataset.guideSection === activeSection;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  const panel = dialog.querySelector('#guide-panel');
  panel.setAttribute('aria-labelledby', `guide-tab-${activeSection}`);
  panel.innerHTML = `<div class="guide-intro"><span class="guide-section-count">${content.steps.length} ${content.steps.length > 4 ? 'кроків' : 'кроки'}</span><h3>${content.title}</h3><p>${content.intro}</p></div><div class="guide-steps">${content.steps.map((step, index) => `<details class="guide-step" ${index === 0 ? 'open' : ''}><summary><span class="guide-step-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><span class="guide-step-label"><strong>${step.title}</strong><small>${step.subtitle}</small></span><span class="guide-step-chevron" aria-hidden="true">⌄</span></summary><div class="guide-step-body">${step.body}</div></details>`).join('')}</div>`;
  panel.querySelectorAll('.guide-step').forEach((step, index) => {
    step.addEventListener('toggle', () => {
      if (!step.open || !step.isConnected) return;
      activeStep = index;
      panel.querySelectorAll('.guide-step').forEach(other => { if (other !== step) other.open = false; });
      updateFooter();
    });
  });
  dialog.querySelector('.guide-scroll').scrollTop = 0;
  dialog.querySelector('[data-guide-status]').textContent = '';
  updateFooter();
}

async function copyValue(button) {
  if (copying) return;
  copying = true;
  const status = dialog.querySelector('[data-guide-status]');
  const oldText = button.textContent;
  button.disabled = true;
  status.textContent = '';
  let value;
  try {
    if (button.hasAttribute('data-guide-copy-file')) {
      const isRules = button.dataset.guideCopyFile === 'rules';
      const response = await fetch(new URL(isRules ? '../firebase/firestore.rules' : '../firebase/firestore.indexes.json', import.meta.url));
      if (!response.ok) throw new Error('Файл не завантажився.');
      value = await response.text();
      if (isRules ? !value.startsWith('rules_version') : !Array.isArray(JSON.parse(value).indexes)) throw new Error('Некоректний файл налаштувань.');
    } else {
      value = snippets.get(button.dataset.guideCopy);
      if (typeof value !== 'string') throw new Error('Текст недоступний.');
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Буфер недоступний.');
      await navigator.clipboard.writeText(value);
    } catch {
      // Selection fallback works in installed browsers that restrict Clipboard API.
      const fallback = document.createElement('textarea');
      fallback.value = value;
      fallback.readOnly = true;
      fallback.className = 'guide-copy-fallback';
      fallback.setAttribute('aria-label', 'Текст для копіювання');
      dialog.append(fallback);
      let copied;
      try {
        fallback.select();
        copied = document.execCommand('copy');
      } finally { fallback.remove(); }
      button.focus({ preventScroll: true });
      if (!copied) throw new Error('Буфер обміну недоступний. Скопіюйте текст вручну або завантажте файл.');
    }
    button.textContent = 'Скопійовано ✓';
    status.textContent = 'Скопійовано в буфер обміну.';
  } catch (error) {
    status.textContent = error.message || 'Не вдалося скопіювати. Спробуйте завантажити файл.';
  } finally {
    button.disabled = false;
    copying = false;
    setTimeout(() => { if (button.isConnected) button.textContent = oldText; }, 1800);
  }
}

/** Install once; dynamically rendered data-open-guide buttons are supported. */
export function setupGuide() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'setup-guide';
  dialog.className = 'setup-guide';
  dialog.setAttribute('aria-labelledby', 'guide-title');
  dialog.innerHTML = `<header class="guide-header"><div><span class="guide-kicker">НА КОНТРОЛІ <span>БЕТА</span></span><h2 id="guide-title">Інструкція</h2></div><button class="guide-close" type="button" data-guide-close aria-label="Закрити інструкцію">×</button></header><div class="guide-tabs" role="tablist" aria-label="Виберіть інструкцію">${Object.entries(sections).map(([key, section]) => `<button type="button" role="tab" id="guide-tab-${key}" data-guide-section="${key}" aria-controls="guide-panel" aria-selected="false" tabindex="-1">${section.label}</button>`).join('')}</div><div class="guide-scroll"><section id="guide-panel" role="tabpanel" tabindex="0"></section></div><footer class="guide-footer"><p data-guide-status class="guide-status" role="status" aria-live="polite"></p><div class="guide-navigation"><button type="button" class="guide-back" data-guide-back aria-label="Попередній крок">← Назад</button><span class="guide-progress" data-guide-progress aria-label="Поточний крок"></span><button type="button" class="guide-next" data-guide-next>Наступний крок →</button></div></footer>`;
  document.body.append(dialog);
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (target?.hasAttribute('data-guide-close')) dialog.close();
    else if (target?.dataset.guideSection) renderSection(target.dataset.guideSection);
    else if (target?.hasAttribute('data-guide-next')) {
      if (activeStep === sections[activeSection].steps.length - 1) dialog.close();
      else selectStep(activeStep + 1, { focus: true });
    } else if (target?.hasAttribute('data-guide-back')) selectStep(activeStep - 1, { focus: true });
    else if (target?.hasAttribute('data-guide-copy') || target?.hasAttribute('data-guide-copy-file')) void copyValue(target);
    else if (event.target === dialog && pointerStartedOnBackdrop) dialog.close();
    pointerStartedOnBackdrop = false;
  });
  dialog.addEventListener('pointerdown', event => {
    const bounds = dialog.getBoundingClientRect();
    pointerStartedOnBackdrop = event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  });
  dialog.querySelector('.guide-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = Object.keys(sections);
    let index = keys.indexOf(activeSection);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    renderSection(keys[index]);
    dialog.querySelector(`#guide-tab-${keys[index]}`).focus();
  });
  dialog.addEventListener('close', () => {
    pointerStartedOnBackdrop = false;
    if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
  });
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-open-guide]');
    if (!trigger) return;
    event.preventDefault();
    openGuide(trigger.dataset.openGuide || 'owner');
  });
  renderSection('owner');
  return dialog;
}

export function openGuide(section = 'owner') {
  setupGuide();
  if (!dialog.open) returnFocus = document.activeElement;
  renderSection(section);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.guide-close').focus({ preventScroll: true });
}
