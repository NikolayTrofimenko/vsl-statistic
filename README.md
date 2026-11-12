# vsl-statistic

Два инструмента в одном сервисе:

1. **Библиотека видео.** Синхронизирует видео из папки Google Drive: метаданные и превью. Можно смотреть видео прямо в интерфейсе (стрим идёт через сервер) и раскладывать по группам вручную.
2. **Качество видео на лендах.** На ленд ставится трекер в одну строку. Он считает, сколько секунд VSL реально посмотрел каждый посетитель. Дальше в сервисе: кривая удержания, средний просмотр и медиана, доля дошедших до попапа и до конца, заявки, разбивки по устройствам, гео и баерам.

Стек: Angular 20 + Material + Tailwind, Express 5 + TypeScript, SQLite (встроенный `node:sqlite`, нативных модулей нет). Нужен Node ≥ 22.13, в Docker используется Node 24.

## Запуск

```bash
npm install
cp .env.example .env   # заполнить, см. ниже
npm run dev            # Angular на :4200 + сервер на :4310
```

Прод: `npm run build && npm start` или `docker compose up -d --build`. Сервер слушает порт 4310, перед ним нужен TLS-прокси (Caddy или nginx).

## Переменные окружения

| Переменная | Что это |
|---|---|
| `VSL_STAT_ADMIN_LOGIN`, `VSL_STAT_ADMIN_PASSWORD` | Первый админ: создаётся при старте, пока в базе нет ни одного админа. Остальные учётки (баер / тимлид / админ) заводит админ на странице «Пользователи». Без `VSL_STAT_ADMIN_PASSWORD` берётся старый `VSL_STAT_PASSWORD` (переходный режим). |
| `VSL_STAT_SECRET` | Ключ шифрования refresh token Google и подписи сессий. Если не задан, генерируется в `$VSL_STAT_DATA/.secret-key`. |
| `VSL_STAT_DATA` | Папка с базой SQLite, кэшем превью и логами. |
| `VSL_STAT_PUBLIC_URL` | Публичный адрес сервиса. От него строятся redirect URI для Google и ссылка на `t.js`. В dev это `http://127.0.0.1:4200`. |
| `VSL_STAT_INSECURE_COOKIES` | `1`, если сервис открыт по http без TLS (локально). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth-клиент Google, см. ниже. |
| `DRIVE_FOLDER_ID` | Корневая папка библиотеки на Drive. |

## Подключение Google Drive (один раз)

1. В [console.cloud.google.com](https://console.cloud.google.com) создать проект и включить **Google Drive API**.
2. В **OAuth consent screen** выбрать тип External, добавить scope `drive.readonly`, а свой аккаунт внести в Test users. Пока приложение в режиме Testing, Google отзывает refresh token через 7 дней. Чтобы этого не было, приложение нужно перевести в статус «In production»: для своего аккаунта верификация не требуется, Google лишь покажет предупреждение.
3. В **Credentials** создать OAuth client ID типа *Web application*. В Authorized redirect URI указать `<VSL_STAT_PUBLIC_URL>/api/drive/oauth/callback`. Точный адрес показан на странице библиотеки.
4. Прописать `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` в `.env`, перезапустить сервер.
5. На странице «Библиотека видео» нажать «Подключить Google Drive» и войти аккаунтом, у которого есть доступ к папке.

Дальше синхронизация идёт сама каждые 30 минут, плюс есть кнопка ручной синхронизации.

## Трекер на ленде

```html
<script src="https://<stats-host>/t.js" data-land="uroactive-es" defer></script>
```

- Трекер отслеживает все `<video>` на странице. Видео на лендах различаются по URL потока.
- **Учитываются только реально проигранные секунды.** Хранится битовая карта «секунда N просмотрена». При перемотке вперёд пропущенные секунды не засчитываются. Muted-автоплей превью не учитывается, пока не включён звук (`data-count-muted="1"` меняет это поведение).
- Момент попапа берётся из `timerPOPUP` ленда или из `data-popup-at`. На графике он рисуется вертикальной линией.
- Отправка любой формы на странице засчитывается как заявка. Подхватываются `_subid` Keitaro (из cookie или URL), `utm_source`, `utm_campaign` и баер (`buyer` / `sub_id_1` / `sub1`, настраивается через `data-buyer-param`).
- Ленд может отмечать свои события на шкале: `vslStat.mark('form_open')`.
- Каждый beacon несёт полное состояние просмотра, а сервер делает upsert и объединяет битовые карты. Поэтому потеря или повтор beacon'а ничего не ломают. Отправка идёт через `navigator.sendBeacon` в `text/plain`: без CORS-preflight и без потерь при закрытии вкладки.
- Гео определяется по заголовку `CF-IPCountry`, то есть только если сервис стоит за Cloudflare.

## Устройство

```
server/
  index.ts, config.ts, logger.ts, secrets.ts
  db/            SQLite + миграции (PRAGMA user_version)
  drive/         OAuth Google, синхронизация папки, превью
  stats/         collect.ts — приём beacon'ов, report.ts — отчёты, bitmap.ts
  http/          express-приложение, авторизация, Drive-роуты (oauth, thumb, stream)
  api/           RPC-каналы для UI (контракт — src/shared/api.types.ts)
tracker/t.js     скрипт для лендов (отдаётся как /t.js)
src/app/         Angular: pages/library, pages/quality, core/components (графики)
```
