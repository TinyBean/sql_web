/// <reference lib="dom" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import type { MessageRequest, SerializedSession, SessionFile } from "../../src/shared/contracts.ts";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
const original: SessionFile = { id: "11111111-1111-4111-8111-111111111111", filename: "原表.xlsx", byteCount: 100, createdAt: "2026-11-12T01:00:00Z", kind: "upload",
  downloadUrl: "/api/sessions/session-excel/files/11111111-1111-4111-8111-111111111111" };
const edited: SessionFile = { ...original, id: "22222222-2222-4222-8222-222222222222", filename: "原表_修改.xlsx", createdAt: "2026-11-12T01:01:00Z", kind: "edit",
  parentFileId: original.id, summary: "已写入 1 个单元格。\n数据!A2：写入", downloadUrl: "/api/sessions/session-excel/files/22222222-2222-4222-8222-222222222222" };
let harnessId = 0;

async function harness(t: TestContext, restored?: SerializedSession) {
  const browser = parseHTML(readFileSync(path.join(process.cwd(), "public/index.html"), "utf8"));
  const { document } = browser;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const location = { hash: "#session=session-excel", pathname: "/", search: "" };
  expose("document", document); expose("window", browser); expose("location", location);
  expose("history", { replaceState(_state: unknown, _title: string, url: string) { location.hash = url; } });
  for (const name of ["Element", "HTMLElement", "HTMLButtonElement", "HTMLDivElement", "HTMLDetailsElement", "SVGSVGElement", "HTMLInputElement"] as const) expose(name, browser[name]);
  expose("HTMLFormElement", document.querySelector("#composer")!.constructor);
  expose("HTMLTextAreaElement", document.querySelector("#questionInput")!.constructor);
  const input = document.querySelector("#questionInput") as unknown as HTMLTextAreaElement;
  const uploadButton = document.querySelector("#uploadWorkbookButton") as unknown as HTMLButtonElement;
  const pending = document.querySelector("#pendingWorkbook")!;
  const toast = document.querySelector("#toast")!;
  let session: SerializedSession = restored ?? { id: "session-excel", title: "Excel 会话", ownerAccount: "alice", readOnly: false, dashboardIds: ["default"],
    model: null, tools: [], streaming: false, messages: [], files: [],
    dashboards: [{ id: "default", title: "看板", state: { schemaVersion: 1, revision: 0, dataAsOf: "2026-11-12T00:00:00Z", dateRange: { start: null, end: null }, widgets: [] } }] };
  const other: SerializedSession = { ...session, id: "other-session", title: "其他会话", files: [], messages: [{ id: "other-user", role: "user", text: "历史问题" }] };
  const requests: MessageRequest[] = [];
  const options = { uploadFile: original, rejectUpload: false, mode: "success" as "success" | "reject" | "accepted-error", failLoads: false, addEdited: true };
  let uploads = 0;
  let finish: (() => void) | undefined;
  expose("fetch", async (urlInput: string | URL | Request, init: RequestInit = {}) => {
    const url = String(urlInput);
    if (url === "/api/auth/me") return json({ account: "alice", dashboardIds: ["default"], expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (url === "/api/auth/logout") return json({ ok: true });
    if (url === "/api/sessions") return json({ sessions: [session, other].map((value) => ({ id: value.id, title: value.title, ownerAccount: "alice", readOnly: false, dashboardIds: ["default"], createdAt: original.createdAt, updatedAt: original.createdAt, messageCount: value.messages.length, fileCount: value.files?.length ?? 0, active: false })) });
    if (url === "/api/sessions/session-excel") {
      if (options.failLoads) throw new Error("网络不可用");
      return json(session);
    }
    if (url === "/api/sessions/other-session") return json(other);
    if (url === "/api/sessions/session-excel/files") {
      uploads++;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("X-Filename"), encodeURIComponent(options.uploadFile.filename));
      assert.equal(headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.ok(init.body instanceof File);
      if (options.rejectUpload) return json({ error: "上传失败", requestId: "upload-test" }, 400);
      session = { ...session, files: [...session.files ?? [], options.uploadFile] };
      return json(options.uploadFile, 201);
    }
    if (url === "/api/sessions/session-excel/messages") {
      const body = JSON.parse(init.body as string) as MessageRequest;
      requests.push(body);
      if (options.mode === "reject") return json({ error: "消息拒绝", requestId: "send-test" }, 503);
      const attach = session.files?.some((file) => file.id === body.fileId && file.kind === "upload") &&
        !session.messages.some((message) => message.attachmentFileId === body.fileId);
      session = { ...session, streaming: true, messages: [...session.messages,
        { id: `user-${requests.length}`, role: "user", text: body.message, ...(attach ? { attachmentFileId: body.fileId! } : {}) },
      ] };
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        finish = () => {
          finish = undefined;
          session = { ...session, streaming: false };
          if (options.mode === "accepted-error") {
            controller.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"回答中断"}\n\n'));
          } else {
            session = { ...session, files: options.addEdited ? [original, edited] : session.files!, messages: [...session.messages,
              { id: `assistant-${requests.length}`, role: "assistant", text: `已修改。[下载修改版](${edited.downloadUrl})` },
            ] };
            controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify(session)}\n\n`));
          }
          controller.close();
        };
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  t.after(async () => {
    (document.querySelector("#logoutButton") as unknown as HTMLButtonElement).click();
    await waitFor(() => document.body.classList.contains("signed-out"), "logout did not finish");
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const compiled = import.meta.url.endsWith(".js");
  await import(pathToFileURL(path.join(process.cwd(), compiled ? "public/generated/client/app.js" : "src/client/app.ts")).href + `?xlsx-${++harnessId}`);
  await waitFor(() => document.querySelector("#chatTitle")!.textContent.includes("Excel 会话"), "session not loaded");
  return {
    document, input, pending, toast, options, requests, uploadButton,
    get session() { return session; }, get uploads() { return uploads; },
    fileLinks: () => Array.from(document.querySelectorAll(".message.user.message-file a")),
    upload(file = new File(["test"], options.uploadFile.filename)) {
      const fileInput = document.querySelector("#workbookInput")!;
      Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
      fileInput.dispatchEvent(new browser.Event("change", { bubbles: true }));
    },
    submit(message: string) {
      input.value = message;
      document.querySelector("#composer")!.dispatchEvent(new browser.Event("submit", { cancelable: true, bubbles: true }));
    },
    async finish() {
      await waitFor(() => !!finish, "message not submitted");
      finish!();
      await waitFor(() => !document.querySelector("#sendButton")!.classList.contains("streaming"), "answer not finished");
    },
    async switchTo(id: string) {
      (document.querySelector(`[data-session-id="${id}"]`) as unknown as HTMLButtonElement).click();
      await waitFor(() => location.hash.includes(id), "session not loaded");
    },
  };
}

test("uploads show pending names, then a separate right-side file message; follow-ups use the edited file and history restores links", async (t) => {
  const h = await harness(t);
  assert.equal(h.document.querySelector("#workbookSelect"), null);
  assert.equal(h.document.querySelector("#workbookFiles"), null);
  h.upload(new File(["bad"], "bad.xlsm"));
  await waitFor(() => h.toast.textContent.includes("xlsx"), "invalid extension not reported");
  assert.equal(h.uploads, 0);
  h.upload();
  await waitFor(() => h.pending.textContent === "待发送：原表.xlsx", "pending file not shown");
  assert.equal(h.pending.querySelector("a"), null);
  assert.equal(h.fileLinks().length, 0);
  assert.ok(h.document.querySelector('[data-session-id="session-excel"]'), "upload-only sessions must appear in history");
  h.submit("  ");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 0);
  await h.switchTo("other-session");
  assert.equal(h.pending.textContent, "");
  await h.switchTo("session-excel");
  assert.equal(h.pending.textContent, "待发送：原表.xlsx");
  h.submit("把数据页 A2 改为 0007");
  await waitFor(() => h.requests.length === 1, "message not submitted");
  assert.equal(h.requests[0]!.fileId, original.id);
  assert.equal(h.uploadButton.disabled, true);
  assert.equal(h.pending.textContent, "");
  const messages = h.document.querySelectorAll(".message");
  assert.ok(messages[0]!.classList.contains("user"));
  assert.ok(messages[0]!.classList.contains("message-file"));
  assert.equal(messages[1]!.textContent, "DataLens把数据页 A2 改为 0007");
  assert.ok(messages[2]!.classList.contains("assistant"));
  assert.equal(h.fileLinks()[0]!.getAttribute("href"), original.downloadUrl);
  assert.equal(h.fileLinks()[0]!.getAttribute("download"), original.filename);
  await h.finish();
  assert.equal(h.fileLinks().length, 1);
  assert.equal(h.document.querySelector("#composer details"), null);
  h.submit("继续检查");
  await h.finish();
  assert.equal(h.requests[1]!.fileId, edited.id);
  assert.equal(h.fileLinks().length, 1);
  await h.switchTo("other-session");
  assert.equal(h.fileLinks().length, 0);
  await h.switchTo("session-excel");
  assert.equal(h.fileLinks().length, 1);
  assert.equal(h.fileLinks()[0]!.getAttribute("href"), original.downloadUrl);
  assert.equal(h.pending.textContent, "");
});

test("only the last successful upload is sent, failed uploads preserve it, and filenames are literal text", async (t) => {
  const h = await harness(t);
  h.options.addEdited = false;
  h.upload();
  await waitFor(() => !h.uploadButton.disabled && h.uploads === 1, "first upload not finished");
  const filename = `${"很长的文件名".repeat(15)} & [报表] <img src=x onerror=alert(1)>.xlsx`;
  h.options.uploadFile = { ...original, id: "33333333-3333-4333-8333-333333333333", filename,
    downloadUrl: "/api/sessions/session-excel/files/33333333-3333-4333-8333-333333333333" };
  h.upload();
  await waitFor(() => h.pending.textContent === `待发送：${filename}`, "latest pending file not shown");
  h.options.rejectUpload = true;
  h.upload();
  await waitFor(() => h.toast.textContent.includes("上传失败"), "failed upload not reported");
  assert.equal(h.pending.textContent, `待发送：${filename}`);
  h.submit("查看这个文件");
  await h.finish();
  assert.equal(h.requests[0]!.fileId, h.options.uploadFile.id);
  assert.equal(h.fileLinks().length, 1);
  assert.equal(h.fileLinks()[0]!.textContent, filename);
  assert.equal(h.fileLinks()[0]!.querySelector("img"), null);
});

test("rejected sends restore pending files and text; accepted sends retain one link even when the answer fails", async (t) => {
  const h = await harness(t);
  h.upload();
  await waitFor(() => !h.uploadButton.disabled && h.uploads === 1, "upload not finished");
  h.options.mode = "reject";
  h.submit("检查文件");
  await waitFor(() => h.requests.length === 1 && !h.uploadButton.disabled, "rejected send not reconciled");
  assert.equal(h.pending.textContent, "待发送：原表.xlsx");
  assert.equal(h.input.value, "检查文件");
  assert.equal(h.fileLinks().length, 0);
  assert.equal(h.document.querySelectorAll(".message").length, 0);
  h.options.mode = "accepted-error";
  h.submit("检查文件");
  await h.finish();
  assert.equal(h.pending.textContent, "");
  assert.equal(h.fileLinks().length, 1);
  h.options.mode = "success";
  h.submit("重新检查");
  await h.finish();
  assert.equal(h.fileLinks().length, 1);
  assert.equal(h.requests[2]!.fileId, original.id);
});

test("an unknown send result is reconciled before retrying, without duplicating the attachment", async (t) => {
  const h = await harness(t);
  h.upload();
  await waitFor(() => !h.uploadButton.disabled && h.uploads === 1, "upload not finished");
  h.options.mode = "accepted-error";
  h.options.failLoads = true;
  h.submit("检查文件");
  await h.finish();
  assert.match(h.toast.textContent, /无法确认发送状态/u);
  assert.equal(h.fileLinks().length, 1);
  h.submit("再试一次");
  await waitFor(() => h.toast.textContent.includes("网络不可用"), "unconfirmed retry not reported");
  assert.equal(h.requests.length, 1);
  h.options.failLoads = false;
  h.options.mode = "success";
  h.submit("再试一次");
  await h.finish();
  assert.equal(h.requests.length, 2);
  assert.equal(h.fileLinks().length, 1);
});

test("a fresh page restores attachment positions and the current version without inventing links for old messages", async (t) => {
  const restored: SerializedSession = { id: "session-excel", title: "Excel 会话", ownerAccount: "alice", readOnly: false, dashboardIds: ["default"],
    model: null, tools: [], streaming: false, files: [original, edited],
    messages: [
      { id: "old-user", role: "user", text: "原有消息" },
      { id: "user", role: "user", text: "修改文件", attachmentFileId: original.id },
      { id: "assistant", role: "assistant", text: "已修改" },
    ], dashboards: [{ id: "default", title: "看板", state: { schemaVersion: 1, revision: 0, dataAsOf: original.createdAt, dateRange: { start: null, end: null }, widgets: [] } }] };
  const h = await harness(t, restored);
  assert.equal(h.fileLinks().length, 1);
  assert.equal(h.document.querySelectorAll(".message")[1]!.querySelector("a")!.getAttribute("href"), original.downloadUrl);
  assert.equal(h.pending.textContent, "");
  h.submit("继续处理");
  await h.finish();
  assert.equal(h.requests[0]!.fileId, edited.id);
  assert.equal(h.fileLinks().length, 1);
});
