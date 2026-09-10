import type {
  ChatImage,
  ChatMessage,
  ChatRole,
  ChatTraceItem,
  JsonObject,
  MessageRequest,
  ParsedSseEvent,
  SchemaObject,
  SerializedSession,
  SessionSummary,
} from "../shared/contracts.ts";
import type { DashboardState } from "../shared/dashboard.ts";
import {
  decodeAbortResponse,
  decodeDeleteSessionResponse,
  decodeHealthResponse,
  decodeSchemaResponse,
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
  dashboardMain: requiredElement("#dashboardMain", HTMLElement),
  dashboardGrid: requiredElement("#dashboardGrid", HTMLElement),
  dashboardDateRange: requiredElement("#dashboardDateRange", HTMLElement),
  dashboardUpdatedAt: requiredElement("#dashboardUpdatedAt", HTMLElement),
  chatDock: requiredElement("#chatDock", HTMLElement),
  chatTitle: requiredElement("#chatTitle", HTMLElement),
  chatCollapseButton: requiredElement("#chatCollapseButton", HTMLButtonElement),
  historyButton: requiredElement("#historyButton", HTMLButtonElement),
  chatHistoryButton: requiredElement("#chatHistoryButton", HTMLButtonElement),
  historyPopover: requiredElement("#historyPopover", HTMLElement),
  newChatButton: requiredElement("#newChatButton", HTMLButtonElement),
  sessionList: requiredElement("#sessionList", HTMLElement),
  messages: requiredElement("#messages", HTMLElement),
  welcome: requiredElement("#welcome", HTMLElement),
  composer: requiredElement("#composer", HTMLFormElement),
  composerStatus: requiredElement("#composerStatus", HTMLElement),
  input: requiredElement("#questionInput", HTMLTextAreaElement),
  sendButton: requiredElement("#sendButton", HTMLButtonElement),
  modelBadge: requiredElement("#modelBadge", HTMLElement),
  schemaButton: requiredElement("#schemaButton", HTMLButtonElement),
  schemaCloseButton: requiredElement("#schemaCloseButton", HTMLButtonElement),
  schemaPanel: requiredElement("#schemaPanel", HTMLElement),
  schemaList: requiredElement("#schemaList", HTMLElement),
  toast: requiredElement("#toast", HTMLElement),
  guardTitle: requiredElement("#guardTitle", HTMLElement),
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
  deletingSessionId: string | null;
  toastTimer: number | null;
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

function showToast(message: string): void {
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 4_500);
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
  if (!open) {
    elements.historyPopover.classList.remove("open");
    elements.chatHistoryButton.setAttribute("aria-expanded", "false");
  }
  if (open && focus) window.setTimeout(() => elements.input.focus(), 0);
}

function toggleHistory(force?: boolean): void {
  setChatOpen(true);
  const open = force ?? !elements.historyPopover.classList.contains("open");
  elements.historyPopover.classList.toggle("open", open);
  elements.chatHistoryButton.setAttribute("aria-expanded", String(open));
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

function renderDashboard(dashboard: DashboardState, pending: ReadonlySet<string> = new Set()): void {
  dashboardRenderer.render(dashboard, pending);
  elements.dashboardDateRange.textContent = formatDashboardDateRange(dashboard);
  elements.dashboardUpdatedAt.textContent = `${formatDataAsOf(dashboard.dataAsOf)} · r${dashboard.revision}`;
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
  if (!state.sessionId) return;
  const dashboard = state.dashboards.get(state.sessionId);
  if (dashboard) renderDashboard(dashboard, pendingWidgetIdsForCurrentSession());
}

function toggleSchema(force?: boolean): void {
  const open = force ?? !elements.schemaPanel.classList.contains("open");
  elements.schemaPanel.classList.toggle("open", open);
  elements.schemaButton.setAttribute("aria-expanded", String(open));
}

function renderSessions(): void {
  elements.sessionList.replaceChildren();
  if (!state.sessions.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "session-placeholder";
    placeholder.textContent = "还没有会话";
    elements.sessionList.append(placeholder);
    return;
  }

  for (const session of state.sessions) {
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
    button.append(
      createSvg([{ d: "M7 17.5 4 20v-4.5a8 8 0 1 1 3 2Z" }]),
      Object.assign(document.createElement("span"), { textContent: title }),
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

function renderSchema(objects: readonly Omit<SchemaObject, "sql">[]): void {
  elements.schemaList.replaceChildren();
  for (const object of objects) {
    const details = document.createElement("details");
    details.className = "schema-object";
    if (object.type === "table") details.open = true;
    const summary = document.createElement("summary");
    summary.append(
      document.createTextNode(object.name),
      Object.assign(document.createElement("span"), { textContent: object.type }),
    );
    const columns = document.createElement("div");
    columns.className = "schema-columns";
    for (const column of object.columns) {
      const row = document.createElement("div");
      row.className = "schema-column";
      const suffix = column.primaryKey ? " · PK" : column.nullable ? "" : " · NOT NULL";
      row.append(
        Object.assign(document.createElement("span"), { textContent: column.name }),
        Object.assign(document.createElement("em"), { textContent: `${column.type || "ANY"}${suffix}` }),
      );
      columns.append(row);
    }
    details.append(summary, columns);
    elements.schemaList.append(details);
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

async function initialize(): Promise<void> {
  try {
    const [health, schema, sessionPayload] = await Promise.all([
      api("/api/health", decodeHealthResponse),
      api("/api/schema", decodeSchemaResponse),
      api("/api/sessions", decodeSessionsResponse),
    ]);
    const model = health.agent.model;
    elements.modelBadge.textContent = `${model.provider}/${model.model}`;
    if (health.agent.codeInterpreter.available) {
      elements.guardTitle.textContent = "严格工具隔离已开启";
    } else {
      elements.guardTitle.textContent = "代码解释器不可用";
    }
    renderSchema(schema.objects);
    state.sessions = sessionPayload.sessions;
    renderSessions();

    const requestedId = new URLSearchParams(location.hash.slice(1)).get("session");
    const initialId = requestedId || state.sessions[0]?.id;
    if (initialId) await loadSession(initialId);
    else await createSession();
  } catch (error) {
    showToast(`初始化失败:${messageFromUnknown(error)}`);
    elements.modelBadge.textContent = "服务不可用";
    elements.modelBadge.classList.add("warning");
  }
}

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
    void loadSession(sessionId).catch((error) => showToast(messageFromUnknown(error)));
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
elements.schemaButton.addEventListener("click", () => toggleSchema());
elements.schemaCloseButton.addEventListener("click", () => toggleSchema(false));
elements.historyButton.addEventListener("click", () => toggleHistory());
elements.chatHistoryButton.addEventListener("click", () => toggleHistory());
elements.chatCollapseButton.addEventListener("click", () => setChatOpen(false));
elements.dashboardMain.addEventListener("click", (event) => {
  if (event.target === elements.dashboardMain || event.target === elements.dashboardGrid) {
    setChatOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setChatOpen(false);
  toggleSchema(false);
});

void initialize();
