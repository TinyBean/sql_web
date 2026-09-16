import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionDashboardStore } from "../dashboard/session-store.ts";
import type { AppLogger } from "../logger.ts";

export const DASHBOARD_CONTEXT_MESSAGE_TYPE = "sql_web.dashboard.context";

export function createDashboardContextExtension(
  dashboard: Pick<SessionDashboardStore, "loadOrPreview">,
  logger: Pick<AppLogger, "error">,
): InlineExtension {
  return {
    name: "sql-web-dashboard-context",
    hidden: true,
    factory: (pi) => {
      pi.on("context", (event, context) => {
        const sessionId = context.sessionManager.getSessionId();
        let content: string;
        try {
          content = JSON.stringify({
            type: DASHBOARD_CONTEXT_MESSAGE_TYPE,
            status: "available",
            dashboard: dashboard.loadOrPreview(sessionId),
          });
        } catch (error) {
          logger.error("agent.dashboard.context.failed", error, { sessionId });
          content = JSON.stringify({
            type: DASHBOARD_CONTEXT_MESSAGE_TYPE,
            status: "unavailable",
            message: "当前看板不可用，无法确认当前展示的数据和内容。请明确说明此情况，不要用历史看板内容代替当前看板。",
          });
        }

        // Context events transform only the outgoing request. Do not append this
        // snapshot to session history or initialize artifacts for an empty session.
        return {
          messages: [
            {
              role: "custom",
              customType: DASHBOARD_CONTEXT_MESSAGE_TYPE,
              content,
              display: false,
              timestamp: Date.now(),
            },
            ...event.messages.filter((message) => (
              message.role !== "custom" || message.customType !== DASHBOARD_CONTEXT_MESSAGE_TYPE
            )),
          ],
        };
      });
    },
  };
}
