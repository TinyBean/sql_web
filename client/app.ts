import type {
  ChatImage,
  ChatMessage,
  ChatRole,
  ChatTraceItem,
  MessageRequest,
  ParsedSseEvent,
  SchemaObject,
  SerializedSession,
  SessionSummary,
} from "../shared/contracts.ts";
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
  formatToolStatusText,
  reduceStreamPresentation,
  settleStreamPresentation,
  type StreamPresentation,
  type StreamToolStatus,
} from "./stream-state.ts";
import { renderMarkdownInto } from "./markdown.ts";

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
  sidebar: requiredElement("#sidebar", HTMLElement),
  sidebarScrim: requiredElement("#sidebarScrim", HTMLElement),
  menuButton: requiredElement("#menuButton", HTMLButtonElement),
  newChatButton: requiredElement("#newChatButton", HTMLButtonElement),
  sessionList: requiredElement("#sessionList", HTMLElement),
  messages: requiredElement("#messages", HTMLElement),
  welcome: requiredElement("#welcome", HTMLElement),
  composer: requiredElement("#composer", HTMLFormElement),
  input: requiredElement("#questionInput", HTMLTextAreaElement),
  sendButton: requiredElement("#sendButton", HTMLButtonElement),
  modelBadge: requiredElement("#modelBadge", HTMLElement),
  schemaButton: requiredElement("#schemaButton", HTMLButtonElement),
  schemaCloseButton: requiredElement("#schemaCloseButton", HTMLButtonElement),
  schemaPanel: requiredElement("#schemaPanel", HTMLElement),
  schemaList: requiredElement("#schemaList", HTMLElement),
  toast: requiredElement("#toast", HTMLElement),
  guardTitle: requiredElement("#guardTitle", HTMLElement),
  guardCopy: requiredElement("#guardCopy", HTMLElement),
};

interface StreamNode {
  article: HTMLElement;
  body: HTMLDivElement;
  text: HTMLDivElement;
  images: HTMLDivElement;
  thoughts: HTMLDetailsElement;
  thoughtSummary: HTMLElement;
  thoughtItems: HTMLDivElement;
  presentation: StreamPresentation | null;
}

interface ClientState {
  sessionId: string | null;
  sessions: readonly SessionSummary[];
  activeStream: ActiveStream | null;
  deletingSessionId: string | null;
  toastTimer: number | null;
}

interface ActiveStream {
  readonly sessionId: string;
  readonly node: StreamNode;
}

const state: ClientState = {
  sessionId: null,
  sessions: [],
  activeStream: null,
  deletingSessionId: null,
  toastTimer: null,
};

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
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 4_500);
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

function closeSidebar(): void {
  elements.sidebar.classList.remove("open");
  elements.sidebarScrim.classList.remove("open");
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
    const row = document.createElement("div");
    row.className = "session-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
    button.dataset["sessionId"] = session.id;
    button.append(
      createSvg([{ d: "M7 17.5 4 20v-4.5a8 8 0 1 1 3 2Z" }]),
      Object.assign(document.createElement("span"), { textContent: session.title || "新会话" }),
    );
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.dataset["deleteSessionId"] = session.id;
    deleteButton.title = `删除会话：${session.title || "新会话"}`;
    deleteButton.setAttribute("aria-label", deleteButton.title);
    deleteButton.disabled = state.deletingSessionId === session.id ||
      state.activeStream?.sessionId === session.id;
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

function createToolChip(name: string, status: StreamToolStatus): HTMLSpanElement {
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
  chip.append(toolName, separator, toolStatus);
  return chip;
}

function createTraceText(text: string): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "thought-text markdown-content";
  renderMarkdownInto(item, text);
  return item;
}

function renderHistoricalTrace(node: StreamNode, trace: readonly ChatTraceItem[]): void {
  node.thoughtItems.replaceChildren();
  for (const item of trace) {
    node.thoughtItems.append(
      item.type === "text"
        ? createTraceText(item.text)
        : createToolChip(item.name, item.isError ? "error" : "done"),
    );
  }
  node.thoughtSummary.textContent = "思考过程";
  node.thoughts.hidden = trace.length === 0;
  node.thoughts.open = false;
}

function renderMessageImages(container: HTMLElement, images: readonly ChatImage[]): void {
  container.replaceChildren();
  container.hidden = images.length === 0;
  for (const item of images) {
    const image = document.createElement("img");
    image.src = `data:${item.mimeType};base64,${item.data}`;
    image.alt = item.alt;
    image.loading = "lazy";
    container.append(image);
  }
}

function renderAssistantContent(
  textContainer: HTMLElement,
  imageContainer: HTMLElement,
  text: string,
  images: readonly ChatImage[],
): void {
  const embeddedImageCount = renderMarkdownInto(textContainer, text, images);
  renderMessageImages(imageContainer, images.slice(embeddedImageCount));
}

function renderStreamPresentation(
  node: StreamNode,
  previous: StreamPresentation | null,
): void {
  const presentation = node.presentation;
  if (!presentation) return;
  const children: HTMLElement[] = presentation.items.map((item) => (
    item.type === "text"
      ? createTraceText(item.text)
      : createToolChip(item.name, item.status)
  ));
  if (presentation.waiting) {
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("aria-label", "正在思考");
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    children.push(typing);
  }
  node.thoughtItems.replaceChildren(...children);
  renderMarkdownInto(node.text, presentation.finalText);
  node.thoughts.hidden = children.length === 0;
  if (presentation.failed) {
    node.thoughtSummary.textContent = "思考过程";
    node.thoughts.open = true;
  } else if (presentation.finalized) {
    node.thoughtSummary.textContent = "思考过程";
    if (!previous?.finalized) node.thoughts.open = false;
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
  const messageImages = document.createElement("div");
  messageImages.className = "message-images";
  if (role === "assistant") renderAssistantContent(messageText, messageImages, text, images);
  else {
    messageText.textContent = text;
    messageImages.hidden = true;
  }
  body.append(label);
  if (role === "assistant") body.append(thoughts);
  body.append(messageText);
  if (role === "assistant") body.append(messageImages);
  article.append(avatar, body);
  ensureMessageStream().append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  const node: StreamNode = {
    article,
    body,
    text: messageText,
    images: messageImages,
    thoughts,
    thoughtSummary,
    thoughtItems,
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
    appendMessage(message.role, message.text, false, message.trace ?? [], message.images ?? []);
  }
}

function setActiveStream(activeStream: ActiveStream | null): void {
  state.activeStream = activeStream;
  const streaming = activeStream !== null;
  elements.sendButton.classList.toggle("streaming", streaming);
  elements.sendButton.setAttribute("aria-label", streaming ? "停止回答" : "发送问题");
  elements.input.disabled = streaming;
  elements.newChatButton.disabled = streaming;
  renderSessions();
}

function applySession(session: SerializedSession): void {
  state.sessionId = session.id;
  history.replaceState(null, "", `#session=${encodeURIComponent(session.id)}`);
  renderTranscript(session.messages);
  renderSessions();
  elements.input.focus();
}

async function refreshSessions(): Promise<void> {
  const payload = await api("/api/sessions", decodeSessionsResponse);
  state.sessions = payload.sessions;
  renderSessions();
}

async function createSession(): Promise<SerializedSession | null> {
  if (state.activeStream) return null;
  const session = await api("/api/sessions", decodeSerializedSession, {
    method: "POST",
    body: "{}",
  });
  await refreshSessions();
  applySession(session);
  closeSidebar();
  return session;
}

async function loadSession(id: string): Promise<void> {
  if (state.activeStream || !id) return;
  const session = await api(
    `/api/sessions/${encodeURIComponent(id)}`,
    decodeSerializedSession,
  );
  applySession(session);
  closeSidebar();
}

function clearSessionView(): void {
  state.sessionId = null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  renderTranscript([]);
  renderSessions();
  closeSidebar();
  elements.input.focus();
}

async function deleteSession(id: string): Promise<void> {
  if (state.deletingSessionId) return;
  if (state.activeStream?.sessionId === id) {
    showToast("该会话正在回答，请先停止回答再删除");
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
    if (deletedCurrentSession) {
      clearSessionView();
      const nextSession = state.sessions[0];
      if (nextSession) await loadSession(nextSession.id);
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

function handleStreamEvent(
  parsed: Exclude<ParsedSseEvent, { event: "done" }>,
  node: StreamNode,
): void {
  if (parsed.event === "status") {
    showToast(parsed.data.message);
  } else {
    const previous = node.presentation ?? createStreamPresentation();
    node.presentation = reduceStreamPresentation(previous, parsed);
    renderStreamPresentation(node, previous);
    if (parsed.event !== "error") {
      elements.messages.scrollTop = elements.messages.scrollHeight;
      return;
    }
    const error = document.createElement("div");
    error.className = "message-error";
    error.textContent = parsed.data.message;
    node.body.append(error);
    showToast(parsed.data.message);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
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
      else handleStreamEvent(parsed, activeStream.node);
    }
    if (done) break;
  }
  return completedSession;
}

async function submitQuestion(question: string): Promise<void> {
  const message = question.trim();
  if (!message || state.activeStream) return;
  if (!state.sessionId) await createSession();
  const sessionId = state.sessionId;
  if (!sessionId) throw new Error("尚未创建会话");
  elements.input.value = "";
  appendMessage("user", message);
  const streamNode = appendMessage("assistant", "", true);
  const activeStream: ActiveStream = { sessionId, node: streamNode };
  setActiveStream(activeStream);

  try {
    const completed = await streamQuestion(message, activeStream);
    settleStreamNode(streamNode);
    if (completed) {
      state.sessionId = completed.id;
      const finalMessage = completed.messages.findLast((item) => item.role === "assistant");
      if (finalMessage) {
        renderAssistantContent(
          streamNode.text,
          streamNode.images,
          finalMessage.text,
          finalMessage.images ?? [],
        );
      }
      await refreshSessions();
    }
  } catch (error) {
    handleStreamEvent(
      { event: "error", data: { message: messageFromUnknown(error, "回答失败") } },
      streamNode,
    );
  } finally {
    setActiveStream(null);
    elements.input.focus();
  }
}

async function abortAnswer(): Promise<void> {
  const activeStream = state.activeStream;
  if (!activeStream) return;
  elements.sendButton.disabled = true;
  try {
    await api(
      `/api/sessions/${encodeURIComponent(activeStream.sessionId)}/abort`,
      decodeAbortResponse,
      { method: "POST", body: "{}" },
    );
  } catch (error) {
    showToast(messageFromUnknown(error));
  } finally {
    elements.sendButton.disabled = false;
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
      elements.guardCopy.textContent = "只读 SQL、当前时间与禁网 Python 沙箱";
    } else {
      elements.guardTitle.textContent = "代码解释器不可用";
      elements.guardCopy.textContent = health.agent.codeInterpreter.reason ?? "当前仅启用只读 SQL 与当前时间";
    }
    renderSchema(schema.objects);
    state.sessions = sessionPayload.sessions;
    renderSessions();

    const requestedId = new URLSearchParams(location.hash.slice(1)).get("session");
    const initialId = requestedId || state.sessions[0]?.id;
    if (initialId) await loadSession(initialId);
  } catch (error) {
    showToast(`初始化失败：${messageFromUnknown(error)}`);
    elements.modelBadge.textContent = "服务不可用";
    elements.modelBadge.classList.add("warning");
  }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.activeStream) void abortAnswer();
  else void submitQuestion(elements.input.value).catch((error) => showToast(messageFromUnknown(error)));
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.newChatButton.addEventListener("click", () => {
  void createSession().catch((error) => showToast(messageFromUnknown(error)));
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
elements.menuButton.addEventListener("click", () => {
  elements.sidebar.classList.add("open");
  elements.sidebarScrim.classList.add("open");
});
elements.sidebarScrim.addEventListener("click", closeSidebar);

void initialize();
