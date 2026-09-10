import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogFields = Readonly<Record<string, unknown>>;
export type LogContext = Readonly<Record<string, string | number | boolean>>;

export interface AppLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
  child(context: LogContext): AppLogger;
}

interface LoggerOptions {
  readonly now?: () => Date;
  readonly reportWriteError?: (error: unknown) => void;
}

export interface DailyFileLoggerOptions extends LoggerOptions {
  readonly filenamePrefix?: string;
}

export type FileLoggerOptions = LoggerOptions;

export function reportStartupError(
  error: unknown,
  report: (...data: unknown[]) => void = console.error,
): void {
  report("数据库问答网站启动失败:", error);
}

type LogLevel = "INFO" | "WARN" | "ERROR";
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;

function shanghaiIsoString(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_UTC_OFFSET_MS).toISOString();
  return `${shifted.slice(0, -1)}+08:00`;
}

function shanghaiDate(date: Date): string {
  return shanghaiIsoString(date).slice(0, 10);
}

function errorDetails(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    if (seen.has(error)) return { message: "[Circular error cause]" };
    seen.add(error);
    const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number")
      ? error.code
      : undefined;
    const cause = depth < 4 && "cause" in error && error.cause !== undefined
      ? errorDetails(error.cause, depth + 1, seen)
      : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(cause ? { cause } : {}),
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

function reportInitializationError(options: LoggerOptions, error: unknown): void {
  (options.reportWriteError ?? ((writeError: unknown) => {
    console.error("创建应用日志目录失败", writeError);
  }))(error);
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

  child(context: LogContext): AppLogger {
    return new ChildLogger(this, context);
  }

  writeChild(
    context: LogContext,
    level: LogLevel,
    event: string,
    fields?: LogFields,
    error?: Readonly<Record<string, unknown>>,
  ): void {
    this.#write(level, event, fields, error, context);
  }

  #write(
    level: LogLevel,
    event: string,
    fields?: LogFields,
    error?: Readonly<Record<string, unknown>>,
    context?: LogContext,
  ): void {
    const now = this.#now();
    const entry = {
      timestamp: shanghaiIsoString(now),
      level,
      event,
      pid: process.pid,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
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

class ChildLogger implements AppLogger {
  readonly #root: JsonFileLogger;
  readonly #context: LogContext;

  constructor(root: JsonFileLogger, context: LogContext) {
    this.#root = root;
    this.#context = { ...context };
  }

  info(event: string, fields?: LogFields): void {
    this.#root.writeChild(this.#context, "INFO", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.#root.writeChild(this.#context, "WARN", event, fields);
  }

  error(event: string, error: unknown, fields?: LogFields): void {
    this.#root.writeChild(this.#context, "ERROR", event, fields, errorDetails(error));
  }

  child(context: LogContext): AppLogger {
    return new ChildLogger(this.#root, { ...this.#context, ...context });
  }
}

/** Appends every entry to one fixed JSON Lines file. */
export class FileLogger extends JsonFileLogger {
  readonly #filePath: string;

  constructor(filePath: string, options: FileLoggerOptions = {}) {
    const resolvedFilePath = path.resolve(filePath);
    super(() => resolvedFilePath, options);
    this.#filePath = resolvedFilePath;
    try {
      mkdirSync(path.dirname(resolvedFilePath), { recursive: true });
    } catch (error) {
      reportInitializationError(options, error);
    }
  }

  get filePath(): string {
    return this.#filePath;
  }
}

/** Appends entries to one JSON Lines file per Asia/Shanghai calendar date. */
export class DailyFileLogger extends JsonFileLogger {
  readonly #logDir: string;
  readonly #filenamePrefix: string;

  constructor(logDir: string, options: DailyFileLoggerOptions = {}) {
    const resolvedLogDir = path.resolve(logDir);
    const filenamePrefix = options.filenamePrefix ?? "sql_web";
    super(
      (now) => path.join(resolvedLogDir, `${filenamePrefix}-${shanghaiDate(now)}.log`),
      options,
    );
    this.#logDir = resolvedLogDir;
    this.#filenamePrefix = filenamePrefix;
    try {
      mkdirSync(resolvedLogDir, { recursive: true });
    } catch (error) {
      reportInitializationError(options, error);
    }
  }

  get logDir(): string {
    return this.#logDir;
  }

  get filenamePrefix(): string {
    return this.#filenamePrefix;
  }
}
