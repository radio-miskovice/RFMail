import type { Logger } from '@rfmail/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON lines on stdout, one object per line. */
export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = console.log): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: lvl,
      message,
      ...(meta ?? {}),
    };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}
