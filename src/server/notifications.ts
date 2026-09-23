import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { emailAddress, MAX_EMAIL_RECIPIENTS, sendEmail, type EmailConfig, type EmailInput, type EmailResult } from "./email.ts";
import type { AppLogger } from "./logger.ts";

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
