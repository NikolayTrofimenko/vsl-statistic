# API статистики видео на лендах

Только чтение. Те же цифры, что на странице «Качество на лендах» в https://trueeuphoriaanalytics.online.

## Доступ

Ключ выдаёт админ: «Качество на лендах» → кнопка **API** → «Выдать ключ». Ключ показывается один раз.
Передавай его в заголовке:

```
Authorization: Bearer vsl_…
```

(или `X-Api-Key: vsl_…`). Без ключа или с отозванным — `401`.

Базовый адрес: `https://trueeuphoriaanalytics.online/api/v1`

Все ответы — JSON: `{ "ok": true, "data": … }` или `{ "ok": false, "error": "текст" }`.

## Эндпоинты

### `GET /stats` — все видео на лендах за период

Параметры (все необязательные):

| Параметр | Значение |
|---|---|
| `from`, `to` | даты `YYYY-MM-DD` включительно, по UTC. По умолчанию — последние 7 дней. Период не длиннее 93 дней. |
| `land` | только этот ленд |
| `device` | `mobile` / `desktop` / `tablet` |
| `country` | код страны, `IN`, `MX`… |
| `buyer` | метка баера из ссылки |

Значения для `land`, `device`, `country`, `buyer` — в `GET /facets`.

```bash
curl -H "Authorization: Bearer vsl_…" \
  "https://trueeuphoriaanalytics.online/api/v1/stats?from=2026-10-01&to=2026-10-21"
```

`data`:

- `rows` — по строке на пару «ленд × видео»:

  | Поле | Что это |
  |---|---|
  | `id` | id пары — для `/stats/:id` |
  | `land`, `src` | ленд и адрес видеопотока |
  | `craftName` | название видео из каталога craft-lander (или `null`) |
  | `driveFileName` | файл в библиотеке крео, если привязан |
  | `durationSec`, `popupAtSec` | длина видео и момент попапа, сек |
  | `views` | визиты, где было видео |
  | `plays` | визиты, где видео включили со звуком |
  | `playRate` | `plays / views` (0–1) |
  | `avgWatchSec`, `medianWatchSec` | средний и медианный просмотр, сек (перемотка не считается) |
  | `completionRate` | доля запусков, досмотревших ≥ 90 % |
  | `submits` | отправленные формы (заявки) |
  | `conversion` | `submits / views` |
  | `avgWatchSubmittersSec` | средний просмотр у тех, кто оставил заявку |
  | `errors` | ошибки воспроизведения |
  | `lastSeenAt` | последний визит, мс Unix |

- `byVideo` — те же метрики, сложенные по видео (одно видео на разных лендах): `key` — адрес потока, `label` — название, `memberIds` — `id` строк из `rows`.
- `byLand` — сложенные по ленду: `key` — ленд.

Доли (`playRate`, `completionRate`, `conversion`) — числа от 0 до 1; `null`, если считать не из чего.

### `GET /stats/:id` — одно видео на ленде

Те же параметры периода и фильтров.

`data`:

| Поле | Что это |
|---|---|
| `summary` | строка как в `rows` |
| `retention` | по секундам: `sec`, `viewers`, `share` (доля запусков, досмотревших до этой секунды), `submitShare` (то же среди оставивших заявку) |
| `popupReach` | доля запусков, досмотревших до попапа |
| `histogram`, `bucketSec` | распределение длительности просмотра |
| `byDevice`, `byCountry`, `byBuyer` | разбивки: `key`, `views`, `plays`, `avgWatchSec`, `submits` |
| `daily` | по дням: `day`, `views`, `plays`, `avgWatchSec`, `submits` |

### `GET /facets` — значения фильтров

`{ "lands": […], "devices": […], "countries": […], "buyers": […] }`

## Коды ответов

`200` — ок; `400` — неверные параметры (текст в `error`); `401` — нет ключа или он отозван; `404` — нет такого `id`.
