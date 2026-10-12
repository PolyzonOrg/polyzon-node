# Polyzon SDK для Node.js

Официальный клиент Node.js / TypeScript для [публичного API Polyzon](https://api.polyzon.org): поиск
3D-моделей по Thingiverse, Printables, MakerWorld, Cults3D и ещё 20 площадкам и карточки моделей. Без
зависимостей во время выполнения, с полными типами TypeScript, пулом keep-alive соединений,
автоматическими повторами, поддержкой прокси и типизированными ошибками.

[English version](README.md)

## Требования

- Node.js 20.19 или новее (проверено на 20.19, 22, 24 и 26).
- Токен API из [polyzon.org/account](https://polyzon.org/account/) (раздел «API»).

## Установка

```sh
npm install polyzon
```

## Быстрый старт

```js
import Polyzon from 'polyzon';

const client = new Polyzon(); // берёт токен из POLYZON_API_KEY

const page = await client.search({ q: 'дракон', size: 10, free: true });
for (const item of page.items) {
  console.log(`[${item.source}] ${item.title} — ${item.url}`);
}
```

Больше примеров в [`examples/`](examples): быстрый старт, постраничный обход, параллельная загрузка,
прокси.

## Авторизация

Каждый запрос подписывается личным токеном (`pzk_…`). Передайте его явно или задайте переменную
окружения `POLYZON_API_KEY`:

```js
const client = new Polyzon({ apiKey: process.env.POLYZON_API_KEY });
```

Конструктор проверяет токен (1–512 видимых символов ASCII) и никогда его не печатает:
`console.log(client)` показывает `pzk_Q7xR…`.

## Использование

Все методы асинхронные и принимают необязательный последний аргумент с
[настройками запроса](#таймауты-и-отмена).

### Поиск

```js
const page = await client.search({
  q: 'органайзер для инструментов', // обязательно, по-русски или по-английски, до 200 символов
  page: 1, // 1..100
  size: 20, // 1..50, page × size ≤ 2400
  sort: 'popular', // relevant | popular | newest | likes | makes | downloads
  free: true, // только бесплатные
  sources: ['printables', 'thingiverse'],
  formats: ['stl', '3mf'],
  license: ['cc0', 'cc-by'],
  lang: 'en', // ru (по умолчанию) | en — машинный перевод названий и тегов
});

page.total; // 1873
page.totalRelation; // 'eq' (точно) или 'gte' (не меньше)
page.hasMore; // есть ли следующая страница в пределах 2400 результатов
page.partial; // часть каталога не ответила
page.correctedQuery; // исправленный запрос, по которому искал сервер, или null
page.items[0]; // { source, id, title, url, thumbnail, creator, license, price, formats, tags, stats, publishedAt }
```

Незаданные параметры не отправляются. Известные значения экспортированы как `SOURCES`, `LICENSES`,
`SORTS`, `LANGS`, `PRICE_TYPES` и `TOTAL_RELATIONS`; любые другие строки тоже принимаются — новые
площадки появляются.

### Постраничный обход

`searchAll` лениво идёт по страницам и отдаёт модели по одной:

```js
for await (const item of client.searchAll({ q: 'shelf bracket', size: 50 })) {
  console.log(item.title);
  if (enough()) break;
}
```

Обход начинается с `params.page` (по умолчанию 1) и заканчивается, когда `hasMore` — false, страница
пустая или достигнута страница 100 (предел сервера). **Каждая страница — один запрос суточной квоты**:
берите `size: 50` и выходите из цикла, как только данных достаточно.

### Карточка модели

```js
const model = await client.getModel('thingiverse', 'tv-1234567', { lang: 'en' });
model.description;
model.images; // адреса на CDN площадки
model.license; // { id: 'cc-by-nc', raw: 'Creative Commons - Attribution - Non-Commercial' } или null
model.copies; // та же модель на других площадках: [{ source, id }]
```

`source` и `id` — те же, что в элементах поиска. Они проверяются до запроса (`source` —
`^[a-z0-9]{1,32}$`, `id` — `^[A-Za-z0-9._-]{1,255}$`, но не `.` и не `..`); неверное значение бросает
`TypeError`.

### Много моделей сразу

```js
const results = await client.getModels(page.items, { concurrency: 4, lang: 'en' });
for (const result of results) {
  if (result.error) console.error(result.source, result.id, result.error.message);
  else console.log(result.model.title);
}
```

`getModels` держит не больше `concurrency` запросов одновременно (по умолчанию 4) и возвращает по
результату на каждую ссылку **в исходном порядке**. Из-за одной модели он не падает: в каждом
результате либо `model`, либо `error`. После `AuthenticationError`, `PermissionDeniedError` или
`QuotaExceededError` ещё не начатые ссылки получают ту же ошибку без запроса. Каждая модель — один
запрос суточной квоты.

### Аккаунт и лимиты

```js
const me = await client.me(); // { account: { id, displayName, createdAt }, token: { id, name, prefix, createdAt } }
const limits = await client.limits(); // { perMinute: { limit, used, remaining, resetAt }, daily: { … } }
```

Суточную квоту они не тратят (минутный лимит — тратят).

## Метаданные ответа

У каждого результата есть неперечисляемое свойство `meta`: оно не попадает в `JSON.stringify`,
spread, `util.inspect` и сравнение на равенство, так что результаты остаются обычными данными.

```js
const page = await client.search({ q: 'ваза' });
page.meta.requestId; // X-Request-ID — назовите его, обращаясь в поддержку
page.meta.rateLimit; // { limit: 200, remaining: 163, resetAt: 1791590400 } — суточная квота, или null
```

## Ошибки

Неудачный запрос бросает наследника `PolyzonError`:

| Ошибка                  | Когда                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `APIConnectionError`    | сбой сети: DNS, TCP, TLS, прокси, обрыв соединения                                                               |
| `APITimeoutError`       | попытка длилась дольше `timeout` (наследник `APIConnectionError`)                                                |
| `InvalidResponseError`  | ответ 2xx, тело которого не JSON-объект или больше 8 МиБ                                                         |
| `BadRequestError`       | 400: `bad_request` (см. `error.param`) или `page_too_deep`                                                       |
| `AuthenticationError`   | 401: `unauthorized` (нет токена) или `invalid_token` (неверный или отозван)                                      |
| `PermissionDeniedError` | 403 `account_action_required`: примите действующие условия в [polyzon.org/account](https://polyzon.org/account/) |
| `NotFoundError`         | 404 `not_found`                                                                                                  |
| `GoneError`             | 410 `gone`: модель удалена по требованию правообладателя — **удалите её и у себя**                               |
| `RateLimitError`        | 429 `rate_limited`: больше 20 запросов в минуту (повторяется автоматически)                                      |
| `QuotaExceededError`    | 429 `quota_exceeded`: суточная квота исчерпана до 00:00 UTC (наследник `RateLimitError`, не повторяется)         |
| `InternalServerError`   | 5xx: `unavailable`, `internal`, ошибки пограничного узла                                                         |
| `APIError`              | любая другая ошибка HTTP, в том числе неожиданный 3xx (редиректы не выполняются); базовый класс ошибок HTTP выше |

У `APIError` есть `status`, `code` (устойчивый машинный код или `null`), `title`, `detail` (обычно
по-русски), `param`, `requestId`, `retryAfter` (секунды или `null`), `headers` и `body`. Сообщение
выглядит так: `401 invalid_token: Токен не найден или отозван. (request id …)`.

```js
import { GoneError, NotFoundError, QuotaExceededError } from 'polyzon';

try {
  await client.getModel('printables', 'pr-123456');
} catch (error) {
  if (error instanceof GoneError) await db.delete('printables', 'pr-123456');
  else if (error instanceof NotFoundError) console.warn('такой модели нет');
  else if (error instanceof QuotaExceededError)
    console.warn(`квота исчерпана, повтор через ${error.retryAfter} с`);
  else throw error;
}
```

Неверные аргументы бросают стандартные `TypeError` / `RangeError` до запроса. Отменённый запрос
завершается с причиной (`reason`) своего `AbortSignal`.

## Повторы

Неудачный запрос повторяется до `maxRetries` раз (по умолчанию 2) при сбоях соединения, таймаутах,
HTTP 500, 502, 503, 504 и 429 `rate_limited`. Пауза — `Retry-After` сервера, если он есть (не больше
60 секунд: если сервер просит дольше, ошибка бросается сразу), иначе экспоненциальная
`min(8 с, 0,5 с × 2^попытка)` со случайным разбросом. `quota_exceeded` и остальные 4xx не повторяются.

```js
const client = new Polyzon({ maxRetries: 5 }); // или 0, чтобы отключить
await client.search({ q: 'x' }, { maxRetries: 0 }); // для одного запроса
```

## Таймауты и отмена

`timeout` ограничивает каждую попытку (соединение + ответ), в миллисекундах; по умолчанию 30 000.
Попытка, вышедшая за таймаут, закрывает сокет и (после повторов) бросает `APITimeoutError`.

```js
const client = new Polyzon({ timeout: 10_000 });
await client.me({ timeout: 2_000, signal: AbortSignal.timeout(5_000) });
```

Последний аргумент любого метода — `{ signal, timeout, maxRetries }`. Отмена сигнала сразу прерывает
запрос и ожидание повтора.

## Прокси

```js
const client = new Polyzon({ proxy: 'http://user:password@proxy.example.com:3128' });
```

- Поддерживаются прокси `http://` и `https://`; логин и пароль из адреса (в percent-encoding)
  превращаются в `Proxy-Authorization: Basic`. Они никогда не попадают в логи и сообщения об ошибках.
- HTTPS-запросы идут через туннель HTTP `CONNECT` со сквозным TLS до `api.polyzon.org`: прокси не
  видит ваш токен. Соединения через туннель живут в пуле и переиспользуются.
- Без опции `proxy` клиент учитывает `HTTPS_PROXY` / `https_proxy` (а если их нет — `HTTP_PROXY` /
  `http_proxy`) и `NO_PROXY` / `no_proxy` (хосты или суффиксы доменов через запятую, можно с `:порт`,
  или `*`; диапазоны CIDR не поддерживаются). Адреса loopback через прокси из окружения не ходят.
  `proxy: false` отключает прокси из окружения.
- SOCKS: передайте агент, например
  `new Polyzon({ agent: new SocksProxyAgent('socks5://127.0.0.1:1080') })` из
  [`socks-proxy-agent`](https://www.npmjs.com/package/socks-proxy-agent).

## Свой агент и сертификаты

```js
import { readFileSync } from 'node:fs';

// Корпоративный прокси, вскрывающий TLS: доверьте его корневой сертификат (проверка TLS остаётся).
const client = new Polyzon({ ca: readFileSync('corporate-root-ca.pem') });

// Полный контроль (mTLS, SOCKS, тесты): ваш http(s).Agent заменяет пул SDK.
const custom = new Polyzon({ agent: new https.Agent({ keepAlive: true, cert, key }) });
```

Проверку TLS выключить нельзя. `agent` нельзя сочетать с `proxy`, `ca` и `maxConnections`.

## Параллельность

Клиент неизменяем и безопасен при одновременном использовании: создайте один и делитесь им. Запросы
идут через пул из `maxConnections` keep-alive сокетов (по умолчанию 10); лишние параллельные запросы
ждут свободный сокет.

```js
const client = new Polyzon({ maxConnections: 20 });
const [a, b] = await Promise.all([client.search({ q: 'ваза' }), client.search({ q: 'vase' })]);

// Тот же пул, другие настройки — например, клиент на токен каждого пользователя:
const forUser = client.withOptions({ apiKey: userToken, maxRetries: 0 });
```

`withOptions` принимает `apiKey`, `timeout`, `maxRetries`, `userAgent` и `logger`. `client.close()`
закрывает сокеты пула (общего с производными клиентами); вызывать его не обязательно — простаивающие
сокеты не держат процесс.

Node.js асинхронен по природе: каждый метод возвращает промис, а `searchAll` — асинхронный итератор.

## Логи

```js
const client = new Polyzon({ logger: console });
```

В `debug` приходят строки о каждой попытке (метод, путь с запросом, статус, номер попытки, время), в
`warn` — о повторах (причина и пауза). Заголовки и токен в лог не попадают никогда. Подходит любой
объект с методами `debug(message)` и `warn(message)` (pino, winston, …).

## Лимиты и квота

- 20 запросов в минуту на аккаунт, все методы.
- 200 запросов в сутки UTC на аккаунт для `search` и `getModel` (`me` и `limits` бесплатны). Каждая
  страница `searchAll` и каждая модель `getModels` считаются.
- Сервер списывает квоту **до** проверки параметров, так что даже ответ `400` стоит запроса.
- Квоты считаются на аккаунт, а не на токен: несколько токенов их не умножают.

Остаток — в `client.limits()` или `result.meta.rateLimit` (суточное окно после запроса).
`QuotaExceededError.retryAfter` подскажет, когда наступят новые сутки.

## CommonJS

Пакет — только ESM. В Node.js 20.19+ `require()` умеет загружать ES-модули, так что код на CommonJS
тоже работает:

```js
const { Polyzon } = require('polyzon');
```

## User-Agent

Запросы отправляют `User-Agent: polyzon-node/1.0.0 (node 24.20.0; linux/x64)`. Добавьте своё
приложение: `new Polyzon({ userAgent: 'my-bot/2.1' })`.

## Версии

Пакет следует [семантическому версионированию](https://semver.org/lang/ru/). Несовместимые изменения
публичного API (экспортов `polyzon` и их типов TypeScript) выходят только в новой мажорной версии.
См. [CHANGELOG.md](CHANGELOG.md).

## Безопасность

**Никогда не встраивайте токен в браузерный код или мобильные приложения — держите его на сервере.**
Любой, у кого он есть, тратит вашу квоту. Клиент ходит только по HTTPS (обычный `http://` разрешён
лишь для `localhost`), не выполняет редиректы, всегда проверяет TLS и ограничивает тело ответа 8 МиБ.
Об уязвимостях сообщайте, как описано в [SECURITY.md](SECURITY.md).

## Ссылки

- Документация API и песочница: https://api.polyzon.org
- Токены: https://polyzon.org/account/
- Задачи: https://github.com/PolyzonOrg/polyzon-node/issues

## Лицензия

[MIT](LICENSE)
