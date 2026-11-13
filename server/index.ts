import { registerApiHandlers } from './api';
import { startCapAlerts } from './caps/alerts';
import { startDomainsWarmup } from './domains';
import { startKaitenSync } from './kaiten';
import { startKnowledgeImport } from './knowledge';
import { startAccessSnapshots } from './grants';
import { dataRoot, publicUrl, serverHost, serverPort } from './config';
import { db } from './db';
import { startAutoSync } from './drive/sync';
import { startCraftSync } from './craft/sync';
import { startCreoQueue } from './creo/transcribe';
import { googleConfigured } from './drive/google';
import { createApp } from './http/app';
import { logger } from './logger';
import { ensureAdmin } from './users';
import { syncCreoIds } from './creo/ids';

/**
 * Entry point: the API the UI talks to, the public tracker endpoints the
 * landings talk to, and the Angular bundle.
 */

db();
ensureAdmin();
// Existing creatives get their IDs on the first start after the upgrade.
syncCreoIds();
registerApiHandlers();

const app = createApp();
const port = serverPort();
const host = serverHost();

const server = app.listen(port, host, () => {
  logger.info(`vsl-statistic слушает http://${host}:${port}`);
  logger.info(`Данные: ${dataRoot()} · публичный URL: ${publicUrl()}`);
  if (!googleConfigured()) {
    logger.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET не заданы — библиотека Drive недоступна.');
  }
  startAutoSync();
  startCraftSync();
  startCreoQueue();
  startCapAlerts();
  startDomainsWarmup();
  startKaitenSync();
  startKnowledgeImport();
  startAccessSnapshots();
});

// A video stream through the Drive proxy can legitimately run for an hour.
server.requestTimeout = 0;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} — останавливаюсь.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

process.on('uncaughtException', (err) => logger.error('uncaughtException', err));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection', err));
