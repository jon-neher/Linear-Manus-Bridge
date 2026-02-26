import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging configuration using pino.
 * 
 * Environment variables:
 * - LOG_LEVEL: Set log level (trace, debug, info, warn, error, fatal). Default: 'info'
 * - LOG_PRETTY: Set to 'true' for human-readable output in development. Default: 'false' in production
 * - NODE_ENV: Used to determine default pretty printing
 */

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');
const prettyPrint = process.env.LOG_PRETTY === 'true' || (isDevelopment && !process.env.LOG_PRETTY);

const options: LoggerOptions = {
  level: logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

// Use pino-pretty for development-friendly output
const transport = prettyPrint
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

if (transport) {
  options.transport = transport;
}

const rootLogger = pino(options);

/**
 * Create a child logger with a module context.
 * Replaces the [moduleName] prefix pattern with structured context.
 * 
 * @param module - Module name (e.g., 'manusClient', 'linear/webhook')
 * @returns A child logger with the module context
 */
export function createLogger(module: string): Logger {
  return rootLogger.child({ module });
}

/**
 * Root logger for cases where no module context is needed.
 */
export const logger = rootLogger;

export default logger;
