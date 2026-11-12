# Развёртывание vsl-statistic

Сервис живёт на общем сервере `38.180.160.192` рядом с craft-lander и spendbridge,
домен — `trueeuphoriaanalytics.online`.

- Свой compose-проект `vsl-statistic` и том `vsl-statistic-data` (SQLite, превью, логи).
- Портов наружу не публикует. TLS и домен обслуживает общий Caddy из отдельного
  проекта `edge` (`~/edge` на сервере, локально `D:/work/cpa/edge`); наш контейнер
  подключён к docker-сети `edge` и виден там как `vsl-statistic:4310`.
- Блок сайта — в `edge/conf/Caddyfile`.

## Первый запуск

1. DNS: A-записи `trueeuphoriaanalytics.online` и `www` → `38.180.160.192`
   (если домен в Cloudflare — серое облако).
2. `.env` на сервере, `~/vsl-statistic/.env`:
   ```
   VSL_STAT_ADMIN_LOGIN=admin
   VSL_STAT_ADMIN_PASSWORD=<openssl rand -base64 18>
   VSL_STAT_SECRET=<openssl rand -base64 32>
   VSL_STAT_PUBLIC_URL=https://trueeuphoriaanalytics.online
   VSL_STAT_INSECURE_COOKIES=0
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   DRIVE_FOLDER_ID=10Yqr7NQl_7voOPyD2m9izWCMHYohrJtN
   ```
   `VSL_STAT_SECRET` шифрует refresh token Google: если его сменить, Drive
   придётся подключать заново. Админ создаётся при старте, только пока в базе
   нет ни одного админа; остальные учётки заводит он на странице «Пользователи».
   Переходный режим: без `VSL_STAT_ADMIN_PASSWORD` первый админ получает старый
   `VSL_STAT_PASSWORD`.
3. В Google Cloud у OAuth-клиента добавить redirect URI
   `https://trueeuphoriaanalytics.online/api/drive/oauth/callback`.
4. `SSH_KEY=~/.ssh/madamcoco_deploy bash deploy/push-source.sh`

## Обновление

```bash
SSH_KEY=~/.ssh/madamcoco_deploy bash deploy/push-source.sh
```

Пакует рабочее дерево, зеркалит его в `~/vsl-statistic`, пересобирает контейнер
и проверяет `https://trueeuphoriaanalytics.online/api/health`. Данные в томе
переживают пересборку.

## Полезное

```bash
cd ~/vsl-statistic
docker compose -f deploy/docker-compose.prod.yml logs -f
docker compose -f deploy/docker-compose.prod.yml exec vsl-statistic sh
```
