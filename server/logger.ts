import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from './config';

/**
 * Minimal file + console logger.
 *
 * Replaces `electron-log`, which cannot run outside the Electron shell.
 * Lines are appended to `<dataRoot>/logs/main.log`; the file is rotated once
 * it grows past `MAX_LOG_BYTES` so a long-running server can't fill the disk.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const fileLevel = resolveLevel(process.env['VSL_STAT_LOG_LEVEL'], 'info');
const consoleLevel = resolveLevel(process.env['VSL_STAT_CONSOLE_LEVEL'], 'debug');

let stream: fs.WriteStream | null = null;
let written = 0;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function scopedLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
  };
}

export const logger = scopedLogger('main');

/* ------------------------- internals ------------------------- */

function write(level: Level, scope: string, args: unknown[]): void {
  const message = args.map(format).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;

  if (LEVELS[level] >= LEVELS[consoleLevel]) {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line);
  }
  if (LEVELS[level] >= LEVELS[fileLevel]) {
    appendToFile(line);
  }
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`.trimEnd();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendToFile(line: string): void {
  try {
    const target = logFile();
    if (!stream) {
      written = fs.existsSync(target) ? fs.statSync(target).size : 0;
      stream = fs.createWriteStream(target, { flags: 'a' });
      // A failing log sink must never take the process down with it.
      stream.on('error', () => {
        stream = null;
      });
    }
    if (written > MAX_LOG_BYTES) {
      rotate(target);
    }
    const chunk = `${line}\n`;
    written += Buffer.byteLength(chunk);
    stream?.write(chunk);
  } catch {
    /* logging must never throw */
  }
}

function rotate(target: string): void {
  stream?.end();
  stream = null;
  written = 0;
  try {
    fs.renameSync(target, path.join(path.dirname(target), 'main.old.log'));
  } catch {
    /* if rotation fails, keep appending to the existing file */
  }
  stream = fs.createWriteStream(target, { flags: 'a' });
  stream.on('error', () => {
    stream = null;
  });
}

function logFile(): string {
  return path.join(dataDir('logs'), 'main.log');
}

function resolveLevel(raw: string | undefined, fallback: Level): Level {
  const value = raw?.trim().toLowerCase();
  return value && value in LEVELS ? (value as Level) : fallback;
}
