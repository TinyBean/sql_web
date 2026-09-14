import type {
  ChatImage,
  ChatMessage,
  ChatRole,
  ChatTraceItem,
  DashboardEditRequest,
  JsonObject,
  MessageRequest,
  ParsedSseEvent,
  SerializedSession,
  SessionSummary,
} from "../shared/contracts.ts";
import type { DashboardState } from "../shared/dashboard.ts";
import {
  decodeAbortResponse,
  decodeDashboardEditResponse,
  decodeDeleteSessionResponse,
  decodeSerializedSession,
  decodeSessionsResponse,
  decodeSseEvent,
  errorMessageFromResponse,
  parseJson,
  type Decoder,
} from "./api-contracts.ts";
import {
  createStreamPresentation,
  formatToolArguments,
  formatToolStatusText,
  initialSessionTarget,
  latestAssistantAfterLastUser,
  reduceStreamPresentation,
  SessionStreamRegistry,
  settleStreamPresentation,
  type StreamPresentation,
  type StreamToolStatus,
} from "./stream-state.ts";
import { hideTrailingIncompleteGeneratedImageMarkdown } from "./image-placeholders.ts";
import {
  renderMarkdownInto,
  type MarkdownRenderOptions,
} from "./markdown.ts";
import { DashboardRenderer } from "./dashboard.ts";
import {
  dashboardDropTarget,
  type DashboardDragPoint,
  type DashboardOrderMove,
} from "./dashboard-drag.ts";

interface ElementConstructor<ElementType extends Element> {
  readonly prototype: ElementType;
  new(): ElementType;
}

function requiredElement<ElementType extends Element>(
  selector: string,
  constructor: ElementConstructor<ElementType>,
): ElementType {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new Error(`页面元素 ${selector} 不存在或类型错误`);
  }
  return element;
}

const elements = {
  dashboardGrid: requiredElement("#dashboardGrid", HTMLElement),
  dashboardDateRange: requiredElement("#dashboardDateRange", HTMLElement),
  dashboardUpdatedAt: requiredElement("#dashboardUpdatedAt", HTMLElement),
  dashboardEditButton: requiredElement("#dashboardEditButton", HTMLButtonElement),
  chatDock: requiredElement("#chatDock", HTMLElement),
  chatTitle: requiredElement("#chatTitle", HTMLElement),
  chatCollapseButton: requiredElement("#chatCollapseButton", HTMLButtonElement),
  historyButton: requiredElement("#historyButton", HTMLButtonElement),
  historyPanel: requiredElement("#historyPanel", HTMLElement),
  historyCloseButton: requiredElement("#historyCloseButton", HTMLButtonElement),
  newChatButton: requiredElement("#newChatButton", HTMLButtonElement),
  sessionList: requiredElement("#sessionList", HTMLElement),
  messages: requiredElement("#messages", HTMLElement),
  welcome: requiredElement("#welcome", HTMLElement),
  composer: requiredElement("#composer", HTMLFormElement),
  composerStatus: requiredElement("#composerStatus", HTMLElement),
  input: requiredElement("#questionInput", HTMLTextAreaElement),
  sendButton: requiredElement("#sendButton", HTMLButtonElement),
  toast: requiredElement("#toast", HTMLElement),
};

interface StreamNode {
  article: HTMLElement;
  body: HTMLDivElement;
  text: HTMLDivElement;
  thoughts: HTMLDetailsElement;
  thoughtSummary: HTMLElement;
  thoughtItems: HTMLDivElement;
  expandedToolIds: Set<string>;
  presentation: StreamPresentation | null;
}

interface ClientState {
  sessionId: string | null;
  sessions: readonly SessionSummary[];
  activeStreams: SessionStreamRegistry<ActiveStream>;
  scrollPositions: Map<string, number>;
  dashboards: Map<string, DashboardState>;
  dashboardEditing: boolean;
  dashboardSaving: boolean;
  dashboardSavePromise: Promise<DashboardState> | null;
  dashboardEditDraft: DashboardEditDraft | null;
  pendingDashboardRemoval: PendingDashboardRemoval | null;
  deletingSessionId: string | null;
  toastTimer: number | null;
}

interface PendingDashboardRemoval {
  readonly sessionId: string;
  readonly widgetId: string;
  readonly widgetTitle: string;
  readonly orderIndex: number;
  readonly timerId: number;
}

interface DashboardEditDraft {
  readonly sessionId: string;
  readonly originalWidgetIds: readonly string[];
  readonly removedWidgetIds: Set<string>;
  widgetIds: string[];
}

interface ActiveStream {
  readonly sessionId: string;
  readonly transcript: HTMLElement;
  readonly node: StreamNode;
  dashboard: DashboardState;
  readonly pendingDashboardWidgetIds: Set<string>;
  readonly pendingDashboardToolIds: Map<string, readonly string[]>;
  aborting: boolean;
}

const state: ClientState = {
  sessionId: null,
  sessions: [],
  activeStreams: new SessionStreamRegistry<ActiveStream>(),
  scrollPositions: new Map<string, number>(),
  dashboards: new Map<string, DashboardState>(),
  dashboardEditing: false,
  dashboardSaving: false,
  dashboardSavePromise: null,
  dashboardEditDraft: null,
  pendingDashboardRemoval: null,
  deletingSessionId: null,
  toastTimer: null,
};

const dashboardRenderer = new DashboardRenderer(elements.dashboardGrid);

function createSvg(paths: readonly Readonly<Record<string, string>>[]): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const attributes of paths) {
    const path = document.createElementNS(namespace, "path");
    for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}

function showToast(
  message: string,
  action?: { readonly label: string; readonly run: () => void },
  duration = 4_500,
): void {
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  const copy = document.createElement("span");
  copy.textContent = message;
  elements.toast.replaceChildren(copy);
  elements.toast.classList.toggle("actionable", Boolean(action));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (state.toastTimer !== null) clearTimeout(state.toastTimer);
      state.toastTimer = null;
      elements.toast.classList.remove("visible");
      action.run();
    }, { once: true });
    elements.toast.append(button);
  }
  elements.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
    state.toastTimer = null;
  }, duration);
}

function messageFromUnknown(error: unknown, fallback = "请求失败"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseJson(text, `$response(${response.status})`);
}

async function api<ResponseBody>(
  path: string,
  decode: Decoder<ResponseBody>,
  options: RequestInit = {},
): Promise<ResponseBody> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(payload) ?? `请求失败 (${response.status})`);
  }
  return decode(payload, `$response(${response.status})`);
}

function setChatOpen(open: boolean, focus = false): void {
  elements.chatDock.classList.toggle("open", open);
  if (open && focus) window.setTimeout(() => elements.input.focus(), 0);
}

function toggleHistory(force?: boolean): void {
  const open = force ?? !elements.historyPanel.classList.contains("open");
  elements.historyPanel.classList.toggle("open", open);
  elements.historyButton.setAttribute("aria-expanded", String(open));
}

function formatDashboardDateRange(dashboard: DashboardState): string {
  const { start, end } = dashboard.dateRange;
  return start && end ? `${start} — ${end}` : "数据范围不可用";
}

function formatDataAsOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? `快照 ${value}`
    : `快照 ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

function hiddenWidgetIdsForCurrentSession(): ReadonlySet<string> {
  const draft = state.dashboardEditDraft;
  return draft && draft.sessionId === state.sessionId
    ? draft.removedWidgetIds
    : new Set();
}

function dashboardViewForCurrentSession(dashboard: DashboardState): DashboardState {
  const draft = state.dashboardEditDraft;
  if (!draft || draft.sessionId !== state.sessionId) return dashboard;
  const widgetsById = new Map(dashboard.widgets.map((widget) => [widget.id, widget]));
  const orderedIds = [
    ...draft.widgetIds,
    ...dashboard.widgets.map((widget) => widget.id).filter((id) => !draft.widgetIds.includes(id)),
  ];
  return {
    ...dashboard,
    widgets: orderedIds.flatMap((id) => {
      const widget = widgetsById.get(id);
      return widget ? [widget] : [];
    }),
  };
}

function renderDashboard(dashboard: DashboardState, pending: ReadonlySet<string> = new Set()): void {
  dashboardRenderer.render(dashboardViewForCurrentSession(dashboard), {
    pendingWidgetIds: pending,
    hiddenWidgetIds: hiddenWidgetIdsForCurrentSession(),
  });
  elements.dashboardDateRange.textContent = formatDashboardDateRange(dashboard);
  elements.dashboardUpdatedAt.textContent = `${formatDataAsOf(dashboard.dataAsOf)} · r${dashboard.revision}`;
  syncDashboardEditorState();
}

function cacheDashboard(sessionId: string, dashboard: DashboardState): boolean {
  const current = state.dashboards.get(sessionId);
  if (current && current.revision > dashboard.revision) return false;
  state.dashboards.set(sessionId, dashboard);
  return true;
}

function pendingWidgetIdsForCurrentSession(): ReadonlySet<string> {
  return selectedActiveStream()?.pendingDashboardWidgetIds ?? new Set();
}

function renderCurrentDashboard(): void {
  if (!state.sessionId) {
    syncDashboardEditorState();
    return;
  }
  const dashboard = state.dashboards.get(state.sessionId);
  if (dashboard) renderDashboard(dashboard, pendingWidgetIdsForCurrentSession());
}

async function reloadDashboardAfterEditFailure(sessionId: string): Promise<void> {
  const session = await api(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    decodeSerializedSession,
  );
  state.dashboards.set(sessionId, session.dashboard);
  const activeStream = state.activeStreams.get(sessionId);
  if (activeStream) activeStream.dashboard = session.dashboard;
  if (state.sessionId === sessionId) renderCurrentDashboard();
}

async function saveDashboardEdit(
  sessionId: string,
  buildRequest: (dashboard: DashboardState) => DashboardEditRequest,
): Promise<DashboardState> {
  if (state.dashboardSavePromise) {
    try {
      await state.dashboardSavePromise;
    } catch {
      // The preceding operation already refreshed and reported its failure.
    }
  }
  const current = state.dashboards.get(sessionId);
  if (!current) throw new Error("当前会话看板尚未加载");
  const request = buildRequest(current);
  state.dashboardSaving = true;
  syncDashboardEditorState();
  const operation = api(
    `/api/sessions/${encodeURIComponent(sessionId)}/dashboard`,
    decodeDashboardEditResponse,
    {
      method: "PATCH",
      body: JSON.stringify(request),
    },
  ).then((response) => response.dashboard);
  state.dashboardSavePromise = operation;
  try {
    const dashboard = await operation;
    cacheDashboard(sessionId, dashboard);
    const activeStream = state.activeStreams.get(sessionId);
    if (activeStream) activeStream.dashboard = dashboard;
    if (state.sessionId === sessionId) renderCurrentDashboard();
    return dashboard;
  } catch (error) {
    try {
      await reloadDashboardAfterEditFailure(sessionId);
    } catch {
      // Keep the original mutation error because it is the actionable failure.
    }
    showToast(messageFromUnknown(error, "看板保存失败，已恢复服务端版本"));
    throw error;
  } finally {
    if (state.dashboardSavePromise === operation) state.dashboardSavePromise = null;
    state.dashboardSaving = false;
    syncDashboardEditorState();
  }
}

function undoPendingDashboardRemoval(): void {
  const pending = state.pendingDashboardRemoval;
  if (!pending || state.dashboardSaving) return;
  clearTimeout(pending.timerId);
  const draft = state.dashboardEditDraft;
  if (draft?.sessionId === pending.sessionId && draft.removedWidgetIds.delete(pending.widgetId)) {
    draft.widgetIds.splice(Math.min(pending.orderIndex, draft.widgetIds.length), 0, pending.widgetId);
  }
  state.pendingDashboardRemoval = null;
  if (state.sessionId === pending.sessionId) renderCurrentDashboard();
  showToast(`已恢复“${pending.widgetTitle}”`);
}

function finalizePendingDashboardRemoval(): void {
  const pending = state.pendingDashboardRemoval;
  if (!pending) return;
  clearTimeout(pending.timerId);
  state.pendingDashboardRemoval = null;
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = null;
  elements.toast.classList.remove("visible", "actionable");
}

async function scheduleDashboardRemoval(widgetId: string): Promise<void> {
  if (!state.dashboardEditing || state.dashboardSaving || !state.sessionId) return;
  finalizePendingDashboardRemoval();
  const dashboard = state.dashboards.get(state.sessionId);
  const widget = dashboard?.widgets.find((candidate) => candidate.id === widgetId);
  const draft = dashboard ? ensureDashboardEditDraft(state.sessionId, dashboard) : null;
  const orderIndex = draft?.widgetIds.indexOf(widgetId) ?? -1;
  if (!widget || !draft || orderIndex < 0) return;
  const sessionId = state.sessionId;
  draft.widgetIds.splice(orderIndex, 1);
  draft.removedWidgetIds.add(widgetId);
  let pending: PendingDashboardRemoval;
  const timerId = window.setTimeout(() => {
    if (state.pendingDashboardRemoval === pending) state.pendingDashboardRemoval = null;
  }, 5_000);
  pending = {
    sessionId,
    widgetId,
    widgetTitle: widget.title,
    orderIndex,
    timerId,
  };
  state.pendingDashboardRemoval = pending;
  renderCurrentDashboard();
  showToast(
    `已关闭“${widget.title}”`,
    { label: "撤销", run: undoPendingDashboardRemoval },
    5_000,
  );
}

function ensureDashboardEditDraft(
  sessionId: string,
  dashboard: DashboardState,
): DashboardEditDraft {
  const current = state.dashboardEditDraft;
  if (current?.sessionId === sessionId) return current;
  const widgetIds = dashboard.widgets.map((widget) => widget.id);
  const draft: DashboardEditDraft = {
    sessionId,
    originalWidgetIds: widgetIds,
    removedWidgetIds: new Set(),
    widgetIds: [...widgetIds],
  };
  state.dashboardEditDraft = draft;
  return draft;
}

async function persistDashboardEditDraft(draft: DashboardEditDraft): Promise<void> {
  for (const widgetId of draft.removedWidgetIds) {
    const dashboard = state.dashboards.get(draft.sessionId);
    if (!dashboard?.widgets.some((widget) => widget.id === widgetId)) continue;
    await saveDashboardEdit(draft.sessionId, (latest) => ({
      action: "remove",
      baseRevision: latest.revision,
      widgetId,
    }));
  }
  const dashboard = state.dashboards.get(draft.sessionId);
  if (!dashboard) throw new Error("当前会话看板尚未加载");
  const remainingIds = new Set(dashboard.widgets.map((widget) => widget.id));
  const widgetIds = draft.widgetIds.filter((id) => remainingIds.has(id));
  const currentIds = dashboard.widgets.map((widget) => widget.id);
  if (currentIds.every((id, index) => id === widgetIds[index])) return;
  await saveDashboardEdit(draft.sessionId, (latest) => ({
    action: "reorder",
    baseRevision: latest.revision,
    widgetIds,
  }));
}

async function finishDashboardEditing(): Promise<void> {
  cancelDashboardPointerDrag();
  finalizePendingDashboardRemoval();
  const draft = state.dashboardEditDraft;
  const changed = Boolean(draft && (
    draft.removedWidgetIds.size > 0 ||
    draft.originalWidgetIds.length !== draft.widgetIds.length ||
    draft.originalWidgetIds.some((id, index) => id !== draft.widgetIds[index])
  ));
  let failed = false;
  if (draft) {
    try {
      await persistDashboardEditDraft(draft);
    } catch {
      failed = true;
      // saveDashboardEdit already restored and reported the authoritative version.
    }
  }
  if (state.dashboardEditDraft === draft) state.dashboardEditDraft = null;
  state.dashboardEditing = false;
  syncDashboardEditorState();
  if (failed && state.sessionId === draft?.sessionId) renderCurrentDashboard();
  else if (changed) showToast("看板已保存");
}


function renderSessions(): void {
  elements.sessionList.replaceChildren();
  const visibleSessions = state.sessions.filter((session) => (
    session.messageCount > 0 || state.activeStreams.has(session.id)
  ));
  if (!visibleSessions.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "session-placeholder";
    placeholder.textContent = "还没有会话";
    elements.sessionList.append(placeholder);
    return;
  }

  for (const session of visibleSessions) {
    const streaming = state.activeStreams.has(session.id);
    const row = document.createElement("div");
    row.className = "session-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "session-item",
      session.id === state.sessionId ? "active" : "",
      streaming ? "streaming" : "",
    ].filter(Boolean).join(" ");
    button.dataset["sessionId"] = session.id;
    const title = session.title || "新会话";
    button.setAttribute("aria-label", streaming ? `${title}，正在回答` : title);
    const titleElement = document.createElement("span");
    titleElement.className = "session-title";
    titleElement.textContent = title;
    button.append(
      createSvg([{ d: "M7 17.5 4 20v-4.5a8 8 0 1 1 3 2Z" }]),
      titleElement,
    );
    if (streaming) {
      const status = document.createElement("span");
      status.className = "session-streaming-indicator";
      status.title = "正在回答";
      status.setAttribute("aria-hidden", "true");
      button.append(status);
    }
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.dataset["deleteSessionId"] = session.id;
    deleteButton.title = `删除会话:${session.title || "新会话"}`;
    deleteButton.setAttribute("aria-label", deleteButton.title);
    deleteButton.disabled = state.deletingSessionId === session.id || streaming;
    deleteButton.append(createSvg([
      { d: "M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" },
      { d: "M10 11v5M14 11v5" },
    ]));
    row.append(button, deleteButton);
    elements.sessionList.append(row);
  }
}

function ensureMessageStream(): HTMLElement {
  const existing = elements.messages.querySelector(".message-stream");
  if (existing && !(existing instanceof HTMLElement)) {
    throw new Error("消息列表元素类型错误");
  }
  let stream = existing;
  if (!stream) {
    elements.welcome.remove();
    stream = document.createElement("div");
    stream.className = "message-stream";
    elements.messages.append(stream);
  }
  return stream;
}

let toolArgumentsPanelSequence = 0;

function createToolEntry(
  name: string,
  arguments_: JsonObject,
  status: StreamToolStatus,
  expanded: boolean,
  onToggle: (expanded: boolean) => void,
): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = "tool-entry";
  const chip = document.createElement("span");
  chip.className = `tool-chip ${status}`;
  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name;
  const separator = document.createElement("span");
  separator.className = "tool-separator";
  separator.textContent = "·";
  const toolStatus = document.createElement("span");
  toolStatus.className = "tool-status";
  toolStatus.textContent = formatToolStatusText(name, status);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tool-arguments-toggle";
  toggle.textContent = "参数";
  toggle.setAttribute("aria-label", `${expanded ? "隐藏" : "展开"} ${name} 执行参数`);
  toggle.setAttribute("aria-expanded", String(expanded));
  const panel = document.createElement("pre");
  panel.className = "tool-arguments";
  panel.id = `tool-arguments-${++toolArgumentsPanelSequence}`;
  panel.hidden = !expanded;
  panel.textContent = formatToolArguments(arguments_);
  toggle.setAttribute("aria-controls", panel.id);
  toggle.addEventListener("click", () => {
    const nextExpanded = panel.hidden !== false;
    const currentName = toolName.textContent || name;
    panel.hidden = !nextExpanded;
    toggle.setAttribute("aria-expanded", String(nextExpanded));
    toggle.setAttribute("aria-label", `${nextExpanded ? "隐藏" : "展开"} ${currentName} 执行参数`);
    onToggle(nextExpanded);
  });
  chip.append(toolName, separator, toolStatus, toggle);
  entry.append(chip, panel);
  return entry;
}

function createTraceText(): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "thought-text markdown-content";
  return item;
}

function createTypingIndicator(): HTMLDivElement {
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span"),
  );
  return typing;
}

function createCompactionStatus(): HTMLDivElement {
  const status = document.createElement("div");
  status.className = "compaction-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const typing = createTypingIndicator();
  typing.setAttribute("aria-hidden", "true");
  status.append(
    Object.assign(document.createElement("span"), {
      className: "compaction-status-label",
      textContent: "正在自动压缩上下文…",
    }),
    typing,
  );
  return status;
}

const STREAM_THOUGHT_KEY_ATTRIBUTE = "data-stream-key";

function thoughtChildrenByKey(container: HTMLElement): ReadonlyMap<string, HTMLElement> {
  const children = new Map<string, HTMLElement>();
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue;
    const key = child.getAttribute(STREAM_THOUGHT_KEY_ATTRIBUTE) ?? "";
    if (key && !children.has(key)) children.set(key, child);
  }
  return children;
}

function keyedTraceText(
  existing: HTMLElement | undefined,
  key: string,
  text: string,
  images: readonly ChatImage[] = [],
  options: MarkdownRenderOptions = {},
): HTMLDivElement {
  const item = existing instanceof HTMLDivElement && existing.classList.contains("thought-text")
    ? existing
    : createTraceText();
  item.setAttribute(STREAM_THOUGHT_KEY_ATTRIBUTE, key);
  renderMarkdownInto(item, text, images, options);
  return item;
}

function updateToolEntry(
  entry: HTMLDivElement,
  name: string,
  arguments_: JsonObject,
  status: StreamToolStatus,
  expanded: boolean,
): boolean {
  const chip = entry.querySelector<HTMLElement>(".tool-chip");
  const toolName = entry.querySelector<HTMLElement>(".tool-name");
  const toolStatus = entry.querySelector<HTMLElement>(".tool-status");
  const toggle = entry.querySelector<HTMLButtonElement>(".tool-arguments-toggle");
  const panel = entry.querySelector<HTMLElement>(".tool-arguments");
  if (!chip || !toolName || !toolStatus || !toggle || !panel) return false;
  chip.className = `tool-chip ${status}`;
  toolName.textContent = name;
  toolStatus.textContent = formatToolStatusText(name, status);
  toggle.setAttribute("aria-label", `${expanded ? "隐藏" : "展开"} ${name} 执行参数`);
  toggle.setAttribute("aria-expanded", String(expanded));
  panel.hidden = !expanded;
  panel.textContent = formatToolArguments(arguments_);
  return true;
}

function keyedToolEntry(
  node: StreamNode,
  existing: HTMLElement | undefined,
  key: string,
  id: string,
  name: string,
  arguments_: JsonObject,
  status: StreamToolStatus,
): HTMLDivElement {
  const expanded = node.expandedToolIds.has(id);
  let entry = existing instanceof HTMLDivElement && existing.classList.contains("tool-entry")
    ? existing
    : createToolEntry(
        name,
        arguments_,
        status,
        expanded,
        (nextExpanded) => {
          if (nextExpanded) node.expandedToolIds.add(id);
          else node.expandedToolIds.delete(id);
        },
      );
  if (!updateToolEntry(entry, name, arguments_, status, expanded)) {
    entry = createToolEntry(
      name,
      arguments_,
      status,
      expanded,
      (nextExpanded) => {
        if (nextExpanded) node.expandedToolIds.add(id);
        else node.expandedToolIds.delete(id);
      },
    );
  }
  entry.setAttribute(STREAM_THOUGHT_KEY_ATTRIBUTE, key);
  return entry;
}

function keyedStatus(
  existing: HTMLElement | undefined,
  key: string,
  className: string,
  create: () => HTMLElement,
): HTMLElement {
  const status = existing?.classList.contains(className) ? existing : create();
  status.setAttribute(STREAM_THOUGHT_KEY_ATTRIBUTE, key);
  return status;
}

function renderHistoricalTrace(
  node: StreamNode,
  trace: readonly ChatTraceItem[],
  images: readonly ChatImage[],
): void {
  const claimedGeneratedImageIds = new Set<string>();
  const children = trace.map((item, index) => (
    item.type === "text"
      ? keyedTraceText(
          undefined,
          `trace:${index}`,
          item.text,
          images,
          {
            claimedGeneratedImageIds,
          },
        )
      : keyedToolEntry(
          node,
          undefined,
          `tool:${item.id}`,
          item.id,
          item.name,
          item.arguments,
          item.isError ? "error" : "done",
        )
  ));
  node.thoughtItems.replaceChildren(...children);
  node.thoughtSummary.textContent = "思考过程";
  node.thoughts.hidden = trace.length === 0;
  node.thoughts.open = false;
}

function renderStreamPresentation(
  node: StreamNode,
  previous: StreamPresentation | null,
): void {
  const presentation = node.presentation;
  if (!presentation) return;
  const showFinalBody = presentation.finalized;
  if (showFinalBody) {
    renderMarkdownInto(
      node.text,
      presentation.finalText,
      presentation.images,
    );
  }

  const existing = thoughtChildrenByKey(node.thoughtItems);
  const claimedGeneratedImageIds = new Set<string>();
  const children: HTMLElement[] = presentation.items.map((item, index) => (
    item.type === "text"
      ? keyedTraceText(
          existing.get(`trace:${index}`),
          `trace:${index}`,
          item.text,
          presentation.images,
          {
            claimedGeneratedImageIds,
          },
        )
      : keyedToolEntry(
          node,
          existing.get(`tool:${item.id}`),
          `tool:${item.id}`,
          item.id,
          item.name,
          item.arguments,
          item.status,
        )
  ));
  const trailingText = presentation.currentTurnText;
  if (trailingText) {
    const source = presentation.activeTurn !== null && !presentation.settled
      ? hideTrailingIncompleteGeneratedImageMarkdown(trailingText)
      : trailingText;
    const key = `trace:${presentation.items.length}`;
    children.push(keyedTraceText(
      existing.get(key),
      key,
      source,
      presentation.images,
      {
        claimedGeneratedImageIds,
      },
    ));
  }
  if (presentation.compactingReason !== null) {
    children.push(keyedStatus(
      existing.get("status:compaction"),
      "status:compaction",
      "compaction-status",
      createCompactionStatus,
    ));
  } else if (presentation.waiting) {
    const typing = keyedStatus(
      existing.get("status:waiting"),
      "status:waiting",
      "typing",
      createTypingIndicator,
    );
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-label", "正在思考");
    children.push(typing);
  }
  node.thoughtItems.replaceChildren(...children);
  if (!showFinalBody) node.text.replaceChildren();
  node.thoughts.hidden = children.length === 0;
  if (showFinalBody) {
    node.thoughtSummary.textContent = "思考过程";
    if (!previous?.finalized) node.thoughts.open = false;
  } else if (presentation.failed || presentation.settled) {
    node.thoughtSummary.textContent = "思考过程";
    node.thoughts.open = true;
  } else {
    node.thoughtSummary.textContent = "思考中";
    node.thoughts.open = true;
  }
}

function appendMessage(
  role: ChatRole,
  text = "",
  streaming = false,
  trace: readonly ChatTraceItem[] = [],
  images: readonly ChatImage[] = [],
  scrollToBottom = true,
): StreamNode {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.append(
    role === "assistant"
      ? createSvg([
          { d: "M6 7c0-1.7 2.7-3 6-3s6 1.3 6 3-2.7 3-6 3-6-1.3-6-3Z" },
          { d: "M6 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" },
        ])
      : createSvg([{ d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21a7 7 0 0 1 14 0" }]),
  );
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "DataLens";
  const thoughts = document.createElement("details");
  thoughts.className = "thoughts";
  thoughts.hidden = true;
  const thoughtSummary = document.createElement("summary");
  thoughtSummary.textContent = "思考过程";
  const thoughtItems = document.createElement("div");
  thoughtItems.className = "thought-items";
  thoughts.append(thoughtSummary, thoughtItems);
  const messageText = document.createElement("div");
  messageText.className = role === "assistant" ? "message-text markdown-content" : "message-text";
  if (role === "assistant") renderMarkdownInto(messageText, text, images);
  else messageText.textContent = text;
  body.append(label);
  if (role === "assistant") body.append(thoughts);
  body.append(messageText);
  article.append(avatar, body);
  ensureMessageStream().append(article);
  if (scrollToBottom) scrollMessagesTo(elements.messages.scrollHeight);
  const node: StreamNode = {
    article,
    body,
    text: messageText,
    thoughts,
    thoughtSummary,
    thoughtItems,
    expandedToolIds: new Set<string>(),
    presentation: streaming ? createStreamPresentation() : null,
  };
  if (trace.length) renderHistoricalTrace(node, trace, images);
  if (node.presentation) renderStreamPresentation(node, null);
  return node;
}

function renderTranscript(messages: readonly ChatMessage[]): void {
  elements.messages.replaceChildren();
  const stream = document.createElement("div");
  stream.className = "message-stream";
  elements.messages.append(stream);
  if (!messages.length) {
    elements.messages.replaceChildren(elements.welcome);
    return;
  }
  for (const message of messages) {
    appendMessage(
      message.role,
      message.text,
      false,
      message.trace ?? [],
      message.images ?? [],
      false,
    );
  }
}

const BOTTOM_THRESHOLD_PX = 4;

function scrollMessagesTo(scrollTop: number): void {
  const previousBehavior = elements.messages.style.scrollBehavior;
  elements.messages.style.scrollBehavior = "auto";
  elements.messages.scrollTop = scrollTop;
  elements.messages.style.scrollBehavior = previousBehavior;
}

function messagesAreNearBottom(): boolean {
  return elements.messages.scrollHeight - elements.messages.clientHeight - elements.messages.scrollTop <=
    BOTTOM_THRESHOLD_PX;
}

function rememberSelectedScrollPosition(): void {
  if (state.sessionId === null) return;
  state.scrollPositions.set(state.sessionId, elements.messages.scrollTop);
}

function restoreScrollPosition(sessionId: string): void {
  scrollMessagesTo(state.scrollPositions.get(sessionId) ?? elements.messages.scrollHeight);
}

function selectedActiveStream(): ActiveStream | undefined {
  return state.activeStreams.get(state.sessionId);
}

function syncDashboardEditorState(): void {
  const streaming = selectedActiveStream() !== undefined;
  if (streaming) state.dashboardEditing = false;
  const enabled = state.sessionId !== null && !streaming && !state.dashboardSaving;
  elements.dashboardEditButton.disabled = !enabled;
  elements.dashboardEditButton.setAttribute("aria-pressed", String(state.dashboardEditing));
  elements.dashboardEditButton.title = streaming
    ? "Agent 正在更新当前会话，暂时无法编辑看板"
    : state.dashboardEditing ? "完成看板编辑" : "编辑当前会话看板";
  const label = elements.dashboardEditButton.querySelector("span");
  if (label) {
    label.textContent = state.dashboardSaving
      ? "保存中…"
      : state.dashboardEditing ? "完成" : "编辑看板";
  }
  dashboardRenderer.setEditing(state.dashboardEditing && !streaming, state.dashboardSaving);
}

function syncComposerState(): void {
  const activeStream = selectedActiveStream();
  const streaming = activeStream !== undefined;
  elements.sendButton.classList.toggle("streaming", streaming);
  elements.sendButton.setAttribute("aria-label", streaming ? "停止回答" : "发送问题");
  elements.sendButton.disabled = activeStream?.aborting ?? false;
  elements.input.disabled = streaming;
  elements.newChatButton.disabled = false;
  elements.chatDock.classList.toggle("streaming", streaming);
  const statusLabel = elements.composerStatus.querySelector("span");
  const statusDetail = elements.composerStatus.querySelector("small");
  if (statusLabel) statusLabel.textContent = streaming ? "Agent 正在计算" : "Agent 指标入口";
  if (statusDetail) statusDetail.textContent = streaming ? "可停止或点击展开查看" : "点击展开会话";
  syncDashboardEditorState();
}

function selectSession(sessionId: string): void {
  state.sessionId = sessionId;
  history.replaceState(null, "", `#session=${encodeURIComponent(sessionId)}`);
}

function applyActiveStream(activeStream: ActiveStream): void {
  rememberSelectedScrollPosition();
  selectSession(activeStream.sessionId);
  cacheDashboard(activeStream.sessionId, activeStream.dashboard);
  elements.messages.replaceChildren(activeStream.transcript);
  restoreScrollPosition(activeStream.sessionId);
  elements.chatTitle.textContent = activeStreamTitle(activeStream);
  renderCurrentDashboard();
  renderSessions();
  syncComposerState();
}

function applySession(session: SerializedSession): void {
  const activeStream = state.activeStreams.get(session.id);
  if (activeStream) {
    applyActiveStream(activeStream);
    return;
  }
  rememberSelectedScrollPosition();
  selectSession(session.id);
  cacheDashboard(session.id, session.dashboard);
  renderTranscript(session.messages);
  restoreScrollPosition(session.id);
  elements.chatTitle.textContent = session.title || "新会话";
  renderCurrentDashboard();
  renderSessions();
  syncComposerState();
}

async function refreshSessions(): Promise<void> {
  const payload = await api("/api/sessions", decodeSessionsResponse);
  state.sessions = payload.sessions;
  renderSessions();
}

async function createSession(): Promise<SerializedSession> {
  if (state.dashboardEditing || state.dashboardEditDraft || state.pendingDashboardRemoval) {
    await finishDashboardEditing();
  }
  const session = await api("/api/sessions", decodeSerializedSession, {
    method: "POST",
    body: "{}",
  });
  await refreshSessions();
  applySession(session);
  return session;
}

async function loadSession(id: string): Promise<void> {
  if (!id) return;
  if (id !== state.sessionId && (
    state.dashboardEditing || state.dashboardEditDraft || state.pendingDashboardRemoval
  )) {
    await finishDashboardEditing();
  }
  const activeStream = state.activeStreams.get(id);
  if (activeStream) {
    applyActiveStream(activeStream);
    return;
  }
  const session = await api(
    `/api/sessions/${encodeURIComponent(id)}`,
    decodeSerializedSession,
  );
  const startedWhileLoading = state.activeStreams.get(id);
  if (startedWhileLoading) applyActiveStream(startedWhileLoading);
  else applySession(session);
}

function clearSessionView(): void {
  cancelDashboardPointerDrag();
  finalizePendingDashboardRemoval();
  state.dashboardEditDraft = null;
  state.dashboardEditing = false;
  state.sessionId = null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  renderTranscript([]);
  dashboardRenderer.render({
    schemaVersion: 1,
    revision: 0,
    dataAsOf: new Date(0).toISOString(),
    dateRange: { start: null, end: null },
    widgets: [],
  });
  elements.dashboardDateRange.textContent = "尚未选择会话";
  elements.dashboardUpdatedAt.textContent = "无快照";
  elements.chatTitle.textContent = "新会话";
  renderSessions();
  syncComposerState();
}

async function deleteSession(id: string): Promise<void> {
  if (state.deletingSessionId) return;
  if (state.activeStreams.has(id)) {
    showToast("该会话正在回答,请先停止回答再删除");
    return;
  }
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (state.sessionId === id && (
    state.dashboardEditing || state.dashboardEditDraft || state.pendingDashboardRemoval
  )) {
    await finishDashboardEditing();
  }
  if (!window.confirm(`确定删除会话“${session.title || "新会话"}”吗？此操作不可恢复。`)) return;

  state.deletingSessionId = id;
  renderSessions();
  try {
    await api(
      `/api/sessions/${encodeURIComponent(id)}`,
      decodeDeleteSessionResponse,
      { method: "DELETE" },
    );
    const deletedCurrentSession = state.sessionId === id;
    state.sessions = state.sessions.filter((item) => item.id !== id);
    state.scrollPositions.delete(id);
    state.dashboards.delete(id);
    if (deletedCurrentSession) {
      clearSessionView();
      const nextSession = state.sessions[0];
      if (nextSession) await loadSession(nextSession.id);
      else await createSession();
    } else {
      renderSessions();
    }
    showToast("会话已删除");
  } finally {
    state.deletingSessionId = null;
    renderSessions();
  }
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  return decodeSseEvent(event, parseJson(dataLines.join("\n"), `$sse.${event}`));
}

function activeStreamIsVisible(activeStream: ActiveStream): boolean {
  return state.sessionId === activeStream.sessionId && activeStream.transcript.isConnected;
}

function activeStreamTitle(activeStream: ActiveStream): string {
  return state.sessions.find((session) => session.id === activeStream.sessionId)?.title || "新会话";
}

function decodedDashboardArgument(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function dashboardTargets(arguments_: JsonObject, dashboard: DashboardState): readonly string[] {
  const action = arguments_["action"];
  if (action === "upsert") {
    const widget = decodedDashboardArgument(arguments_["widget"]);
    if (typeof widget === "object" && widget !== null && !Array.isArray(widget)) {
      const id = (widget as JsonObject)["id"];
      return typeof id === "string" ? [id] : [];
    }
  }
  if (action === "remove") {
    const id = arguments_["widget_id"];
    return typeof id === "string" ? [id] : [];
  }
  if (action === "reorder") {
    const ids = decodedDashboardArgument(arguments_["widget_ids"]);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }
  if (action === "reset") return dashboard.widgets.map((widget) => widget.id);
  return [];
}

function clearPendingDashboardTool(activeStream: ActiveStream, toolCallId: string): void {
  const widgetIds = activeStream.pendingDashboardToolIds.get(toolCallId) ?? [];
  activeStream.pendingDashboardToolIds.delete(toolCallId);
  for (const id of widgetIds) activeStream.pendingDashboardWidgetIds.delete(id);
}

function handleStreamEvent(
  parsed: Exclude<ParsedSseEvent, { event: "done" }>,
  activeStream: ActiveStream,
): void {
  const { node } = activeStream;
  const visible = activeStreamIsVisible(activeStream);
  const followLatest = visible && messagesAreNearBottom();
  if (parsed.event === "dashboard_update") {
    clearPendingDashboardTool(activeStream, parsed.data.toolCallId);
    if (parsed.data.dashboard.revision >= activeStream.dashboard.revision) {
      activeStream.dashboard = parsed.data.dashboard;
      cacheDashboard(activeStream.sessionId, parsed.data.dashboard);
    }
    if (visible) renderCurrentDashboard();
    return;
  }
  if (parsed.event === "tool_call" && parsed.data.name === "update_dashboard") {
    const targets = dashboardTargets(parsed.data.arguments, activeStream.dashboard);
    activeStream.pendingDashboardToolIds.set(parsed.data.id, targets);
    for (const id of targets) activeStream.pendingDashboardWidgetIds.add(id);
    if (visible) renderCurrentDashboard();
  }
  if (parsed.event === "tool_end" && parsed.data.name === "update_dashboard" && parsed.data.isError) {
    clearPendingDashboardTool(activeStream, parsed.data.id);
    if (visible) renderCurrentDashboard();
  }
  if (parsed.event === "status") {
    if (visible) showToast(parsed.data.message);
  } else {
    const previous = node.presentation ?? createStreamPresentation();
    node.presentation = reduceStreamPresentation(previous, parsed);
    renderStreamPresentation(node, previous);
    if (visible && parsed.event === "compaction_end" && parsed.data.outcome === "failed") {
      showToast("自动上下文压缩失败");
    }
    if (parsed.event !== "error") {
      if (followLatest) scrollMessagesTo(elements.messages.scrollHeight);
      return;
    }
    const error = document.createElement("div");
    error.className = "message-error";
    const requestSuffix = parsed.data.requestId ? `（跟踪 ID：${parsed.data.requestId}）` : "";
    const message = `${parsed.data.message}${requestSuffix}`;
    error.textContent = message;
    node.body.append(error);
    showToast(visible ? message : `“${activeStreamTitle(activeStream)}”回答失败：${message}`);
  }
  if (followLatest) scrollMessagesTo(elements.messages.scrollHeight);
}

function settleStreamNode(node: StreamNode): void {
  if (!node.presentation) return;
  const previous = node.presentation;
  node.presentation = settleStreamPresentation(previous);
  renderStreamPresentation(node, previous);
}

async function streamQuestion(
  message: string,
  activeStream: ActiveStream,
): Promise<SerializedSession | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(activeStream.sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message } satisfies MessageRequest),
  });
  if (!response.ok) {
    const payload = await responsePayload(response);
    throw new Error(errorMessageFromResponse(payload) ?? `请求失败 (${response.status})`);
  }
  if (!response.body) throw new Error("浏览器不支持流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedSession: SerializedSession | null = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event === "done") completedSession = parsed.data;
      else handleStreamEvent(parsed, activeStream);
    }
    if (done) break;
  }
  return completedSession;
}

async function submitQuestion(question: string): Promise<void> {
  const message = question.trim();
  if (!message) return;
  if (!state.sessionId) await createSession();
  const sessionId = state.sessionId;
  if (!sessionId) throw new Error("尚未创建会话");
  if (state.activeStreams.has(sessionId)) return;
  if (state.dashboardEditing || state.dashboardEditDraft || state.pendingDashboardRemoval) {
    await finishDashboardEditing();
  }
  elements.input.value = "";
  appendMessage("user", message);
  const streamNode = appendMessage("assistant", "", true);
  const dashboard = state.dashboards.get(sessionId);
  if (!dashboard) throw new Error("当前会话看板尚未加载");
  const activeStream: ActiveStream = {
    sessionId,
    transcript: ensureMessageStream(),
    node: streamNode,
    dashboard,
    pendingDashboardWidgetIds: new Set<string>(),
    pendingDashboardToolIds: new Map<string, readonly string[]>(),
    aborting: false,
  };
  if (!state.activeStreams.start(activeStream)) {
    throw new Error("该会话正在回答,请稍后再试");
  }
  renderSessions();
  syncComposerState();

  try {
    const completed = await streamQuestion(message, activeStream);
    if (completed) {
      if (completed.dashboard.revision >= activeStream.dashboard.revision) {
        activeStream.dashboard = completed.dashboard;
        cacheDashboard(sessionId, completed.dashboard);
        if (activeStreamIsVisible(activeStream)) renderCurrentDashboard();
      }
      const finalMessage = latestAssistantAfterLastUser(completed.messages);
      renderMarkdownInto(
        streamNode.text,
        finalMessage?.text ?? "",
        finalMessage?.images ?? [],
      );
      streamNode.thoughtSummary.textContent = "思考过程";
      streamNode.thoughts.open = false;
      streamNode.presentation = null;
    } else {
      settleStreamNode(streamNode);
    }
  } catch (error) {
    handleStreamEvent(
      { event: "error", data: { message: messageFromUnknown(error, "回答失败") } },
      activeStream,
    );
  } finally {
    state.activeStreams.finish(activeStream);
    renderSessions();
    syncComposerState();
    try {
      await refreshSessions();
    } catch (error) {
      showToast(messageFromUnknown(error, "会话列表刷新失败"));
    }
    if (state.sessionId === sessionId && elements.chatDock.classList.contains("open")) {
      elements.input.focus();
    }
  }
}

async function abortAnswer(): Promise<void> {
  const activeStream = selectedActiveStream();
  if (!activeStream) return;
  activeStream.aborting = true;
  syncComposerState();
  try {
    await api(
      `/api/sessions/${encodeURIComponent(activeStream.sessionId)}/abort`,
      decodeAbortResponse,
      { method: "POST", body: "{}" },
    );
  } catch (error) {
    showToast(messageFromUnknown(error));
  } finally {
    activeStream.aborting = false;
    syncComposerState();
  }
}

interface DashboardPointerDrag {
  readonly pointerId: number;
  readonly sessionId: string;
  readonly widgetId: string;
  readonly handle: HTMLButtonElement;
  readonly card: HTMLElement;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly grabOffsetX: number;
  readonly grabOffsetY: number;
  readonly originalOrder: string[];
  currentOrder: string[];
  lastClientX: number;
  lastClientY: number;
  lastOrderPoint: DashboardDragPoint | null;
  previousMove: DashboardOrderMove | null;
  active: boolean;
  ghost: HTMLElement | null;
}

let dashboardPointerDrag: DashboardPointerDrag | null = null;
let cancelDashboardDragFrame: (() => void) | null = null;
let finishDashboardDropAnimation: (() => void) | null = null;

function clearDashboardDropMarkers(): void {
  for (const card of elements.dashboardGrid.querySelectorAll(".drop-before, .drop-after")) {
    card.classList.remove("drop-before", "drop-after");
  }
}

function releaseDashboardPointer(drag: DashboardPointerDrag): void {
  const owner = elements.dashboardGrid;
  if (typeof owner.releasePointerCapture !== "function") return;
  try {
    if (
      typeof owner.hasPointerCapture !== "function" ||
      owner.hasPointerCapture(drag.pointerId)
    ) {
      owner.releasePointerCapture(drag.pointerId);
    }
  } catch {
    // Pointer capture may already have been released by the browser.
  }
}

function copyDragGhostCanvases(source: HTMLElement, ghost: HTMLElement): void {
  const sourceCanvases = source.querySelectorAll<HTMLCanvasElement>("canvas");
  const ghostCanvases = ghost.querySelectorAll<HTMLCanvasElement>("canvas");
  sourceCanvases.forEach((canvas, index) => {
    const copy = ghostCanvases.item(index);
    if (!copy) return;
    try {
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d")?.drawImage(canvas, 0, 0);
    } catch {
      // A chart canvas can still be represented by the surrounding card if copying is unavailable.
    }
  });
}

function createDashboardDragGhost(
  card: HTMLElement,
  rect: DOMRect,
  clientX: number,
  clientY: number,
  offsetX: number,
  offsetY: number,
): HTMLElement {
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.remove("dragging-source", "drop-before", "drop-after");
  ghost.classList.add("dashboard-drag-ghost");
  ghost.removeAttribute("data-widget-id");
  ghost.setAttribute("aria-hidden", "true");
  for (const identified of ghost.querySelectorAll("[id]")) identified.removeAttribute("id");
  for (const control of ghost.querySelectorAll<HTMLElement>(
    "[data-drag-handle], [data-close-widget-id]",
  )) {
    control.removeAttribute("data-drag-handle");
    control.removeAttribute("data-close-widget-id");
    control.tabIndex = -1;
  }
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.transform = `translate3d(${clientX - offsetX}px, ${clientY - offsetY}px, 0)`;
  copyDragGhostCanvases(card, ghost);
  document.body.append(ghost);
  return ghost;
}

function moveDashboardDragGhost(drag: DashboardPointerDrag): void {
  if (!drag.ghost) return;
  drag.ghost.style.transform = `translate3d(${drag.lastClientX - drag.grabOffsetX}px, ${drag.lastClientY - drag.grabOffsetY}px, 0)`;
}

function updateDashboardPointerOrder(drag: DashboardPointerDrag): void {
  if (!drag.active || dashboardPointerDrag !== drag || state.sessionId !== drag.sessionId) return;
  const layout = dashboardRenderer.readLayout();
  const point = {
    x: drag.lastClientX - layout.bounds.left,
    y: drag.lastClientY - layout.bounds.top,
  };
  // Grid-relative coordinates include real scrolling, but not card reflow or FLIP.
  if (point.x === drag.lastOrderPoint?.x && point.y === drag.lastOrderPoint.y) return;
  drag.lastOrderPoint = point;
  const target = dashboardDropTarget(
    layout, drag.currentOrder, drag.widgetId, point, drag.previousMove,
  );
  clearDashboardDropMarkers();
  if (!target) return;
  const nextOrder = reorderedWidgetIds(drag.currentOrder, drag.widgetId, target.widgetId, target.after);
  drag.previousMove = target;
  drag.currentOrder = nextOrder;
  elements.dashboardGrid.querySelector(`[data-widget-id="${target.widgetId}"]`)
    ?.classList.add(target.after ? "drop-after" : "drop-before");
  renderOptimisticDashboardOrder(drag.sessionId, nextOrder);
}

function startDashboardPointerDrag(drag: DashboardPointerDrag): void {
  if (drag.ghost) return;
  const rect = drag.card.getBoundingClientRect();
  drag.ghost = createDashboardDragGhost(
    drag.card,
    rect,
    drag.lastClientX,
    drag.lastClientY,
    drag.grabOffsetX,
    drag.grabOffsetY,
  );
  drag.card.classList.add("dragging-source");
  drag.handle.setAttribute("aria-grabbed", "true");
  elements.dashboardGrid.classList.add("dashboard-drag-active");
  document.body.classList.add("dashboard-pointer-dragging");
}

function revealDashboardDragSource(drag: DashboardPointerDrag): void {
  drag.ghost?.remove();
  drag.ghost = null;
  drag.card.classList.remove("dragging-source");
  drag.handle.removeAttribute("aria-grabbed");
  elements.dashboardGrid.classList.remove("dashboard-drag-active");
}

function settleDashboardDragGhost(drag: DashboardPointerDrag): void {
  const ghost = drag.ghost;
  if (!ghost || typeof ghost.animate !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    revealDashboardDragSource(drag);
    return;
  }
  const layout = dashboardRenderer.readLayout();
  const targetRect = layout.widgets.get(drag.widgetId);
  if (!targetRect) {
    revealDashboardDragSource(drag);
    return;
  }
  const targetTransform = `translate3d(${layout.bounds.left + targetRect.left}px, ${layout.bounds.top + targetRect.top}px, 0)`;
  let settled = false;
  let timerId: number | null = null;
  const reveal = (): void => {
    if (settled) return;
    settled = true;
    if (timerId !== null) window.clearTimeout(timerId);
    if (finishDashboardDropAnimation === reveal) finishDashboardDropAnimation = null;
    animation.cancel();
    revealDashboardDragSource(drag);
  };
  const animation = ghost.animate([
    { transform: ghost.style.transform, opacity: 0.96 },
    { transform: targetTransform, opacity: 0.72 },
  ], {
    duration: 160,
    easing: "cubic-bezier(.2, .75, .25, 1)",
  });
  animation.addEventListener("finish", reveal, { once: true });
  animation.addEventListener("cancel", reveal, { once: true });
  finishDashboardDropAnimation = reveal;
  timerId = window.setTimeout(reveal, 200);
}

function finishDashboardPointerDrag(commit: boolean): void {
  const drag = dashboardPointerDrag;
  if (!drag) return;
  cancelDashboardDragFrame?.();
  cancelDashboardDragFrame = null;
  if (commit && drag.active) refreshDashboardPointerDrag(drag);
  dashboardPointerDrag = null;
  releaseDashboardPointer(drag);
  clearDashboardDropMarkers();
  document.body.classList.remove("dashboard-pointer-dragging");
  if (!drag.active) return;
  if (!commit) {
    drag.currentOrder = [...drag.originalOrder];
    renderOptimisticDashboardOrder(drag.sessionId, drag.originalOrder);
    dashboardRenderer.finishPositionAnimations();
    revealDashboardDragSource(drag);
    return;
  }
  settleDashboardDragGhost(drag);
}

function cancelDashboardPointerDrag(): void {
  finishDashboardPointerDrag(false);
  finishDashboardDropAnimation?.();
  dashboardRenderer.finishPositionAnimations();
}

function refreshDashboardPointerDrag(drag: DashboardPointerDrag): void {
  startDashboardPointerDrag(drag);
  updateDashboardPointerOrder(drag);
  moveDashboardDragGhost(drag);
}

function scheduleDashboardDragRefresh(): void {
  if (!dashboardPointerDrag?.active || cancelDashboardDragFrame) return;
  const refresh = (): void => {
    cancelDashboardDragFrame = null;
    const drag = dashboardPointerDrag;
    if (drag?.active) refreshDashboardPointerDrag(drag);
  };
  if (typeof window.requestAnimationFrame === "function" &&
    typeof window.cancelAnimationFrame === "function") {
    const frame = window.requestAnimationFrame(refresh);
    cancelDashboardDragFrame = () => window.cancelAnimationFrame(frame);
  } else {
    const timer = window.setTimeout(refresh, 0);
    cancelDashboardDragFrame = () => window.clearTimeout(timer);
  }
}

function visibleDashboardWidgetIds(dashboard: DashboardState): string[] {
  const draft = state.dashboardEditDraft;
  if (draft?.sessionId === state.sessionId) return [...draft.widgetIds];
  return dashboard.widgets.map((widget) => widget.id);
}

function renderOptimisticDashboardOrder(sessionId: string, widgetIds: readonly string[]): void {
  if (state.sessionId !== sessionId) return;
  const draft = state.dashboardEditDraft;
  if (draft?.sessionId === sessionId) draft.widgetIds = [...widgetIds];
  dashboardRenderer.previewOrder(widgetIds);
}

function reorderedWidgetIds(
  widgetIds: readonly string[],
  draggedId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (draggedId === targetId || !widgetIds.includes(draggedId) || !widgetIds.includes(targetId)) {
    return [...widgetIds];
  }
  const reordered = widgetIds.filter((id) => id !== draggedId);
  const targetIndex = reordered.indexOf(targetId);
  reordered.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
  return reordered;
}

async function initialize(): Promise<void> {
  try {
    const sessionPayload = await api("/api/sessions", decodeSessionsResponse);
    state.sessions = sessionPayload.sessions;
    renderSessions();

    const availableSessionIds = new Set(state.sessions.map((session) => session.id));
    const initialTarget = initialSessionTarget(location.hash, availableSessionIds);
    if (initialTarget.kind === "load") await loadSession(initialTarget.sessionId);
    else await createSession();
  } catch (error) {
    showToast(`初始化失败:${messageFromUnknown(error)}`);
  }
}

elements.dashboardEditButton.addEventListener("click", () => {
  if (state.dashboardSaving || selectedActiveStream() || !state.sessionId) return;
  if (state.dashboardEditing) {
    void finishDashboardEditing().catch((error) => showToast(messageFromUnknown(error)));
    return;
  }
  const dashboard = state.dashboards.get(state.sessionId);
  if (!dashboard) return;
  ensureDashboardEditDraft(state.sessionId, dashboard);
  state.dashboardEditing = true;
  syncDashboardEditorState();
  const firstHandle = elements.dashboardGrid.querySelector("[data-drag-handle]");
  if (firstHandle instanceof HTMLElement) firstHandle.focus();
});

elements.dashboardGrid.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const close = event.target.closest("[data-close-widget-id]");
  if (!(close instanceof HTMLButtonElement)) return;
  const widgetId = close.dataset["closeWidgetId"];
  if (widgetId) {
    void scheduleDashboardRemoval(widgetId).catch((error) => showToast(messageFromUnknown(error)));
  }
});

elements.dashboardGrid.addEventListener("keydown", (event) => {
  if (
    !state.dashboardEditing || state.dashboardSaving || dashboardPointerDrag ||
    !(event.target instanceof Element)
  ) return;
  const handle = event.target.closest("[data-drag-handle]");
  if (!(handle instanceof HTMLButtonElement)) return;
  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp"
    ? -1
    : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
  if (!direction || !state.sessionId) return;
  const dashboard = state.dashboards.get(state.sessionId);
  const widgetId = handle.dataset["dragHandle"];
  if (!dashboard || !widgetId) return;
  const widgetIds = visibleDashboardWidgetIds(dashboard);
  const currentIndex = widgetIds.indexOf(widgetId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= widgetIds.length) return;
  event.preventDefault();
  finalizePendingDashboardRemoval();
  [widgetIds[currentIndex], widgetIds[nextIndex]] = [
    widgetIds[nextIndex] as string,
    widgetIds[currentIndex] as string,
  ];
  renderOptimisticDashboardOrder(state.sessionId, widgetIds);
  const restored = elements.dashboardGrid.querySelector(`[data-drag-handle="${widgetId}"]`);
  if (restored instanceof HTMLElement) restored.focus();
});

elements.dashboardGrid.addEventListener("pointerdown", (event) => {
  if (
    !state.dashboardEditing || state.dashboardSaving || event.button !== 0 ||
    event.isPrimary === false || !(event.target instanceof Element) || !state.sessionId
  ) return;
  const handle = event.target.closest("[data-drag-handle]");
  if (!(handle instanceof HTMLButtonElement)) return;
  const widgetId = handle.dataset["dragHandle"];
  const card = handle.closest("[data-widget-id]");
  const dashboard = state.dashboards.get(state.sessionId);
  if (!widgetId || !(card instanceof HTMLElement) || !dashboard) return;
  cancelDashboardPointerDrag();
  finalizePendingDashboardRemoval();
  event.preventDefault();
  handle.focus();
  const rect = card.getBoundingClientRect();
  dashboardPointerDrag = {
    pointerId: event.pointerId,
    sessionId: state.sessionId,
    widgetId,
    handle,
    card,
    startClientX: event.clientX,
    startClientY: event.clientY,
    grabOffsetX: event.clientX - rect.left,
    grabOffsetY: event.clientY - rect.top,
    originalOrder: visibleDashboardWidgetIds(dashboard),
    currentOrder: visibleDashboardWidgetIds(dashboard),
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    lastOrderPoint: null,
    previousMove: null,
    active: false,
    ghost: null,
  };
  if (typeof elements.dashboardGrid.setPointerCapture === "function") {
    try {
      elements.dashboardGrid.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners still keep mouse dragging functional without capture.
    }
  }
});

window.addEventListener("pointermove", (event) => {
  const drag = dashboardPointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastClientX = event.clientX;
  drag.lastClientY = event.clientY;
  if (!drag.active) {
    const distance = Math.hypot(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    );
    if (distance < 5) return;
    drag.active = true;
  }
  event.preventDefault();
  scheduleDashboardDragRefresh();
});

window.addEventListener("pointerup", (event) => {
  const drag = dashboardPointerDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastClientX = event.clientX;
  drag.lastClientY = event.clientY;
  if (drag.active) event.preventDefault();
  finishDashboardPointerDrag(true);
});

window.addEventListener("pointercancel", (event) => {
  if (dashboardPointerDrag && event.pointerId === dashboardPointerDrag.pointerId) {
    cancelDashboardPointerDrag();
  }
});

elements.dashboardGrid.addEventListener("lostpointercapture", (event) => {
  if (dashboardPointerDrag?.pointerId === event.pointerId) cancelDashboardPointerDrag();
});
window.addEventListener("scroll", () => {
  finishDashboardDropAnimation?.();
  scheduleDashboardDragRefresh();
}, { passive: true });
window.addEventListener("resize", () => {
  finishDashboardDropAnimation?.();
  scheduleDashboardDragRefresh();
}, { passive: true });
window.addEventListener("blur", cancelDashboardPointerDrag);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (dashboardPointerDrag || finishDashboardDropAnimation)) {
    event.preventDefault();
    cancelDashboardPointerDrag();
  }
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedActiveStream()) void abortAnswer();
  else void submitQuestion(elements.input.value).catch((error) => showToast(messageFromUnknown(error)));
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.input.addEventListener("focus", () => setChatOpen(true));
elements.composer.addEventListener("click", () => setChatOpen(true));
elements.newChatButton.addEventListener("click", () => {
  void createSession()
    .then(() => setChatOpen(true, true))
    .catch((error) => showToast(messageFromUnknown(error)));
});
elements.sessionList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const deleteCandidate = event.target.closest("[data-delete-session-id]");
  const deleteButton = deleteCandidate instanceof HTMLButtonElement ? deleteCandidate : null;
  const deleteSessionId = deleteButton?.dataset["deleteSessionId"];
  if (deleteSessionId) {
    void deleteSession(deleteSessionId).catch((error) => showToast(messageFromUnknown(error)));
    return;
  }
  const candidate = event.target.closest("[data-session-id]");
  const button = candidate instanceof HTMLElement ? candidate : null;
  const sessionId = button?.dataset["sessionId"];
  if (sessionId) {
    toggleHistory(false);
    void loadSession(sessionId)
      .then(() => setChatOpen(true))
      .catch((error) => showToast(messageFromUnknown(error)));
  }
});
elements.messages.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const candidate = event.target.closest("[data-question]");
  const button = candidate instanceof HTMLElement ? candidate : null;
  const question = button?.dataset["question"];
  if (question) {
    void submitQuestion(question).catch((error) => showToast(messageFromUnknown(error)));
  }
});
elements.historyButton.addEventListener("click", () => toggleHistory());
elements.historyCloseButton.addEventListener("click", () => toggleHistory(false));
elements.chatCollapseButton.addEventListener("click", () => setChatOpen(false));
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (!elements.chatDock.contains(event.target)) setChatOpen(false);
  if (
    !elements.historyPanel.contains(event.target) &&
    !elements.historyButton.contains(event.target)
  ) {
    toggleHistory(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setChatOpen(false);
  toggleHistory(false);
});

void initialize();
