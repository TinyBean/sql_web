import { fork } from "node:child_process";
import type { SchemaObject } from "../../shared/contracts.ts";
import { AppDatabase, DatabaseInputError, type QueryJsonExportOptions, type QueryJsonExportResult,
  type QueryOptions, type QueryResult, type SqlParameter } from "./database.ts";
import type { QueryOperation, QueryRequest } from "./query-worker.ts";

const MAX_RUNNING = 2;
const source = import.meta.url.endsWith(".ts");
const defaultWorker = new URL(source ? "./query-worker.ts" : "./query-worker.js", import.meta.url);

type WorkerReply<T> = { ok: true; value: T } | { ok: false; inputError: boolean; message: string };

function runChild<T>(worker: URL, request: QueryRequest, signal: AbortSignal, fd?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], {
      execArgv: worker.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", fd ?? "ignore", "ipc"],
    });
    let reply: WorkerReply<T> | undefined;
    let failure: Error | undefined;
    const kill = (): void => { child.kill("SIGKILL"); };
    const fail = (error: Error): void => {
      failure ??= error;
      kill();
    };
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", fail);
    child.once("message", (message: WorkerReply<T>) => { reply = message; });
    child.once("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0 || !reply) reject(new Error("SQLite 查询子进程异常退出"));
      else if (reply.ok) resolve(reply.value);
      else reject(reply.inputError ? new DatabaseInputError(reply.message) : new Error(reply.message));
    });
    try {
      child.send(request, (error) => { if (error) fail(error); });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** One scheduler per web service. Each admitted operation owns its SQLite process until close. */
export class QueryExecutor {
  readonly filePath: string;
  readonly #timeoutMs: number;
  readonly #worker: URL;
  readonly #shutdown = new AbortController();
  readonly #waiting = new Set<() => void>();
  readonly #jobs = new Set<Promise<unknown>>();
  #running = 0;

  constructor(filePath: string, timeoutMs: number, worker = defaultWorker) {
    // Preserve the service's startup check before it accepts HTTP requests.
    const database = AppDatabase.open({ filePath });
    this.filePath = database.filePath;
    database.close();
    this.#timeoutMs = timeoutMs;
    this.#worker = worker;
  }

  query(sql: string, parameters: readonly SqlParameter[] = [], options: QueryOptions = {}, signal?: AbortSignal) {
    return this.#submit<QueryResult>({ kind: "query", sql, parameters, options }, signal);
  }

  exportQueryJson(sql: string, parameters: readonly SqlParameter[] = [], options: QueryJsonExportOptions) {
    const { signal, fileDescriptor, ...limits } = options;
    return this.#submit<QueryJsonExportResult>({ kind: "export", sql, parameters, options: limits }, signal, fileDescriptor);
  }

  getSchema(signal?: AbortSignal) {
    return this.#submit<SchemaObject[]>({ kind: "schema" }, signal);
  }

  async close(): Promise<void> {
    this.#shutdown.abort(new Error("查询服务正在关闭"));
    await Promise.allSettled(this.#jobs);
  }

  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#running < MAX_RUNNING) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const admit = (): void => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = (): void => {
        this.#waiting.delete(admit);
        reject(signal.reason);
      };
      this.#waiting.add(admit);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  #release(): void {
    const next = this.#waiting.values().next().value;
    if (next) {
      this.#waiting.delete(next);
      next();
    } else {
      this.#running--;
    }
  }

  #submit<T>(operation: QueryOperation, signal?: AbortSignal, fd?: number): Promise<T> {
    const job = this.#execute<T>(operation, signal, fd);
    this.#jobs.add(job);
    return job.finally(() => this.#jobs.delete(job));
  }

  async #execute<T>(operation: QueryOperation, caller?: AbortSignal, fd?: number): Promise<T> {
    const timeout = new AbortController();
    const expire = (): void => timeout.abort(new Error(`SQLite 查询超时（${this.#timeoutMs} 毫秒），请缩小日期范围或增加筛选条件`));
    const deadline = performance.now() + this.#timeoutMs;
    const timer = setTimeout(expire, this.#timeoutMs);
    const signal = AbortSignal.any([this.#shutdown.signal, timeout.signal, ...(caller ? [caller] : [])]);
    const checkDeadline = (): void => {
      if (performance.now() >= deadline) expire();
      signal.throwIfAborted();
    };
    try {
      await this.#acquire(signal);
      try {
        checkDeadline();
        const result = await runChild<T>(this.#worker, { filePath: this.filePath, operation }, signal, fd);
        checkDeadline();
        return result;
      } finally {
        this.#release();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
