import winston from "winston";

export type LogMetadata = Record<string, unknown>;

export interface AppLogger {
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
  child(metadata: LogMetadata): AppLogger;
}

class WinstonAppLogger implements AppLogger {
  constructor(private readonly baseLogger: winston.Logger) {}

  info(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.info(message, metadata);
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.warn(message, metadata);
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.baseLogger.error(message, metadata);
  }

  child(metadata: LogMetadata): AppLogger {
    return new WinstonAppLogger(this.baseLogger.child(metadata));
  }
}

function createBaseLogger(): winston.Logger {
  return winston.createLogger({
    level:
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === "test" ? "silent" : "info"),
    defaultMeta: {
      service: "stellarsettle-api",
    },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
  });
}

export function createLogger(baseLogger: winston.Logger = createBaseLogger()): AppLogger {
  return new WinstonAppLogger(baseLogger);
}

export const logger = createLogger();
