import pino from 'pino';

const logLevel = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true';

export function createLogger(name: string): pino.Logger {
  return pino({
    name,
    level: logLevel,
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true },
        }
      : undefined,
  });
}
