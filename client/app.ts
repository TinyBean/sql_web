import type {
  ChatMessage,
  ChatRole,
  HealthResponse,
  ParsedSseEvent,
  SchemaObject,
  SchemaResponse,
  SerializedSession,
  SessionsResponse,
  SessionSummary,
} from "../shared/contracts.js";

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`页面缺少必要元素：${selector}`);
  return element;
}

const elements = {
  sidebar: requiredElement<HTMLElement>("#sidebar"),
  sidebarScrim: requiredElement<HTMLElement>("#sidebarScrim"),
  menuButton: requiredElement<HTMLButtonElement>("#menuButton"),
  newChatButton: requiredElement<HTMLButtonElement>("#newChatButton"),
  sessionList: requiredElement<HTMLElement>("#sessionList"),
  messages: requiredElement<HTMLElement>("#messages"),
  welcome: requiredElement<HTMLElement>("#welcome"),
  composer: requiredElement<HTMLFormElement>("#composer"),
  input: requiredElement<HTMLTextAreaElement>("#questionInput"),
  sendButton: requiredElement<HTMLButtonElement>("#sendButton"),
  modelBadge: requiredElement<HTMLElement>("#modelBadge"),
  schemaButton: requiredElement<HTMLButtonElement>("#schemaButton"),
  schemaCloseButton: requiredElement<HTMLButtonElement>("#schemaCloseButton"),
  schemaPanel: requiredElement<HTMLElement>("#schemaPanel"),
  schemaList: requiredElement<HTMLElement>("#schemaList"),
  toast: requiredElement<HTMLElement>("#toast"),
};

interface StreamNode {
  article: HTMLElement;
  body: HTMLDivElement;
  text: HTMLDivElement;
  tools: HTMLDivElement;
  typing: HTMLDivElement | null;
}

interface ClientState {
  sessionId: string | null;
  sessions: SessionSummary[];
  streaming: boolean;
  streamNode: StreamNode | null;
  toastTimer: number | null;
}

const state: ClientState = {
  sessionId: null,
  sessions: [],
  streaming: false,
  streamNode: null,
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

function errorFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return undefined;
  return typeof payload.error === "string" ? payload.error : undefined;
}

async function api<ResponseBody>(path: string, options: RequestInit = {}): Promise<ResponseBody> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorFromPayload(payload) || `请求失败 (${response.status})`);
  return payload as ResponseBody;
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
    button.dataset.sessionId = session.id;
    button.append(
      createSvg([{ d: "M7 17.5 4 20v-4.5a8 8 0 1 1 3 2Z" }]),
      Object.assign(document.createElement("span"), { textContent: session.title || "新会话" }),
    );
    elements.sessionList.append(button);
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
  let stream = elements.messages.querySelector<HTMLElement>(".message-stream");
  if (!stream) {
    elements.welcome?.remove();
    stream = document.createElement("div");
    stream.className = "message-stream";
    elements.messages.append(stream);
  }
  return stream;
}

function appendMessage(role: ChatRole, text = "", streaming = false): StreamNode {
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
  const tools = document.createElement("div");
  tools.className = "tool-events";
  const messageText = document.createElement("div");
  messageText.className = "message-text";
  messageText.textContent = text;
  body.append(label, tools, messageText);
  if (streaming) {
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("aria-label", "正在思考");
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    body.append(typing);
  }
  article.append(avatar, body);
  ensureMessageStream().append(article);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return {
    article,
    body,
    text: messageText,
    tools,
    typing: body.querySelector<HTMLDivElement>(".typing"),
  };
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
  for (const message of messages) appendMessage(message.role, message.text);
}

function setStreaming(streaming: boolean): void {
  state.streaming = streaming;
  elements.sendButton.classList.toggle("streaming", streaming);
  elements.sendButton.setAttribute("aria-label", streaming ? "停止回答" : "发送问题");
  elements.input.disabled = streaming;
  elements.newChatButton.disabled = streaming;
}

function applySession(session: SerializedSession): void {
  state.sessionId = session.id;
  history.replaceState(null, "", `#session=${encodeURIComponent(session.id)}`);
  renderTranscript(session.messages || []);
  renderSessions();
  elements.input.focus();
}

async function refreshSessions(): Promise<void> {
  const payload = await api<SessionsResponse>("/api/sessions");
  state.sessions = payload.sessions;
  renderSessions();
}

async function createSession(): Promise<SerializedSession | undefined> {
  if (state.streaming) return;
  const session = await api<SerializedSession>("/api/sessions", { method: "POST", body: "{}" });
  await refreshSessions();
  applySession(session);
  closeSidebar();
  return session;
}

async function loadSession(id: string): Promise<void> {
  if (state.streaming || !id) return;
  const session = await api<SerializedSession>(`/api/sessions/${encodeURIComponent(id)}`);
  applySession(session);
  closeSidebar();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const data: unknown = JSON.parse(dataLines.join("\n"));
  if (!isRecord(data)) return null;

  if (event === "text_delta" && typeof data.delta === "string") {
    return { event, data: { delta: data.delta } };
  }
  if (
    event === "tool_start" &&
    typeof data.id === "string" &&
    typeof data.name === "string"
  ) {
    return { event, data: { id: data.id, name: data.name } };
  }
  if (
    event === "tool_end" &&
    typeof data.id === "string" &&
    typeof data.name === "string" &&
    typeof data.isError === "boolean"
  ) {
    return { event, data: { id: data.id, name: data.name, isError: data.isError } };
  }
  if ((event === "status" || event === "error") && typeof data.message === "string") {
    return { event, data: { message: data.message } };
  }
  if (
    event === "done" &&
    typeof data.id === "string" &&
    typeof data.title === "string" &&
    Array.isArray(data.messages)
  ) {
    return { event, data: data as unknown as SerializedSession };
  }
  return null;
}

function handleStreamEvent(
  parsed: Exclude<ParsedSseEvent, { event: "done" }>,
  node: StreamNode,
): void {
  if (parsed.event === "text_delta") {
    node.typing?.remove();
    node.typing = null;
    node.text.textContent += parsed.data.delta;
  } else if (parsed.event === "tool_start") {
    node.typing?.remove();
    node.typing = null;
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.dataset.toolId = parsed.data.id;
    chip.textContent = parsed.data.name === "query_database" ? "正在查询数据库" : "正在修改数据库";
    node.tools.append(chip);
  } else if (parsed.event === "tool_end") {
    const chip = node.tools.querySelector<HTMLElement>(
      `[data-tool-id="${CSS.escape(parsed.data.id)}"]`,
    );
    if (chip) {
      chip.classList.add(parsed.data.isError ? "error" : "done");
      chip.textContent = parsed.data.isError ? "数据库操作失败" : "数据库操作完成";
    }
  } else if (parsed.event === "status") {
    showToast(parsed.data.message);
  } else if (parsed.event === "error") {
    node.typing?.remove();
    node.typing = null;
    const error = document.createElement("div");
    error.className = "message-error";
    error.textContent = parsed.data.message;
    node.body.append(error);
    showToast(parsed.data.message);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function streamQuestion(message: string): Promise<SerializedSession | null> {
  const sessionId = state.sessionId;
  if (!sessionId) throw new Error("尚未创建会话");
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    throw new Error(errorFromPayload(payload) || `请求失败 (${response.status})`);
  }
  if (!response.body) throw new Error("浏览器不支持流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedSession: SerializedSession | null = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event === "done") completedSession = parsed.data;
      else if (state.streamNode) handleStreamEvent(parsed, state.streamNode);
    }
    if (done) break;
  }
  return completedSession;
}

async function submitQuestion(question: string): Promise<void> {
  const message = question.trim();
  if (!message || state.streaming) return;
  if (!state.sessionId) await createSession();
  elements.input.value = "";
  appendMessage("user", message);
  const streamNode = appendMessage("assistant", "", true);
  state.streamNode = streamNode;
  setStreaming(true);

  try {
    const completed = await streamQuestion(message);
    streamNode.typing?.remove();
    if (completed) {
      state.sessionId = completed.id;
      await refreshSessions();
    }
  } catch (error) {
    handleStreamEvent(
      { event: "error", data: { message: messageFromUnknown(error, "回答失败") } },
      streamNode,
    );
  } finally {
    setStreaming(false);
    state.streamNode = null;
    elements.input.focus();
  }
}

async function abortAnswer(): Promise<void> {
  if (!state.streaming || !state.sessionId) return;
  elements.sendButton.disabled = true;
  try {
    await api<{ ok: true }>(`/api/sessions/${encodeURIComponent(state.sessionId)}/abort`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    showToast(messageFromUnknown(error));
  } finally {
    elements.sendButton.disabled = false;
  }
}

async function initialize(): Promise<void> {
  try {
    const [health, schema, sessionPayload] = await Promise.all([
      api<HealthResponse>("/api/health"),
      api<SchemaResponse>("/api/schema"),
      api<SessionsResponse>("/api/sessions"),
    ]);
    const model = health.agent.model;
    if (model.provider && model.model) {
      elements.modelBadge.textContent = `${model.provider}/${model.model}`;
    } else {
      elements.modelBadge.textContent = "请先在 pi 中选择模型";
      elements.modelBadge.classList.add("warning");
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
  if (state.streaming) void abortAnswer();
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
  const button = event.target.closest<HTMLElement>("[data-session-id]");
  const sessionId = button?.dataset.sessionId;
  if (sessionId) {
    void loadSession(sessionId).catch((error) => showToast(messageFromUnknown(error)));
  }
});
elements.messages.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>("[data-question]");
  const question = button?.dataset.question;
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
