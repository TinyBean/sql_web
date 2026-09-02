import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogFields = Readonly<Record<string, unknown>>;

export interface AppLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
}

interface LoggerOptions {
  readonly now?: () => Date;
  readonly reportWriteError?: (error: unknown) => void;
}

export interface DailyFileLoggerOptions extends LoggerOptions {
  readonly filenamePrefix?: string;
}

export type FileLoggerOptions = LoggerOptions;

type LogLevel = "INFO" | "WARN" | "ERROR";

function localDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

function jsonLine(value: unknown): string {
  const seen = new WeakSet<object>();
  return `${JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    return item;
  })}\n`;
}

class JsonFileLogger implements AppLogger {
  readonly #resolveFilename: (now: Date) => string;
  readonly #now: () => Date;
  readonly #reportWriteError: (error: unknown) => void;
  #writeErrorReported = false;

  constructor(resolveFilename: (now: Date) => string, options: LoggerOptions = {}) {
    this.#resolveFilename = resolveFilename;
    this.#now = options.now ?? (() => new Date());
    this.#reportWriteError = options.reportWriteError ?? ((error) => {
      console.error("写入应用日志失败", error);
    });
  }

  info(event: string, fields?: LogFields): void {
    this.#write("INFO", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.#write("WARN", event, fields);
  }

  error(event: string, error: unknown, fields?: LogFields): void {
    this.#write("ERROR", event, fields, errorDetails(error));
  }

  #write(
    level: LogLevel,
    event: string,
    fields?: LogFields,
    error?: Readonly<Record<string, unknown>>,
  ): void {
    const now = this.#now();
    const entry = {
      timestamp: now.toISOString(),
      level,
      event,
      pid: process.pid,
      ...(fields ? { fields } : {}),
      ...(error ? { error } : {}),
    };
    const filename = this.#resolveFilename(now);
    try {
      appendFileSync(filename, jsonLine(entry), { encoding: "utf8", mode: 0o640 });
      this.#writeErrorReported = false;
    } catch (writeError) {
      if (!this.#writeErrorReported) {
        this.#writeErrorReported = true;
        this.#reportWriteError(writeError);
      }
    }
  }
}

/** Appends every entry to one fixed JSON Lines file. */
export class FileLogger extends JsonFileLogger {
  readonly #filePath: string;

  constructor(filePath: string, options: FileLoggerOptions = {}) {
    const resolvedFilePath = path.resolve(filePath);
    super(() => resolvedFilePath, options);
    this.#filePath = resolvedFilePath;
    mkdirSync(path.dirname(resolvedFilePath), { recursive: true });
  }

  get filePath(): string {
    return this.#filePath;
  }
}

/** Appends entries to one JSON Lines file per local calendar date. */
export class DailyFileLogger extends JsonFileLogger {
  readonly #logDir: string;
  readonly #filenamePrefix: string;

  constructor(logDir: string, options: DailyFileLoggerOptions = {}) {
    const resolvedLogDir = path.resolve(logDir);
    const filenamePrefix = options.filenamePrefix ?? "sql_web";
    super(
      (now) => path.join(resolvedLogDir, `${filenamePrefix}-${localDate(now)}.log`),
      options,
    );
    this.#logDir = resolvedLogDir;
    this.#filenamePrefix = filenamePrefix;
    mkdirSync(resolvedLogDir, { recursive: true });
  }

  get logDir(): string {
    return this.#logDir;
  }

  get filenamePrefix(): string {
    return this.#filenamePrefix;
  }
}
