import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogFields = Readonly<Record<string, unknown>>;

export interface AppLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
}

export interface DailyFileLoggerOptions {
  readonly now?: () => Date;
  readonly reportWriteError?: (error: unknown) => void;
}

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

/**
 * Synchronously appends one JSON object per line. The destination filename is
 * resolved for every entry, so a process that spans midnight rolls over without
 * needing a timer or restart.
 */
export class DailyFileLogger implements AppLogger {
  readonly #logDir: string;
  readonly #now: () => Date;
  readonly #reportWriteError: (error: unknown) => void;
  #writeErrorReported = false;

  constructor(logDir: string, options: DailyFileLoggerOptions = {}) {
    this.#logDir = path.resolve(logDir);
    this.#now = options.now ?? (() => new Date());
    this.#reportWriteError = options.reportWriteError ?? ((error) => {
      console.error("写入应用日志失败", error);
    });
    mkdirSync(this.#logDir, { recursive: true });
  }

  get logDir(): string {
    return this.#logDir;
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
    const filename = path.join(this.#logDir, `sql-web-${localDate(now)}.log`);
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
