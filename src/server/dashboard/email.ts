import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import nodemailer from "nodemailer";
import sanitizeHtml from "sanitize-html";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AppLogger } from "../logger.ts";

export interface EmailConfig {
  readonly host: string;
  readonly port: number;
  readonly fromAddress: string;
  readonly fromName: string;
}

export interface EmailInput {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailResult {
  readonly kind: "email";
  readonly status: "accepted" | "partial" | "failed" | "unknown";
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string | null;
  readonly errorCode: string | null;
  readonly message: string;
}

export const MAX_EMAIL_RECIPIENTS = 50;
export const MAX_EMAIL_BODY_LENGTH = 500_000;
const HEADER_CONTROLS = /[\x00-\x1f\x7f]/u;
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PART = new RegExp(`^(?:${ATOM}(?:\\.${ATOM})*|"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])+")$`, "u");
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;

export function emailAddress(value: string, field: string): string {
  if (typeof value !== "string" || HEADER_CONTROLS.test(value) || /[<>]/u.test(value)) {
    throw new TypeError(`${field} 必须是单个邮箱地址，不能包含显示名称或控制字符`);
  }
  const address = value.trim();
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (at < 1 || address.length > 254 || local.length > 64 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) {
    throw new TypeError(`${field} 不是有效的邮箱地址；含空格的邮箱本地部分必须加双引号`);
  }
  return `${local}@${domain.toLowerCase()}`;
}

export function validateEmailConfig(config: EmailConfig): EmailConfig {
  if (!DOMAIN.test(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new TypeError("SMTP 主机必须是主机名或 IPv4 地址，端口必须为 1 到 65535 的整数");
  }
  if (!config.fromName.trim() || HEADER_CONTROLS.test(config.fromName)) {
    throw new TypeError("邮件发件名称不能为空或包含控制字符");
  }
  return { ...config, fromAddress: emailAddress(config.fromAddress, "邮件发件地址") };
}

function validateEmailInput(input: EmailInput): EmailInput {
  if (Object.keys(input).some((key) => !["to", "subject", "text", "html"].includes(key))) {
    throw new TypeError("邮件工具仅接受 to、subject、text 和 html，不能覆盖发件人或传入附件");
  }
  if (!Array.isArray(input.to) || input.to.length < 1 || input.to.length > MAX_EMAIL_RECIPIENTS) {
    throw new TypeError(`邮件必须包含 1 到 ${MAX_EMAIL_RECIPIENTS} 个收件地址`);
  }
  if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 200 || HEADER_CONTROLS.test(input.subject)) {
    throw new TypeError("邮件主题不能为空、超过 200 字符或包含换行和控制字符");
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_EMAIL_BODY_LENGTH ||
      (input.html !== undefined && (typeof input.html !== "string" || input.html.length > MAX_EMAIL_BODY_LENGTH))) {
    throw new TypeError(`必须提供纯文本正文；每种正文最多 ${MAX_EMAIL_BODY_LENGTH} 字符`);
  }
  const to = [...new Set(input.to.map((address) => emailAddress(address, "收件地址")))];
  return { ...input, to };
}

function cleanHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "div", "span", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "ul", "ol", "li", "blockquote", "pre", "code", "hr", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
    allowedAttributes: { table: ["border", "cellpadding", "cellspacing"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"] },
    // Only application-controlled styles are emitted, never user CSS or URLs.
    transformTags: {
      table: () => ({ tagName: "table", attribs: { border: "1", cellpadding: "6", cellspacing: "0" } }),
    },
    allowedSchemes: [],
  });
}

function errorField(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

function errorString(error: unknown, key: string): string | null {
  const value = errorField(error, key);
  return typeof value === "string" ? value : null;
}

/** Each invocation owns one socket. Closing a non-pooled Nodemailer transport alone does not abort it. */
export async function sendEmail(
  configuration: EmailConfig,
  input: EmailInput,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly connectionTimeoutMs?: number } = {},
): Promise<EmailResult> {
  const config = validateEmailConfig(configuration);
  const validated = validateEmailInput(input);
  const html = validated.html === undefined ? undefined : cleanHtml(validated.html);
  const messageId = `<${randomUUID()}@${config.fromAddress.slice(config.fromAddress.lastIndexOf("@") + 1)}>`;
  const base = { kind: "email" as const, messageId, accepted: [], rejected: [], response: null, errorCode: null };
  if (options.signal?.aborted) {
    return { ...base, status: "failed", errorCode: "ECANCELLED", message: "发送已取消，邮件未提交。" };
  }

  return new Promise<EmailResult>((resolve) => {
    let socket: Socket | undefined;
    let connected = false;
    let finished = false;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const finish = (result: EmailResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(connectionTimer);
      options.signal?.removeEventListener("abort", abort);
      // All socket paths have an error listener before becoming cancellable.
      socket?.destroy();
      transport.close();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      const responseCode = errorField(error, "responseCode");
      // Nodemailer may label a socket failure as CONN even after DATA was sent.
      // Without an explicit rejection, an established connection's outcome is uncertain.
      const definiteFailure = !connected ||
        (typeof responseCode === "number" && responseCode >= 400 && responseCode < 600);
      const rejected = errorField(error, "rejected");
      finish({
        ...base,
        status: definiteFailure ? "failed" : "unknown",
        rejected: Array.isArray(rejected) ? rejected.filter((value): value is string => typeof value === "string") : [],
        response: errorString(error, "response"),
        errorCode: errorString(error, "code") ?? "ESMTP",
        message: definiteFailure
          ? "邮件未被 SMTP 服务器接受，请检查配置或错误后再决定是否重发；工具不会自动重试。"
          : "连接中断、超时或取消，邮件是否已被接收无法确定。请核实收件情况后再决定是否重发，禁止自动重试。",
      });
    };
    const abort = (): void => fail({ code: "ECANCELLED" });
    const timer = setTimeout(() => fail({ code: "ETIMEDOUT" }), timeoutMs);
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false,
      pool: false,
      connectionTimeout: options.connectionTimeoutMs ?? 10_000,
      greetingTimeout: 10_000,
      socketTimeout: timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
      getSocket(_settings, callback) {
        if (finished) {
          callback(new Error("邮件发送已结束"));
          return;
        }
        const connection = createConnection({ host: config.host, port: config.port });
        socket = connection;
        let handedOff = false;
        const cleanup = (): void => {
          handedOff = true;
          clearTimeout(connectionTimer);
          connection.removeListener("error", onError);
          connection.removeListener("close", onClose);
        };
        const onError = (error: Error): void => {
          if (handedOff) return;
          cleanup();
          callback(error);
        };
        const onClose = (): void => onError(new Error("SMTP 连接已关闭"));
        connection.once("error", onError);
        connection.once("close", onClose);
        connectionTimer = setTimeout(() => fail({ code: "ETIMEDOUT", command: "CONN" }), options.connectionTimeoutMs ?? 10_000);
        connection.once("connect", () => {
          if (finished) return;
          cleanup();
          connected = true;
          callback(null, { connection });
        });
      },
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    void transport.sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      envelope: { from: config.fromAddress, to: [...validated.to] },
      to: validated.to.map((address) => ({ address, name: "" })),
      subject: validated.subject,
      text: validated.text,
      ...(html === undefined ? {} : { html }),
      messageId,
      date: new Date(),
      // Stable encoding also permits Chinese content on relays without 8BITMIME.
      textEncoding: "base64",
    }).then((info) => finish({
      ...base,
      status: info.rejected.length > 0 ? "partial" : "accepted",
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response ?? null,
      message: info.rejected.length > 0
        ? "SMTP 仅接受了部分收件人，其他地址被拒绝。实际送达尚未确认；不要向已接受的地址重复发送。"
        : "SMTP 已接受邮件并进入投递流程，实际送达尚未确认。",
    }), fail);
  });
}

const NotificationConfigSchema = Type.Object({
  groups: Type.Record(Type.String(), Type.Array(Type.String())),
  routes: Type.Record(Type.String(), Type.Object({
    enabled: Type.Boolean(), groups: Type.Array(Type.String()), to: Type.Array(Type.String()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export interface NotificationOptions {
  readonly configPath: string;
  /** Validate SMTP only when an enabled route actually needs to send. */
  readonly loadEmail: () => EmailConfig | null;
}

export type NotificationEmail = Omit<EmailInput, "to">;

export type NotificationResult = {
  readonly status: EmailResult["status"] | "skipped";
  readonly reason: string;
  readonly messageId: string | null;
  readonly recipientCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly errorCode: string | null;
};

export interface NotificationContext {
  readonly runId: string;
  readonly throughDate: string;
  readonly logger: Pick<AppLogger, "info" | "warn">;
}

export type NotificationDispatcher = (
  request: { readonly messageType: string; readonly buildEmail: () => NotificationEmail },
  context: NotificationContext,
) => Promise<NotificationResult>;

export function skippedNotification(reason: string): NotificationResult {
  return { status: "skipped", reason, messageId: null, recipientCount: 0, acceptedCount: 0, rejectedCount: 0, errorCode: null };
}

// These messages are application-owned: never log JSON parser errors, addresses or SMTP replies.
class NotificationConfigError extends Error {}

function recipients(filePath: string, messageType: string): readonly string[] | NotificationResult {
  let source: string;
  try { source = readFileSync(filePath, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return skippedNotification("未配置通知文件");
    }
    throw new NotificationConfigError("无法读取通知配置文件");
  }
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new NotificationConfigError("通知配置不是有效的 JSON"); }
  if (!Value.Check(NotificationConfigSchema, value)) throw new NotificationConfigError("通知配置结构无效");
  if (!Object.hasOwn(value.routes, messageType)) return skippedNotification("未配置该信息的发送规则");
  const route = value.routes[messageType]!;
  if (!route.enabled) return skippedNotification("发送规则已关闭");
  const addresses = [...route.to];
  for (const group of route.groups) {
    if (!Object.hasOwn(value.groups, group)) throw new NotificationConfigError("通知规则引用了未知群组");
    addresses.push(...value.groups[group]!);
  }
  let to: string[];
  try { to = [...new Set(addresses.map((address) => emailAddress(address, "通知收件地址")))]; }
  catch { throw new NotificationConfigError("通知规则包含无效收件邮箱"); }
  if (!to.length || to.length > MAX_EMAIL_RECIPIENTS) {
    throw new NotificationConfigError(`通知规则展开去重后必须包含 1 到 ${MAX_EMAIL_RECIPIENTS} 个收件邮箱`);
  }
  return to;
}

const SMTP_REASONS: Record<EmailResult["status"], string> = {
  accepted: "SMTP 已接受全部收件人，实际送达尚未确认",
  partial: "SMTP 仅接受部分收件人，未自动重试；实际送达尚未确认",
  failed: "SMTP 未接受邮件，未自动重试",
  unknown: "邮件是否已被 SMTP 接受无法确定，未自动重试，请核实收件情况",
};

/** Construction is side-effect free; every dispatch reloads routes and attempts delivery at most once. */
export function createNotificationDispatcher(
  options: NotificationOptions, send: typeof sendEmail = sendEmail,
): NotificationDispatcher {
  return async (request, context) => {
    const started = Date.now();
    let stage: "config" | "smtp" | "content" | "send" = "config";
    let result = skippedNotification("未发送");
    try {
      const resolved = recipients(options.configPath, request.messageType);
      if ("status" in resolved) result = resolved;
      else {
        result = { ...result, recipientCount: resolved.length };
        stage = "smtp";
        const email = options.loadEmail();
        if (!email) throw new Error("SMTP unavailable");
        stage = "content";
        const content = request.buildEmail();
        stage = "send";
        const sent = await send(email, { ...content, to: resolved });
        result = {
          status: sent.status, reason: SMTP_REASONS[sent.status], messageId: sent.messageId,
          recipientCount: resolved.length, acceptedCount: sent.accepted.length, rejectedCount: sent.rejected.length,
          errorCode: sent.errorCode && /^[A-Z0-9_]{1,64}$/u.test(sent.errorCode) ? sent.errorCode : null,
        };
      }
    } catch (error) {
      result = {
        ...result, status: stage === "send" ? "unknown" : "failed",
        reason: error instanceof NotificationConfigError ? error.message : {
          config: "通知配置读取或校验失败", smtp: "SMTP 配置缺失或无效",
          content: "通知正文生成失败", send: "邮件发送异常，是否已提交无法确定，未自动重试",
        }[stage],
        errorCode: "ENOTIFICATION_" + stage.toUpperCase(),
      };
    }
    const fields = { ...result, messageType: request.messageType, runId: context.runId,
      throughDate: context.throughDate, durationMs: Date.now() - started };
    if (result.status === "accepted" || result.status === "skipped") context.logger.info("daily.notification.completed", fields);
    else context.logger.warn("daily.notification.completed", fields);
    return result;
  };
}
