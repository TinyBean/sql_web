import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const DEFAULT_DOMAIN_VERIFY_URL = "http://csj-mp-cimwebsvclb.wdc.com/SanDiskWebService/SandiskTool.asmx/DomainAccountVerify";
const COOKIE_NAME = "datalens_session";
const LOGIN_LIFETIME_MS = 8 * 60 * 60 * 1000;

export class AuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

export function normalizeAccount(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("请输入工号或短账号", 400);
  const account = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(account) || account.includes("__")) {
    throw new AuthError("账号只能包含字母、数字、点、下划线和短横线，请使用工号或短账号", 400);
  }
  return account;
}

/** Parse only the ASMX boolean document grammar; no DTDs, entities or SOAP faults. */
export function parseDomainResult(xml: string): boolean {
  const match = /^\s*(?:<\?xml\s+version=(?<versionQuote>["'])1\.0\k<versionQuote>(?:\s+encoding=(?<encodingQuote>["'])[Uu][Tt][Ff]-8\k<encodingQuote>)?\s*\?>\s*)?<(?<tag>(?:[A-Za-z_][\w.-]*:)?boolean)(?<attrs>(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*>\s*(?<value>true|false|1|0)\s*<\/\k<tag>\s*>\s*$/u.exec(xml);
  if (!match?.groups) throw new AuthError("域验证服务返回无效响应", 503);
  const prefix = match.groups["tag"]!.split(":");
  const namespaceKey = prefix.length === 2 ? `xmlns:${prefix[0]}` : "xmlns";
  const attributes = [...match.groups["attrs"]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gu)];
  const names = attributes.map((item) => item[1]);
  if (new Set(names).size !== names.length || attributes.some((item) => !/^xmlns(?::[\w.-]+)?$/u.test(item[1]!)) ||
      !attributes.some((item) => item[1] === namespaceKey && (item[2] ?? item[3]) === "http://tempuri.org/")) {
    throw new AuthError("域验证服务返回无效响应", 503);
  }
  return match.groups["value"] === "true" || match.groups["value"] === "1";
}

export async function verifyDomainAccount(
  account: string, password: string,
  options: { url?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const response = await fetch(options.url ?? DEFAULT_DOMAIN_VERIFY_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dUserName: account, dPassword: password }),
    });
    if (!response.ok || !response.body) throw new AuthError("域验证服务暂时不可用", 503);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new AuthError("域验证服务返回无效响应", 503);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return parseDomainResult(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // Never propagate upstream errors, URLs or response bodies into request logs.
    throw new AuthError("域验证服务暂时不可用，请稍后重试", 503);
  }
}

interface Login { readonly account: string; readonly expiresAt: number }
interface Attempt { count: number; expiresAt: number }
export interface LoginResult { readonly account: string; readonly expiresAt: string; readonly cookie: string }

export class Authentication {
  readonly #sessions = new Map<string, Login>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #verify: (account: string, password: string) => Promise<boolean>;
  readonly #now: () => number;
  readonly #secure: boolean;

  constructor(options: {
    verify?: (account: string, password: string) => Promise<boolean>;
    now?: () => number;
    secureCookie?: boolean;
  } = {}) {
    this.#verify = options.verify ?? verifyDomainAccount;
    this.#now = options.now ?? Date.now;
    this.#secure = options.secureCookie ?? false;
  }

  #cookie(token: string, maxAge: number): string {
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${this.#secure ? "; Secure" : ""}`;
  }

  #token(request: IncomingMessage): string {
    return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? "";
  }

  #hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

  async login(value: unknown, source: string): Promise<LoginResult> {
    const now = this.#now();
    for (const [key, item] of this.#attempts) if (item.expiresAt <= now) this.#attempts.delete(key);
    for (const [key, item] of this.#sessions) if (item.expiresAt <= now) this.#sessions.delete(key);
    const body = value as { account?: unknown; password?: unknown } | null;
    const account = normalizeAccount(body?.account);
    if (typeof body?.password !== "string" || !body.password || body.password.length > 1024) {
      throw new AuthError("请输入密码", 400);
    }
    const keys = [`ip:${source}`, `account:${account}`];
    if (keys.some((key) => (this.#attempts.get(key)?.count ?? 0) >= (key.startsWith("ip:") ? 60 : 10))) {
      throw new AuthError("登录尝试过于频繁，请 5 分钟后重试", 429);
    }
    for (const key of keys) {
      const attempt = this.#attempts.get(key) ?? { count: 0, expiresAt: now + 5 * 60 * 1000 };
      attempt.count++;
      this.#attempts.set(key, attempt);
    }
    if (!await this.#verify(account, body.password)) throw new AuthError("域账号或密码错误", 401);
    this.#attempts.delete(`account:${account}`);
    const sourceAttempts = this.#attempts.get(`ip:${source}`);
    if (sourceAttempts) sourceAttempts.count = Math.max(0, sourceAttempts.count - 1);
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.#now() + LOGIN_LIFETIME_MS;
    this.#sessions.set(this.#hash(token), { account, expiresAt });
    return { account, expiresAt: new Date(expiresAt).toISOString(), cookie: this.#cookie(token, LOGIN_LIFETIME_MS / 1000) };
  }

  require(request: IncomingMessage): { account: string; expiresAt: string } {
    const key = this.#hash(this.#token(request));
    const login = this.#sessions.get(key);
    if (!login || login.expiresAt <= this.#now()) {
      this.#sessions.delete(key);
      throw new AuthError("请先登录域账号", 401);
    }
    return { account: login.account, expiresAt: new Date(login.expiresAt).toISOString() };
  }

  logout(request: IncomingMessage): string {
    this.#sessions.delete(this.#hash(this.#token(request)));
    return this.#cookie("", 0);
  }

  requireSameOrigin(request: IncomingMessage): void {
    requireSameOrigin(request, this.#secure ? "https:" : "http:");
  }
}

export function requireSameOrigin(request: IncomingMessage, protocol: "http:" | "https:" = "http:"): void {
  const origin = request.headers.origin;
  if (request.headers["sec-fetch-site"] === "cross-site") throw new AuthError("不允许跨站请求", 403);
  if (!origin) return; // Same-origin CLI callers do not send Origin; JSON bodies cannot be posted by HTML forms.
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== protocol || parsed.host !== request.headers.host || parsed.origin !== origin) {
      throw new Error("origin mismatch");
    }
  } catch { throw new AuthError("不允许跨站请求", 403); }
}
