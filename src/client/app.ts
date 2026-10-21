import type {
  AuthResponse,
  ChatMessage,
  ChatRole,
  ChatTraceItem,
  JsonObject,
  MessageRequest,
  ParsedSseEvent,
  SerializedSession,
  SessionSummary,
} from "../shared/contracts.ts";
import type { DashboardState, SessionDashboard } from "../shared/dashboard.ts";
import {
  decodeAuthResponse,
  decodeAbortResponse,
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
import { renderMarkdownInto } from "./markdown.ts";
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
  loginForm: requiredElement("#loginForm", HTMLFormElement),
  loginButton: requiredElement("#loginButton", HTMLButtonElement),
  loginStatus: requiredElement("#loginStatus", HTMLElement),
  currentAccount: requiredElement("#currentAccount", HTMLElement),
  logoutButton: requiredElement("#logoutButton", HTMLButtonElement),
  dashboardTabs: requiredElement("#dashboardTabs", HTMLElement),
  dashboardTitle: requiredElement("#dashboardTitle", HTMLElement),
  dashboardGrid: requiredElement("#dashboardGrid", HTMLElement),
  dashboardDateRange: requiredElement("#dashboardDateRange", HTMLElement),
  dashboardUpdatedAt: requiredElement("#dashboardUpdatedAt", HTMLElement),
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
  dashboardScrollPositions: Map<string, Map<string, { readonly left: number; readonly top: number }>>;
  dashboards: Map<string, Map<string, DashboardState>>;
  dashboardOptions: Map<string, readonly Pick<SessionDashboard, "id" | "title">[]>;
  selectedDashboardIds: Map<string, string>;
  deletingSessionId: string | null;
  toastTimer: number | null;
}

interface ActiveStream {
  readonly sessionId: string;
  readonly transcript: HTMLElement;
  readonly node: StreamNode;
  dashboards: Map<string, DashboardState>;
  readonly requestDashboardId: string;
  readonly pendingDashboardWidgetIds: Set<string>;
  readonly pendingDashboardToolIds: Map<string, { dashboardId: string; widgetIds: readonly string[] }>;
  aborting: boolean;
}

const state: ClientState = {
  sessionId: null,
  sessions: [],
  activeStreams: new SessionStreamRegistry<ActiveStream>(),
  scrollPositions: new Map<string, number>(),
  dashboardScrollPositions: new Map(),
  dashboards: new Map(),
  dashboardOptions: new Map(),
  selectedDashboardIds: new Map(),
  deletingSessionId: null,
  toastTimer: null,
};

const dashboardRenderer = new DashboardRenderer(elements.dashboardGrid);
let authGeneration = 0;
let currentLogin: AuthResponse | null = null;
let authExpiryTimer: number | undefined;
const pendingRequests = new Set<AbortController>();
const streamReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const forkRequests = new Map<string, Promise<SerializedSession>>();

function requireCurrentAccount(generation: number): void {
  if (generation !== authGeneration) throw new Error("登录账号已切换");
}

function clearLogin(message = "请使用域账号登录"): void {
  authGeneration++;
  currentLogin = null;
  if (authExpiryTimer !== undefined) window.clearTimeout(authExpiryTimer);
  for (const controller of pendingRequests) controller.abort();
  pendingRequests.clear();
  for (const reader of streamReaders) void reader.cancel().catch(() => {});
  streamReaders.clear();
  forkRequests.clear();
  state.activeStreams = new SessionStreamRegistry<ActiveStream>();
  state.sessions = [];
  state.dashboards.clear();
  state.dashboardOptions.clear();
  state.selectedDashboardIds.clear();
  state.scrollPositions.clear();
  state.dashboardScrollPositions.clear();
  state.deletingSessionId = null;
  clearSessionView();
  elements.messages.replaceChildren();
  elements.input.value = "";
  elements.toast.replaceChildren();
  elements.toast.classList.remove("visible");
  elements.currentAccount.textContent = "";
  document.body.classList.add("signed-out");
  elements.loginStatus.textContent = message;
  elements.loginButton.disabled = false;
  const password = document.querySelector<HTMLInputElement>("#loginPassword");
  if (password) password.value = "";
  setChatOpen(false);
  toggleHistory(false);
}

function acceptLogin(login: AuthResponse): void {
  clearLogin();
  currentLogin = login;
  elements.currentAccount.textContent = login.account;
  document.body.classList.remove("signed-out");
  authExpiryTimer = window.setTimeout(() => clearLogin("登录已过期，请重新登录"), Math.max(0, Date.parse(login.expiresAt) - Date.now()));
  (authExpiryTimer as unknown as { unref?: () => void }).unref?.();
}

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
  const copy = document.createElement("span");
  copy.textContent = message;
  elements.toast.replaceChildren(copy);
  elements.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
    state.toastTimer = null;
  }, 4_500);
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
  const generation = authGeneration;
  const controller = new AbortController();
  pendingRequests.add(controller);
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(path, {
      ...options, headers,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
    });
    const payload = await responsePayload(response);
    if (generation !== authGeneration) throw new Error("登录账号已切换");
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/auth/login") clearLogin("登录已过期，请重新登录");
      throw new Error(errorMessageFromResponse(payload) ?? `请求失败 (${response.status})`);
    }
    return decode(payload, `$response(${response.status})`);
  } finally {
    pendingRequests.delete(controller);
  }
}

function setChatOpen(open: boolean, focus = false): void {
  const wasOpen = elements.chatDock.classList.contains("open");
  if (!open && wasOpen) rememberSelectedScrollPosition();
  elements.chatDock.classList.toggle("open", open);
  if (open && !wasOpen && state.sessionId !== null) restoreScrollPosition(state.sessionId);
  if (open && focus) window.setTimeout(() => elements.input.focus(), 0);
}

function toggleHistory(force?: boolean): void {
  const open = force ?? !elements.historyPanel.classList.contains("open");
  elements.historyPanel.classList.toggle("open", open);
  elements.historyButton.setAttribute("aria-expanded", String(open));
}

function selectedDashboardId(sessionId: string | null = state.sessionId): string | undefined {
  return sessionId ? state.selectedDashboardIds.get(sessionId) ?? state.dashboardOptions.get(sessionId)?.[0]?.id : undefined;
}

function getDashboard(sessionId: string | null, dashboardId = selectedDashboardId(sessionId)): DashboardState | undefined {
  return sessionId && dashboardId ? state.dashboards.get(sessionId)?.get(dashboardId) : undefined;
}

function cacheSessionDashboards(sessionId: string, dashboards: readonly SessionDashboard[]): void {
  state.dashboardOptions.set(sessionId, dashboards.map(({ id, title }) => ({ id, title })));
  const selected = selectedDashboardId(sessionId);
  if (!dashboards.some((item) => item.id === selected)) state.selectedDashboardIds.set(sessionId, dashboards[0]!.id);
  for (const item of dashboards) cacheDashboard(sessionId, item.state, item.id);
}

function renderDashboardTabs(): void {
  const options = state.dashboardOptions.get(state.sessionId ?? "") ?? [];
  const selected = selectedDashboardId();
  elements.dashboardTabs.hidden = options.length < 2;
  const buttons = options.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dashboard-tab";
    button.id = `dashboard-tab-${item.id}`;
    button.dataset["dashboardId"] = item.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "dashboardGrid");
    button.setAttribute("aria-selected", String(item.id === selected));
    button.tabIndex = item.id === selected ? 0 : -1;
    button.textContent = item.title;
    button.title = item.title;
    return button;
  });
  elements.dashboardTabs.replaceChildren(...buttons);
  elements.dashboardTitle.textContent = options.find((item) => item.id === selected)?.title ?? "指标看板";
  if (options.length > 1 && selected) elements.dashboardGrid.setAttribute("aria-labelledby", `dashboard-tab-${selected}`);
  else elements.dashboardGrid.removeAttribute("aria-labelledby");
}

function rememberDashboardScrollPosition(): void {
  const sessionId = state.sessionId;
  const dashboardId = selectedDashboardId();
  if (!sessionId || !dashboardId || !getDashboard(sessionId, dashboardId)) return;
  let positions = state.dashboardScrollPositions.get(sessionId);
  if (!positions) { positions = new Map(); state.dashboardScrollPositions.set(sessionId, positions); }
  positions.set(dashboardId, {
    left: Math.max(0, window.scrollX ?? document.documentElement.scrollLeft ?? 0),
    top: Math.max(0, window.scrollY ?? document.documentElement.scrollTop ?? 0),
  });
}

function restoreDashboardScrollPosition(): void {
  const sessionId = state.sessionId;
  const dashboardId = selectedDashboardId();
  const position = sessionId && dashboardId ? state.dashboardScrollPositions.get(sessionId)?.get(dashboardId) : undefined;
  window.scrollTo?.({ left: position?.left ?? 0, top: position?.top ?? 0, behavior: "instant" });
}

async function switchDashboard(dashboardId: string): Promise<void> {
  const sessionId = state.sessionId;
  if (!sessionId || dashboardId === selectedDashboardId() || !getDashboard(sessionId, dashboardId)) return;
  rememberDashboardScrollPosition();
  state.selectedDashboardIds.set(sessionId, dashboardId);
  renderCurrentDashboard();
  elements.dashboardTabs.querySelector<HTMLElement>("[aria-selected='true']")?.focus({ preventScroll: true });
  restoreDashboardScrollPosition();
}

elements.dashboardTabs.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-dashboard-id]") : null;
  const id = button?.dataset["dashboardId"];
  if (id) void switchDashboard(id).catch((error) => showToast(messageFromUnknown(error)));
});
elements.dashboardTabs.addEventListener("keydown", (event) => {
  const options = state.dashboardOptions.get(state.sessionId ?? "") ?? [];
  const index = options.findIndex((item) => item.id === selectedDashboardId());
  const target = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
    event.key === "ArrowRight" ? (index + 1) % options.length :
    event.key === "ArrowLeft" ? (index - 1 + options.length) % options.length : -1;
  if (target < 0 || !options[target]) return;
  event.preventDefault();
  void switchDashboard(options[target].id).catch((error) => showToast(messageFromUnknown(error)));
});

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
  dashboardRenderer.render(dashboard, { pendingWidgetIds: pending });
  elements.dashboardDateRange.textContent = formatDashboardDateRange(dashboard);
  elements.dashboardUpdatedAt.textContent = `${formatDataAsOf(dashboard.dataAsOf)} · r${dashboard.revision}`;
}

function cacheDashboard(sessionId: string, dashboard: DashboardState, dashboardId = selectedDashboardId(sessionId)): boolean {
  if (!dashboardId || !state.dashboardOptions.get(sessionId)?.some((item) => item.id === dashboardId)) return false;
  let dashboards = state.dashboards.get(sessionId);
  if (!dashboards) { dashboards = new Map(); state.dashboards.set(sessionId, dashboards); }
  const current = dashboards.get(dashboardId);
  if (current && current.revision > dashboard.revision) return false;
  dashboards.set(dashboardId, dashboard);
  return true;
}

function pendingWidgetIdsForCurrentSession(): ReadonlySet<string> {
  const pending = selectedActiveStream()?.pendingDashboardWidgetIds ?? new Set<string>();
  const prefix = `${selectedDashboardId()}:`;
  return new Set([...pending].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
}

function renderCurrentDashboard(): void {
  renderDashboardTabs();
  if (!state.sessionId) return;
  const dashboard = getDashboard(state.sessionId);
  if (dashboard) renderDashboard(dashboard, pendingWidgetIdsForCurrentSession());
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
    if (session.readOnly) {
      const label = document.createElement("span");
      label.className = "session-shared";
      label.textContent = "共享历史";
      button.append(label);
    }
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
    row.append(button);
    if (!session.readOnly) row.append(deleteButton);
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
): HTMLDivElement {
  const item = existing instanceof HTMLDivElement && existing.classList.contains("thought-text")
    ? existing
    : createTraceText();
  item.setAttribute(STREAM_THOUGHT_KEY_ATTRIBUTE, key);
  renderMarkdownInto(item, text);
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
): void {
  const children = trace.map((item, index) => (
    item.type === "text"
      ? keyedTraceText(
          undefined,
          `trace:${index}`,
          item.text,
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
    );
  }

  const existing = thoughtChildrenByKey(node.thoughtItems);
  const children: HTMLElement[] = presentation.items.map((item, index) => (
    item.type === "text"
      ? keyedTraceText(
          existing.get(`trace:${index}`),
          `trace:${index}`,
          item.text,
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
    const key = `trace:${presentation.items.length}`;
    children.push(keyedTraceText(
      existing.get(key),
      key,
      trailingText,
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
  if (role === "assistant") renderMarkdownInto(messageText, text);
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
  if (trace.length) renderHistoricalTrace(node, trace);
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
  if (state.sessionId === null || !elements.chatDock.classList.contains("open")) return;
  state.scrollPositions.set(state.sessionId, elements.messages.scrollTop);
}

function restoreScrollPosition(sessionId: string): void {
  if (!elements.chatDock.classList.contains("open")) return;
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
  elements.input.readOnly = streaming;
  elements.newChatButton.disabled = false;
  elements.chatDock.classList.toggle("streaming", streaming);
  const statusLabel = elements.composerStatus.querySelector("span");
  const statusDetail = elements.composerStatus.querySelector("small");
  if (statusLabel) statusLabel.textContent = streaming ? "Agent 正在计算" : "Agent 指标入口";
  if (statusDetail) statusDetail.textContent = streaming ? "可停止或点击展开查看"
    : state.sessions.find((item) => item.id === state.sessionId)?.readOnly ? "共享历史 · 继续时创建个人副本" : "点击展开会话";
}

function selectSession(sessionId: string): void {
  state.sessionId = sessionId;
  history.replaceState(null, "", `#session=${encodeURIComponent(sessionId)}`);
}

function applyActiveStream(activeStream: ActiveStream): void {
  rememberSelectedScrollPosition();
  rememberDashboardScrollPosition();
  selectSession(activeStream.sessionId);
  for (const [id, dashboard] of activeStream.dashboards) cacheDashboard(activeStream.sessionId, dashboard, id);
  elements.messages.replaceChildren(activeStream.transcript);
  restoreScrollPosition(activeStream.sessionId);
  elements.chatTitle.textContent = activeStreamTitle(activeStream);
  renderCurrentDashboard();
  restoreDashboardScrollPosition();
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
  rememberDashboardScrollPosition();
  selectSession(session.id);
  cacheSessionDashboards(session.id, session.dashboards);
  renderTranscript(session.messages);
  restoreScrollPosition(session.id);
  elements.chatTitle.textContent = session.title || "新会话";
  renderCurrentDashboard();
  restoreDashboardScrollPosition();
  renderSessions();
  syncComposerState();
}

async function refreshSessions(): Promise<void> {
  const payload = await api("/api/sessions", decodeSessionsResponse);
  state.sessions = payload.sessions;
  renderSessions();
}

async function createSession(): Promise<SerializedSession> {
  const generation = authGeneration;
  requireCurrentAccount(generation);
  const session = await api("/api/sessions", decodeSerializedSession, {
    method: "POST",
    body: "{}",
  });
  await refreshSessions();
  requireCurrentAccount(generation);
  applySession(session);
  return session;
}

async function ensurePrivateSession(): Promise<void> {
  const generation = authGeneration;
  const id = state.sessionId;
  if (!id || !state.sessions.find((item) => item.id === id)?.readOnly) return;
  let operation = forkRequests.get(id);
  if (!operation) {
    operation = api(`/api/sessions/${encodeURIComponent(id)}/fork`, decodeSerializedSession, {
      method: "POST", body: "{}",
    }).then(async (session) => {
      await refreshSessions();
      requireCurrentAccount(generation);
      if (state.sessionId === id) {
        rememberDashboardScrollPosition();
        const positions = state.dashboardScrollPositions.get(id);
        if (positions) state.dashboardScrollPositions.set(session.id, new Map(positions));
        const selected = selectedDashboardId(id);
        if (selected && session.dashboards.some((item) => item.id === selected)) state.selectedDashboardIds.set(session.id, selected);
        applySession(session);
      }
      return session;
    });
    forkRequests.set(id, operation);
  }
  try {
    const session = await operation;
    if (state.sessionId !== session.id) throw new Error("会话已切换，请重试操作");
  } finally { if (forkRequests.get(id) === operation) forkRequests.delete(id); }
}

async function loadSession(id: string): Promise<void> {
  const generation = authGeneration;
  if (!id) return;
  requireCurrentAccount(generation);
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
  renderDashboardTabs();
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  renderTranscript([]);
  dashboardRenderer.render({
    schemaVersion: 1,
    revision: 0,
    dataAsOf: new Date(0).toISOString(),
    dateRange: { start: null, end: null },
    widgets: [],
  });
  restoreDashboardScrollPosition();
  elements.dashboardDateRange.textContent = "尚未选择会话";
  elements.dashboardUpdatedAt.textContent = "无快照";
  elements.chatTitle.textContent = "新会话";
  renderSessions();
  syncComposerState();
}

async function deleteSession(id: string): Promise<void> {
  const generation = authGeneration;
  if (state.deletingSessionId) return;
  if (state.activeStreams.has(id)) {
    showToast("该会话正在回答,请先停止回答再删除");
    return;
  }
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  requireCurrentAccount(generation);
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
    state.dashboardScrollPositions.delete(id);
    state.dashboards.delete(id);
    state.dashboardOptions.delete(id);
    state.selectedDashboardIds.delete(id);
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
    if (generation === authGeneration) {
      state.deletingSessionId = null;
      renderSessions();
    }
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
  const pending = activeStream.pendingDashboardToolIds.get(toolCallId);
  activeStream.pendingDashboardToolIds.delete(toolCallId);
  if (pending) for (const id of pending.widgetIds) activeStream.pendingDashboardWidgetIds.delete(`${pending.dashboardId}:${id}`);
}

function handleStreamEvent(
  parsed: Exclude<ParsedSseEvent, { event: "done" }>,
  activeStream: ActiveStream,
): void {
  const { node } = activeStream;
  const visible = activeStreamIsVisible(activeStream);
  const followLatest = visible && elements.chatDock.classList.contains("open") && messagesAreNearBottom();
  if (parsed.event === "dashboard_update") {
    clearPendingDashboardTool(activeStream, parsed.data.toolCallId);
    const id = parsed.data.dashboardId;
    const current = activeStream.dashboards.get(id);
    if (current && parsed.data.dashboard.revision >= current.revision) {
      activeStream.dashboards.set(id, parsed.data.dashboard);
      cacheDashboard(activeStream.sessionId, parsed.data.dashboard, id);
    }
    if (visible) renderCurrentDashboard();
    return;
  }
  if (parsed.event === "tool_call" && parsed.data.name === "update_dashboard") {
    const id = parsed.data.arguments["dashboard_id"];
    const dashboard = typeof id === "string" ? activeStream.dashboards.get(id) : undefined;
    if (dashboard && typeof id === "string") {
      const targets = dashboardTargets(parsed.data.arguments, dashboard);
      activeStream.pendingDashboardToolIds.set(parsed.data.id, { dashboardId: id, widgetIds: targets });
      for (const target of targets) activeStream.pendingDashboardWidgetIds.add(`${id}:${target}`);
    }
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
  const generation = authGeneration;
  const controller = new AbortController();
  pendingRequests.add(controller);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(activeStream.sessionId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, dashboardId: activeStream.requestDashboardId } satisfies MessageRequest),
      signal: controller.signal,
    });
    if (generation !== authGeneration) throw new Error("登录账号已切换");
    if (!response.ok) {
      if (response.status === 401) clearLogin("登录已过期，请重新登录");
      const payload = await responsePayload(response);
      throw new Error(errorMessageFromResponse(payload) ?? `请求失败 (${response.status})`);
    }
    if (!response.body) throw new Error("浏览器不支持流式响应");

    const reader = response.body.getReader();
    streamReaders.add(reader);
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      let completedSession: SerializedSession | null = null;
      while (true) {
        const { value, done } = await reader.read();
        if (generation !== authGeneration) throw new Error("登录账号已切换");
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
    } finally { streamReaders.delete(reader); reader.releaseLock(); }
  } finally { pendingRequests.delete(controller); }
}

async function submitQuestion(question: string): Promise<void> {
  const generation = authGeneration;
  const message = question.trim();
  if (!message) return;
  if (!state.sessionId) await createSession();
  await ensurePrivateSession();
  if (generation !== authGeneration) return;
  const sessionId = state.sessionId;
  if (!sessionId) throw new Error("尚未创建会话");
  if (state.activeStreams.has(sessionId)) return;
  if (generation !== authGeneration) return;
  elements.input.value = "";
  appendMessage("user", message);
  const streamNode = appendMessage("assistant", "", true);
  const dashboard = getDashboard(sessionId);
  if (!dashboard) throw new Error("当前会话看板尚未加载");
  const activeStream: ActiveStream = {
    sessionId,
    transcript: ensureMessageStream(),
    node: streamNode,
    dashboards: new Map(state.dashboards.get(sessionId)),
    requestDashboardId: selectedDashboardId(sessionId)!,
    pendingDashboardWidgetIds: new Set<string>(),
    pendingDashboardToolIds: new Map(),
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
      for (const item of completed.dashboards) {
        const previous = activeStream.dashboards.get(item.id);
        if (previous && item.state.revision >= previous.revision) {
          activeStream.dashboards.set(item.id, item.state);
          cacheDashboard(sessionId, item.state, item.id);
        }
      }
      if (activeStreamIsVisible(activeStream)) renderCurrentDashboard();
      const finalMessage = latestAssistantAfterLastUser(completed.messages);
      renderMarkdownInto(
        streamNode.text,
        finalMessage?.text ?? "",
      );
      streamNode.thoughtSummary.textContent = "思考过程";
      streamNode.thoughts.open = false;
      streamNode.presentation = null;
    } else {
      settleStreamNode(streamNode);
    }
  } catch (error) {
    if (generation !== authGeneration) return;
    handleStreamEvent(
      { event: "error", data: { message: messageFromUnknown(error, "回答失败") } },
      activeStream,
    );
  } finally {
    if (generation === authGeneration) {
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
  if (!currentLogin) return;
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
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedActiveStream()) void abortAnswer();
  else void submitQuestion(elements.input.value).catch((error) => showToast(messageFromUnknown(error)));
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!elements.input.readOnly) elements.composer.requestSubmit();
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
    event.stopPropagation();
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

elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (elements.loginButton.disabled) return;
  const account = document.querySelector<HTMLInputElement>("#loginAccount")!.value;
  const passwordField = document.querySelector<HTMLInputElement>("#loginPassword")!;
  const password = passwordField.value;
  passwordField.value = "";
  elements.loginButton.disabled = true;
  elements.loginStatus.textContent = "正在验证域账号…";
  void api("/api/auth/login", decodeAuthResponse, {
    method: "POST", body: JSON.stringify({ account, password }),
  }).then(async (login) => {
    acceptLogin(login);
    await initialize();
  }).catch((error) => {
    elements.loginStatus.textContent = messageFromUnknown(error);
  }).finally(() => { elements.loginButton.disabled = false; });
});

elements.logoutButton.addEventListener("click", () => {
  elements.logoutButton.disabled = true;
  void api("/api/auth/logout", decodeAbortResponse, { method: "POST", body: "{}" })
    .then(() => clearLogin("已退出登录"))
    .catch((error) => showToast(messageFromUnknown(error)))
    .finally(() => { elements.logoutButton.disabled = false; });
});

void api("/api/auth/me", decodeAuthResponse).then(async (login) => {
  // Keep an initial deep link, but never carry it across account changes.
  const hash = location.hash;
  acceptLogin(login);
  if (hash) history.replaceState(null, "", hash);
  await initialize();
}).catch(() => clearLogin("请使用域账号登录"));
