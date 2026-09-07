/// <reference lib="dom" />

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import {
  exportSessionHtml,
  resolveSessionFile,
  type SessionHtmlData,
} from "../../scripts/session-to-html.ts";

const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

function jsonLines(entries: readonly unknown[], trailingLineFeed = true): string {
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return trailingLineFeed ? `${content}\n` : content;
}

function embeddedSessionData(html: string): SessionHtmlData {
  const encoded = /<script\b[^>]*\bid="session-data"[^>]*>([A-Za-z0-9+/=]+)<\/script>/u
    .exec(html)?.[1];
  assert.ok(encoded, "expected a base64-encoded session-data script");
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as SessionHtmlData;
}

function embeddedRuntimeSource(html: string): string {
  const encoded = /<script\b[^>]*\bid="viewer-runtime"[^>]*>([A-Za-z0-9+/=]+)<\/script>/u
    .exec(html)?.[1];
  assert.ok(encoded, "expected a base64-encoded viewer-runtime script");
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u);
  return Buffer.from(encoded, "base64").toString("utf8");
}

function assertSafeRuntimeEnvelope(html: string): string {
  const { document } = parseHTML(html);
  assert.deepEqual(
    [...document.body.children].map((child) => child.localName),
    ["main", "dialog", "script", "script", "script"],
  );
  assert.deepEqual(
    [...document.body.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean),
    [],
  );
  assert.equal(html.match(/<script(?=[\t\n\f\r />])/giu)?.length, 3);
  assert.equal(html.match(/<\/script(?=[\t\n\f\r />])/giu)?.length, 3);
  assert.equal(html.match(/<\/style(?=[\t\n\f\r />])/giu)?.length, 1);
  assert.doesNotMatch(html, /@license DOMPurify/u);
  const runtime = embeddedRuntimeSource(html);
  assert.match(runtime, /@license DOMPurify/u);
  assert.match(runtime, /details\.images/u);
  return runtime;
}

interface ExecutedViewer {
  readonly document: Document;
  readonly dynamicScripts: readonly HTMLScriptElement[];
}

function executeViewer(html: string): ExecutedViewer {
  const { window, document } = parseHTML(html);
  for (const id of ["branch-select", "view-select"]) {
    const select = document.getElementById(id);
    assert.ok(select);
    let value = id === "view-select" ? "diagnostic-all" : "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => value,
      set: (next: unknown) => { value = String(next); },
    });
  }
  const sandbox = window as unknown as Record<string, unknown>;
  Object.assign(sandbox, {
    window,
    self: window,
    globalThis: window,
    document,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    console,
    Map,
    Set,
    Uint8Array,
    JSON,
    Date,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    decodeURIComponent,
    encodeURIComponent,
  });
  const context = vm.createContext(sandbox);
  const dynamicScripts: HTMLScriptElement[] = [];
  let scriptIndex = 0;
  const runScript = (script: HTMLScriptElement): void => {
    const previous = Object.getOwnPropertyDescriptor(document, "currentScript");
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      value: script,
    });
    try {
      const filename = `session-viewer-${scriptIndex}.js`;
      scriptIndex += 1;
      vm.runInContext(script.textContent, context, { filename });
    } finally {
      if (previous) Object.defineProperty(document, "currentScript", previous);
      else Reflect.deleteProperty(document, "currentScript");
    }
  };
  const appendChild = document.head.appendChild.bind(document.head);
  Object.defineProperty(document.head, "appendChild", {
    configurable: true,
    value(node: Node): Node {
      const result = appendChild(node);
      if (node.nodeType === 1 && (node as Element).localName === "script") {
        const script = node as HTMLScriptElement;
        dynamicScripts.push(script);
        runScript(script);
      }
      return result;
    },
  });
  const bootstrap = document.querySelector<HTMLScriptElement>("#viewer-bootstrap");
  assert.ok(bootstrap, "expected the executable viewer bootstrap");
  runScript(bootstrap);
  return {
    document: document as unknown as Document,
    dynamicScripts,
  };
}

function temporaryDirectory(t: test.TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("exports a legacy snapshot without changing source bytes or adding a trailing line feed", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-readonly-");
  const sourcePath = path.join(
    directory,
    "2026-09-07T00-00-00-000Z_readonly-session.jsonl",
  );
  const outputPath = path.join(directory, "readonly-session.html");
  const source = jsonLines([
    {
      type: "session",
      version: 2,
      id: "readonly-session",
      timestamp: "2026-09-07T00:00:00.000Z",
      cwd: "/persisted/project",
    },
    {
      type: "message",
      id: "user-001",
      parentId: null,
      timestamp: "2026-09-07T00:00:01.000Z",
      message: { role: "user", content: "没有结尾换行", timestamp: 1 },
    },
    {
      type: "message",
      id: "answer01",
      parentId: "user-001",
      timestamp: "2026-09-07T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已读取。" }],
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ], false);
  assert.equal(source.endsWith("\n"), false);
  writeFileSync(sourcePath, source);
  const before = readFileSync(sourcePath);

  assert.equal(exportSessionHtml({
    input: sourcePath,
    outputPath,
    sessionDir: directory,
    now: new Date("2026-09-07T12:00:00.000Z"),
  }), outputPath);

  assert.deepEqual(readFileSync(sourcePath), before);
  assert.equal(readFileSync(sourcePath, "utf8").endsWith("\n"), false);
  const embedded = embeddedSessionData(readFileSync(outputPath, "utf8"));
  assert.equal(embedded.header.version, 3);
  assert.equal(embedded.branches[0]?.messages[0]?.text, "没有结尾换行");
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});

test("embeds every diagnostic branch with thinking, tool results, custom data, and images", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-diagnostic-");
  const sourcePath = path.join(directory, "diagnostic-session.jsonl");
  const outputPath = path.join(directory, "diagnostic-session.html");
  const dangerousTitle = "</script><script id=x>x()</script>";
  writeFileSync(sourcePath, jsonLines([
    {
      type: "session",
      version: 3,
      id: "diagnostic-session",
      timestamp: "2026-09-07T01:00:00.000Z",
      cwd: "/persisted/project",
    },
    {
      type: "message",
      id: "rootuser",
      parentId: null,
      timestamp: "2026-09-07T01:00:01.000Z",
      message: { role: "user", content: "根问题", timestamp: 10 },
    },
    {
      type: "message",
      id: "toolcall",
      parentId: "rootuser",
      timestamp: "2026-09-07T01:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "完整的内部 thinking" },
          { type: "text", text: "先运行诊断工具。" },
          {
            type: "toolCall",
            id: "code-call-1",
            name: "code_interpreter",
            arguments: { code: "print('raw diagnostic')" },
          },
        ],
        stopReason: "toolUse",
        timestamp: 11,
      },
    },
    {
      type: "message",
      id: "toolres1",
      parentId: "toolcall",
      timestamp: "2026-09-07T01:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "code-call-1",
        toolName: "code_interpreter",
        content: [{ type: "text", text: "原始工具结果" }],
        details: {
          kind: "code_interpreter",
          stdout: "raw stdout",
          images: [{ mimeType: "image/png", data: PNG_BASE64, alt: "诊断图片" }],
        },
        isError: false,
        timestamp: 12,
      },
    },
    {
      type: "message",
      id: "answer01",
      parentId: "toolres1",
      timestamp: "2026-09-07T01:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "诊断完成。" }],
        stopReason: "stop",
        timestamp: 13,
      },
    },
    {
      type: "session_info",
      id: "name0001",
      parentId: "answer01",
      timestamp: "2026-09-07T01:00:05.000Z",
      name: dangerousTitle,
    },
    {
      type: "custom",
      id: "custom01",
      parentId: "name0001",
      timestamp: "2026-09-07T01:00:06.000Z",
      customType: "sql_web.skill.loaded",
      data: { skill: "test-oee-calculator", raw: "自定义诊断状态" },
    },
    {
      type: "branch_summary",
      id: "branch01",
      parentId: "rootuser",
      timestamp: "2026-09-07T01:00:07.000Z",
      fromId: "custom01",
      summary: "改走备用分支",
    },
    {
      type: "message",
      id: "altuser1",
      parentId: "branch01",
      timestamp: "2026-09-07T01:00:08.000Z",
      message: { role: "user", content: "备用问题", timestamp: 14 },
    },
    {
      type: "message",
      id: "altans01",
      parentId: "altuser1",
      timestamp: "2026-09-07T01:00:09.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "备用回答" }],
        stopReason: "stop",
        timestamp: 15,
      },
    },
  ]));

  exportSessionHtml({
    input: sourcePath,
    outputPath,
    sessionDir: directory,
    now: new Date("2026-09-07T12:00:00.000Z"),
  });
  const html = readFileSync(outputPath, "utf8");
  const embedded = embeddedSessionData(html);

  assert.equal(embedded.title, dangerousTitle);
  assert.equal(embedded.branches.length, 2);
  assert.deepEqual(embedded.entries.map((entry) => entry.id), [
    "rootuser",
    "toolcall",
    "toolres1",
    "answer01",
    "name0001",
    "custom01",
    "branch01",
    "altuser1",
    "altans01",
  ]);
  assert.equal(embedded.branches.filter((branch) => branch.current).length, 1);
  assert.equal(embedded.branches.find((branch) => branch.current)?.leafId, "altans01");
  const entriesById = new Map(embedded.entries.map((entry) => [entry.id, entry]));
  const diagnosticBranch = embedded.branches.find((branch) => branch.leafId === "custom01");
  assert.ok(diagnosticBranch);
  assert.deepEqual(
    diagnosticBranch.entryIds,
    ["rootuser", "toolcall", "toolres1", "answer01", "name0001", "custom01"],
  );

  const assistantEntry = entriesById.get("toolcall");
  assert.equal(assistantEntry?.type, "message");
  if (assistantEntry?.type !== "message") assert.fail("missing assistant diagnostic entry");
  assert.equal(assistantEntry.message.role, "assistant");
  if (assistantEntry.message.role !== "assistant") assert.fail("unexpected assistant role");
  assert.deepEqual(assistantEntry.message.content, [
    { type: "thinking", thinking: "完整的内部 thinking" },
    { type: "text", text: "先运行诊断工具。" },
    {
      type: "toolCall",
      id: "code-call-1",
      name: "code_interpreter",
      arguments: { code: "print('raw diagnostic')" },
    },
  ]);

  const toolResultEntry = entriesById.get("toolres1");
  assert.equal(toolResultEntry?.type, "message");
  if (toolResultEntry?.type !== "message") assert.fail("missing raw tool result entry");
  assert.equal(toolResultEntry.message.role, "toolResult");
  if (toolResultEntry.message.role !== "toolResult") assert.fail("unexpected tool result role");
  assert.equal(toolResultEntry.message.content[0]?.type, "text");
  assert.deepEqual(toolResultEntry.message.details, {
    kind: "code_interpreter",
    stdout: "raw stdout",
    images: [{ mimeType: "image/png", data: PNG_BASE64, alt: "诊断图片" }],
  });
  assert.deepEqual(
    diagnosticBranch.messages.find((message) => message.role === "assistant")?.images,
    [{ id: "ci:code-call-1:1", mimeType: "image/png", data: PNG_BASE64, alt: "诊断图片" }],
  );

  const customEntry = entriesById.get("custom01");
  assert.equal(customEntry?.type, "custom");
  if (customEntry?.type !== "custom") assert.fail("missing custom diagnostic entry");
  assert.deepEqual(customEntry.data, {
    skill: "test-oee-calculator",
    raw: "自定义诊断状态",
  });
  assert.equal(
    embedded.branches.find((branch) => branch.leafId === "altans01")?.entryIds
      .some((id) => entriesById.get(id)?.type === "branch_summary"),
    true,
  );

  assert.doesNotMatch(html, /<\/script><script id=x>x\(\)<\/script>/u);
  assert.match(html, /&lt;\/script&gt;&lt;script id=x&gt;x\(\)&lt;\/script&gt;/u);
  assertSafeRuntimeEnvelope(html);

  const { document, dynamicScripts } = executeViewer(html);
  const bootstrap = document.querySelector<HTMLScriptElement>("#viewer-bootstrap");
  assert.ok(bootstrap);
  assert.equal(dynamicScripts.length, 1);
  assert.equal(dynamicScripts[0]?.nonce, bootstrap.nonce);
  assert.equal(document.documentElement.dataset["sessionViewerReady"], "true");
  assert.equal(document.querySelectorAll(".timeline-entry").length, embedded.entries.length + 1);
  assert.match(document.querySelector(".diagnostic")?.textContent ?? "", /完整的内部 thinking/u);
  assert.match(document.querySelector(".diagnostic")?.textContent ?? "", /原始工具结果/u);
  assert.equal(document.querySelectorAll(".image-strip img").length, 1);
  assert.equal(document.querySelector("#x"), null);
});

test("keeps hostile persisted text inside the base64 data envelope", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-base64-");
  const sourcePath = path.join(directory, "hostile-session.jsonl");
  const outputPath = path.join(directory, "hostile-session.html");
  const injection = "</script><script id=session-payload-xss>globalThis.pwned=true</script>";
  writeFileSync(sourcePath, jsonLines([
    {
      type: "session",
      version: 3,
      id: "hostile-session",
      timestamp: "2026-09-07T02:00:00.000Z",
      cwd: "/persisted/project",
    },
    {
      type: "message",
      id: "hostuser",
      parentId: null,
      timestamp: "2026-09-07T02:00:01.000Z",
      message: { role: "user", content: injection, timestamp: 20 },
    },
    {
      type: "message",
      id: "hostans1",
      parentId: "hostuser",
      timestamp: "2026-09-07T02:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "安全回答" }],
        stopReason: "stop",
        timestamp: 21,
      },
    },
  ]));

  exportSessionHtml({ input: sourcePath, outputPath, sessionDir: directory });
  const html = readFileSync(outputPath, "utf8");
  assert.equal(html.includes(injection), false);
  assert.doesNotMatch(html, /<script id=session-payload-xss>/u);
  assert.match(
    html,
    /Content-Security-Policy[^>]+default-src 'none';[^>]+connect-src 'none'/u,
  );
  const embedded = embeddedSessionData(html);
  const userEntry = embedded.entries.find((entry) => entry.id === "hostuser");
  assert.equal(userEntry?.type, "message");
  if (userEntry?.type !== "message") assert.fail("missing hostile source entry");
  assert.equal(userEntry.message.role, "user");
  assert.equal(userEntry.message.content, injection);
});

test("keeps a concurrently written trailing fragment as a visible parse warning", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-partial-");
  const sourcePath = path.join(directory, "partial-session.jsonl");
  const outputPath = path.join(directory, "partial-session.html");
  const complete = jsonLines([
    {
      type: "session",
      version: 3,
      id: "partial-session",
      timestamp: "2026-09-07T03:00:00.000Z",
      cwd: "/persisted/project",
    },
    {
      type: "message",
      id: "partial1",
      parentId: null,
      timestamp: "2026-09-07T03:00:01.000Z",
      message: { role: "user", content: "已完整写入", timestamp: 30 },
    },
  ]);
  const source = `${complete}{"type":"message","id":"still-writing"`;
  writeFileSync(sourcePath, source);

  exportSessionHtml({ input: sourcePath, outputPath, sessionDir: directory });

  assert.equal(readFileSync(sourcePath, "utf8"), source);
  const html = readFileSync(outputPath, "utf8");
  const embedded = embeddedSessionData(html);
  assert.deepEqual(embedded.entries.map((entry) => entry.id), ["partial1"]);
  assert.deepEqual(embedded.warnings.map((warning) => ({
    line: warning.line,
    raw: warning.raw,
  })), [{
    line: 3,
    raw: "{\"type\":\"message\",\"id\":\"still-writing\"",
  }]);
  const { document } = executeViewer(html);
  assert.match(document.querySelector(".parse-warning")?.textContent ?? "", /解析警告/u);
});

test("rejects a malformed final record once its line feed has been persisted", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-malformed-");
  const sourcePath = path.join(directory, "malformed-session.jsonl");
  const outputPath = path.join(directory, "malformed-session.html");
  const header = jsonLines([{
    type: "session",
    version: 3,
    id: "malformed-session",
    timestamp: "2026-09-07T03:30:00.000Z",
    cwd: "/persisted/project",
  }]);
  writeFileSync(sourcePath, `${header}{bad}\n`);

  assert.throws(
    () => exportSessionHtml({ input: sourcePath, outputPath, sessionDir: directory }),
    /第 2 行/u,
  );
});

test("exports a header-only persisted session for diagnostics", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-header-");
  const sourcePath = path.join(directory, "header-session.jsonl");
  const outputPath = path.join(directory, "header-session.html");
  writeFileSync(sourcePath, jsonLines([{
    type: "session",
    version: 3,
    id: "header-session",
    timestamp: "2026-09-07T04:00:00.000Z",
    cwd: "/persisted/project",
  }]));

  exportSessionHtml({ input: sourcePath, outputPath, sessionDir: directory });

  const html = readFileSync(outputPath, "utf8");
  const embedded = embeddedSessionData(html);
  assert.deepEqual(embedded.entries, []);
  assert.deepEqual(embedded.branches[0]?.entryIds, []);
  assert.equal(embedded.branches[0]?.current, true);
  const { document } = executeViewer(html);
  assert.equal(document.querySelectorAll(".timeline-entry").length, 1);
  assert.match(document.querySelector(".timeline-entry")?.textContent ?? "", /header-session/u);
});

test("resolves an exact session ID and selects latest from JSONL modification times", (t) => {
  const directory = temporaryDirectory(t, "sql-web-session-html-resolve-");
  const olderId = "session-old-1234";
  const newerId = "session-new-5678";
  const olderPath = path.join(directory, `2026-09-06T00-00-00-000Z_${olderId}.jsonl`);
  const newerPath = path.join(directory, `2026-09-07T00-00-00-000Z_${newerId}.jsonl`);
  const ignoredPath = path.join(directory, "newest-but-not-session.html");
  writeFileSync(olderPath, "{}\n");
  writeFileSync(newerPath, "{}\n");
  writeFileSync(ignoredPath, "not a session");
  utimesSync(olderPath, new Date("2026-09-06T00:00:00.000Z"), new Date("2026-09-06T00:00:00.000Z"));
  utimesSync(newerPath, new Date("2026-09-07T00:00:00.000Z"), new Date("2026-09-07T00:00:00.000Z"));
  utimesSync(ignoredPath, new Date("2026-09-08T00:00:00.000Z"), new Date("2026-09-08T00:00:00.000Z"));

  assert.equal(resolveSessionFile(olderId, directory), olderPath);
  assert.equal(resolveSessionFile(newerId, directory), newerPath);
  assert.equal(resolveSessionFile("latest", directory), newerPath);
});
