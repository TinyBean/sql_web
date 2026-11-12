import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { AgentSessionStore } from "../../src/server/agent/agent-sessions.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import { AppDatabase } from "../../src/server/database/database.ts";
import { createWebServer } from "../../src/server/http-server.ts";
import { Authentication } from "../../src/server/auth.ts";
import { ArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { XLSX_CONTENT_TYPE } from "../../src/server/tool/export-files.ts";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("chat activates xlsx, exports OEE query results, downloads under authentication and restores links", { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "xlsx-chat-test-"));
  const modelErrors: unknown[] = [];
  const steps = new Map<string, number>();
  let uploadedId = "";
  const skillPath = (name: string) => fileURLToPath(new URL(`../../src/server/skills/${name}/SKILL.md`, import.meta.url));
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const user = JSON.stringify(body.messages.findLast((message: { role: string }) => message.role === "user")?.content);
      const step = steps.get(user) ?? 0;
      steps.set(user, step + 1);
      const anonymous = user.includes("匿名");
      const editing = user.includes("修改上传");
      if (editing) assert.ok(JSON.stringify(body.messages).includes(uploadedId), "selected file must be in model context");
      const actions = editing ? [
        { name: "read", args: { path: skillPath("xlsx") } },
        { name: "xlsx__list_files", args: {} },
        { name: "xlsx__inspect", args: { file_id: uploadedId, sheet: "数据", range: "A1:B3" } },
        { name: "xlsx__edit", args: { file_id: uploadedId, operations: [
          { type: "fill", sheet: "数据", range: "A2:A3", value: "已核对" },
          { type: "format", sheet: "数据", range: "A1:B1", style: { bold: true, fill_color: "EEEEEE" } },
        ] } },
      ] : anonymous ? [
        { name: "read", args: { path: skillPath("xlsx") } },
        { name: "xlsx__export", args: { snapshot: "oee-export" } },
      ] : [
        { name: "read", args: { path: skillPath("test-oee-calculator") } },
        { name: "read", args: { path: path.join(path.dirname(skillPath("test-oee-calculator")), "references/database.md") } },
        { name: "execute_sql", args: { sql: "SELECT tool_name AS machine, SUM(time_span) AS running_seconds FROM oee_availability WHERE date='2026-11-12' AND final_state='Machine_Running' GROUP BY tool_name ORDER BY tool_name", save_as: "oee-export", limit: 1 } },
        { name: "read", args: { path: skillPath("xlsx") } },
        { name: "xlsx__export", args: { snapshot: "oee-export", filename: "机台运行时长.xlsx", description: "2026-11-12，各机台 Machine_Running 秒数" } },
      ];
      const action = actions[step];
      let text = "";
      if (action) assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === action.name));
      else {
        const last = body.messages.findLast((message: { role: string }) => message.role === "tool");
        if (anonymous) {
          assert.match(JSON.stringify(last), /仅支持持久化网页主会话/u);
          text = "匿名接口不支持 Excel 下载，请在网页聊天中导出。";
        } else {
          const result = JSON.parse(last.content);
          if (editing) {
            assert.equal(result.metrics.value_cells, 2);
            text = `${result.summary}[下载修改版](${result.download_url})`;
          } else {
          assert.equal(result.row_count, 30);
          text = `已导出 30 台机台的运行时长。[下载机台运行时长.xlsx](${result.download_url})`;
          }
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: " + JSON.stringify({ id: "xlsx", choices: [{ index: 0, delta: { role: "assistant", content: text,
        ...(action ? { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : {}) }, finish_reason: null }] }) +
        "\n\ndata: " + JSON.stringify({ id: "xlsx", choices: [{ index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "\n\ndata: [DONE]\n\n");
    } catch (error) { modelErrors.push(error); response.writeHead(500); response.end("test model failed"); }
  });
  const modelUrl = await listen(model);
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { test: { baseUrl: modelUrl + "/v1", api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test", name: "Test", reasoning: false, contextWindow: 128000, maxTokens: 8192 }] } } }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const databasePath = path.join(root, "oee.sqlite");
  initializeOeeDatabase(databasePath);
  const writer = new DatabaseSync(databasePath);
  const insert = writer.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,'Machine_Running','5000','2026-11-12',?)");
  for (let i = 0; i < 30; i++) insert.run(`MT-${String(i).padStart(3, "0")}`, `LOT-${i}`, 3600 + i);
  writer.close();
  const database = AppDatabase.open({ filePath: databasePath });
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const stores: AgentSessionStore[] = [];
  const openStore = async () => {
    const interpreter = await CodeInterpreterRuntime.create({ projectRoot: process.cwd(), pythonPath: "/usr/bin/python3", bwrapPath: "/usr/bin/bwrap", prlimitPath: "/usr/bin/prlimit" });
    const store = await AgentSessionStore.open({ cwd: root, database, artifacts, codeInterpreter: interpreter, agentDir, sessionDir: path.join(root, "sessions"),
      model: { provider: "test", model: "test" }, loadInitialDashboard: () => createDefaultDashboard() });
    stores.push(store);
    return store;
  };
  let store = await openStore();
  const authentication = new Authentication({ verify: async () => true });
  const servers: Server[] = [];
  const openServer = async () => {
    const server = createWebServer({ database, sessions: store, authentication, publicDir: path.join(process.cwd(), "public"), vendorDir: path.join(process.cwd(), "node_modules"), logger: { info() {}, error() {} } });
    servers.push(server);
    return listen(server);
  };
  let base = await openServer();
  t.after(async () => {
    for (const server of servers) await close(server);
    for (const item of stores) await item.dispose();
    await close(model);
    database.close(); rmSync(root, { recursive: true, force: true });
    assert.deepEqual(modelErrors, []);
  });
  const post = (route: string, body: unknown, cookie = "") => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const login = async (account: string) => (await post("/api/auth/login", { account, password: "test" })).headers.get("set-cookie")!.split(";")[0]!;
  const alice = await login("alice");
  const bob = await login("bob");
  const session = await (await post("/api/sessions", {}, alice)).json();
  const response = await post(`/api/sessions/${session.id}/messages`, { message: "导出 2026-11-12 各机台运行时长为 Excel", dashboardId: "default" }, alice);
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(stream, /event: error/u);
  const completed = await (await fetch(base + `/api/sessions/${session.id}`, { headers: { Cookie: alice } })).json();
  const text = completed.messages.at(-1).text;
  const link = /\]\((\/api\/sessions\/[^)]+)\)/u.exec(text)?.[1];
  assert.ok(link, text);
  assert.deepEqual(completed.dashboards, session.dashboards, "export must not change the dashboard");
  const download = await fetch(base + link, { headers: { Cookie: alice } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), XLSX_CONTENT_TYPE);
  assert.match(download.headers.get("content-disposition")!, /filename\*=UTF-8''/u);
  assert.equal(download.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await download.arrayBuffer());
  const fileId = link.split("/").at(-1)!;
  assert.deepEqual(bytes, readFileSync(path.join(artifacts.rootDir, session.id, "exports", fileId, "workbook.xlsx")));
  assert.equal((await fetch(base + link)).status, 401);
  assert.equal((await fetch(base + link, { headers: { Cookie: bob } })).status, 404);
  assert.equal((await fetch(base + link.replace(fileId, "..%2Fmetadata.json"), { headers: { Cookie: alice } })).status, 404);
  assert.equal((await fetch(base + link.replace(fileId, "00000000-0000-4000-8000-000000000000"), { headers: { Cookie: alice } })).status, 404);
  const upload = (cookie: string, payload: Buffer = bytes, filename = "上传中文.xlsx") => fetch(base + `/api/sessions/${session.id}/files`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": XLSX_CONTENT_TYPE, "X-Filename": encodeURIComponent(filename) }, body: new Uint8Array(payload),
  });
  assert.equal((await upload("")).status, 401);
  assert.equal((await upload(bob)).status, 404);
  assert.equal((await upload(alice, bytes, "macro.xlsm")).status, 400);
  assert.equal((await upload(alice, Buffer.from("not an xlsx"))).status, 400);
  assert.equal((await upload(alice, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
  const uploadedResponse = await upload(alice);
  assert.equal(uploadedResponse.status, 201, await uploadedResponse.clone().text());
  const uploaded = await uploadedResponse.json();
  uploadedId = uploaded.id;
  assert.equal(uploaded.kind, "upload");
  const beforeEdit = await (await fetch(base + uploaded.downloadUrl, { headers: { Cookie: alice } })).arrayBuffer();
  assert.deepEqual(Buffer.from(beforeEdit), bytes);
  await assert.rejects(store.forAccount("alice").prompt(session.id, " ", undefined, "default", uploadedId), /不能为空/u);
  assert.ok(!(await store.forAccount("alice").getSerialized(session.id)).messages.some((message) => message.attachmentFileId));
  const editing = await post(`/api/sessions/${session.id}/messages`, { message: "修改上传 Excel，将数据页 A2:A3 填为已核对，表头加粗并加底色", dashboardId: "default", fileId: uploadedId }, alice);
  const editStream = await editing.text();
  assert.doesNotMatch(editStream, /event: error/u, editStream);
  const afterEdit = await (await fetch(base + `/api/sessions/${session.id}`, { headers: { Cookie: alice } })).json();
  assert.equal(afterEdit.files.length, 3);
  const edited = afterEdit.files.find((file: { kind: string }) => file.kind === "edit");
  assert.equal(edited.parentFileId, uploadedId);
  assert.match(edited.summary, /数据!A2:A3/u);
  assert.match(afterEdit.messages.at(-1).text, /下载修改版/u);
  assert.equal(afterEdit.messages.filter((message: { attachmentFileId?: string }) => message.attachmentFileId === uploadedId).length, 1);
  assert.equal(afterEdit.messages.at(-2).attachmentFileId, uploadedId);
  assert.deepEqual(afterEdit.dashboards, session.dashboards);
  assert.equal((await fetch(base + edited.downloadUrl, { headers: { Cookie: bob } })).status, 404);
  assert.deepEqual(Buffer.from(await (await fetch(base + uploaded.downloadUrl, { headers: { Cookie: alice } })).arrayBuffer()), bytes);
  const changedBytes = Buffer.from(await (await fetch(base + edited.downloadUrl, { headers: { Cookie: alice } })).arrayBuffer());
  assert.notDeepEqual(changedBytes, bytes);
  const followUp = await post(`/api/sessions/${session.id}/messages`, { message: "修改上传 Excel，将数据页 A2:A3 填为已核对，表头加粗并加底色", dashboardId: "default", fileId: uploadedId }, alice);
  assert.doesNotMatch(await followUp.text(), /event: error/u);
  const afterFollowUp = await (await fetch(base + `/api/sessions/${session.id}`, { headers: { Cookie: alice } })).json();
  assert.equal(afterFollowUp.messages.filter((message: { attachmentFileId?: string }) => message.attachmentFileId === uploadedId).length, 1);
  const uploadOnly = await (await post("/api/sessions", {}, alice)).json();
  const uploadOnlyResponse = await fetch(base + `/api/sessions/${uploadOnly.id}/files`, { method: "POST",
    headers: { Cookie: alice, "Content-Type": XLSX_CONTENT_TYPE, "X-Filename": encodeURIComponent("仅上传.xlsx") }, body: new Uint8Array(bytes) });
  assert.equal(uploadOnlyResponse.status, 201);
  const uploadOnlyFile = await uploadOnlyResponse.json();
  const listing = await (await fetch(base + "/api/sessions", { headers: { Cookie: alice } })).json();
  assert.equal(listing.sessions.find((item: {id: string}) => item.id === uploadOnly.id).fileCount, 1);
  await store.dispose();
  store = await openStore();
  base = await openServer();
  const restored = await fetch(base + link, { headers: { Cookie: alice } });
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
  const restoredUploadOnly = await (await fetch(base + `/api/sessions/${uploadOnly.id}`, { headers: { Cookie: alice } })).json();
  assert.equal(restoredUploadOnly.messages.length, 0);
  assert.equal(restoredUploadOnly.files[0].id, uploadOnlyFile.id);
  assert.equal(restoredUploadOnly.title, "仅上传.xlsx");
  const restoredSession = await (await fetch(base + `/api/sessions/${session.id}`, { headers: { Cookie: alice } })).json();
  assert.deepEqual(restoredSession.files, afterEdit.files);
  assert.deepEqual(restoredSession.messages, afterFollowUp.messages);
  assert.deepEqual(Buffer.from(await (await fetch(base + edited.downloadUrl, { headers: { Cookie: alice } })).arrayBuffer()), changedBytes);
  const anonymous = await post("/chat/compeletion", { text: "匿名导出 Excel" });
  assert.equal(anonymous.status, 200);
  assert.match((await anonymous.json()).text, /不支持 Excel 下载/u);
  const removed = await fetch(base + `/api/sessions/${session.id}`, { method: "DELETE", headers: { Cookie: alice } });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(base + link, { headers: { Cookie: alice } })).status, 404);
  assert.equal((await fetch(base + uploaded.downloadUrl, { headers: { Cookie: alice } })).status, 404);
  assert.equal((await fetch(base + edited.downloadUrl, { headers: { Cookie: alice } })).status, 404);
});
