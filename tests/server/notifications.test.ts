import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createNotificationDispatcher } from "../../src/server/notifications.ts";
import type { EmailConfig, EmailInput, EmailResult } from "../../src/server/email.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";

const email: EmailConfig = { host: "127.0.0.1", port: 25, fromAddress: "sender@example.com", fromName: "通知" };
const content = { subject: "周改善表", text: "通知正文", html: "<p>通知正文</p>" };
const request = { messageType: "weekly-improvement", buildEmail: () => content };
const accepted: EmailResult = { kind: "email", status: "accepted", messageId: "<test@example.com>",
  accepted: ["Cheng.Wu@sdsscn.com"], rejected: [], response: "250 Cheng.Wu@sdsscn.com queued",
  errorCode: null, message: "untrusted reply Cheng.Wu@sdsscn.com" };

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "notifications-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "notifications.json");
  const logs: unknown[] = [];
  const context = { runId: "run-test", throughDate: "2026-09-14", logger: {
    info: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); },
  } };
  const save = (value: unknown) => writeFileSync(configPath, JSON.stringify(value));
  return { directory, configPath, context, logs, save };
}

function config(to: readonly string[] = ["Cheng.Wu@sdsscn.com"], groups: readonly string[] = []) {
  return { groups: {}, routes: { "weekly-improvement": { enabled: true, to, groups } } };
}

test("personal, group and mixed routes reload on every call, deduplicate and remain message-specific", async (t) => {
  const f = fixture(t);
  const delivered: EmailInput[] = [];
  const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail: () => email }, async (_smtp, input) => {
    delivered.push(input);
    return { ...accepted, accepted: input.to };
  });
  const groupMembers = ["Cheng.Wu@sdsscn.com", "team@example.com"];
  for (const [to, groups, expected] of [
    [["Cheng.Wu@SDSSCN.COM"], [], ["Cheng.Wu@sdsscn.com"]],
    [[], ["oee"], groupMembers],
    [["Cheng.Wu@sdsscn.com", "person@example.com"], ["oee", "oee"], ["Cheng.Wu@sdsscn.com", "person@example.com", "team@example.com"]],
  ] as const) {
    f.save({ ...config(to, groups), groups: { oee: groupMembers } });
    const result = await notify(request, f.context);
    assert.equal(result.status, "accepted");
    assert.equal(result.recipientCount, expected.length);
    assert.deepEqual(delivered.at(-1), { ...content, to: expected });
  }
  f.save({ groups: {}, routes: { "other-information": { enabled: true, groups: [], to: ["other@example.com"] } } });
  assert.equal((await notify(request, f.context)).status, "skipped");
  assert.equal((await notify({ ...request, messageType: "other-information" }, f.context)).status, "accepted");
  assert.deepEqual(delivered.at(-1)?.to, ["other@example.com"]);
  assert.equal(delivered.length, 4);
  const logs = JSON.stringify(f.logs);
  assert.match(logs, /run-test|recipientCount/u);
  assert.doesNotMatch(logs, /Cheng\.Wu|team@example|person@example|other@example|通知正文|untrusted|250 /u);
});

test("missing, absent and disabled routes skip without loading SMTP, rendering content or writing files", async (t) => {
  const f = fixture(t);
  const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail() { assert.fail("must not load SMTP"); } },
    async () => { assert.fail("must not send"); });
  const noContent = { ...request, buildEmail() { assert.fail("must not render"); } };
  assert.equal((await notify(noContent, f.context)).status, "skipped");
  assert.deepEqual(readdirSync(f.directory), []);
  for (const routes of [{}, { "weekly-improvement": { enabled: false, groups: ["unknown"], to: ["invalid"] } }]) {
    f.save({ groups: {}, routes });
    assert.equal((await notify(noContent, f.context)).status, "skipped");
  }
});

test("invalid config, unknown groups, invalid addresses and recipient limits fail without sending or leaking inputs", async (t) => {
  const f = fixture(t);
  const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail() { assert.fail("must not load SMTP"); } });
  const invalid = [null, {}, { groups: [], routes: {} }, config([], ["unknown"]), config([], ["toString"]),
    config([]), config(["invalid-private-address"]), config(["a@example.com\r\nBcc: secret@example.com"]),
    config(Array.from({ length: 51 }, (_, i) => `p${i}@example.com`)),
    { ...config(), routes: { "weekly-improvement": { enabled: "true", to: [], groups: [] } } }];
  for (const value of invalid) {
    f.save(value);
    const result = await notify(request, f.context);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "ENOTIFICATION_CONFIG");
  }
  writeFileSync(f.configPath, '{"secret@example.com": invalid');
  assert.equal((await notify(request, f.context)).status, "failed");
  rmSync(f.configPath);
  mkdirSync(f.configPath);
  assert.equal((await notify(request, f.context)).status, "failed");
  assert.doesNotMatch(JSON.stringify(f.logs), /invalid-private-address|secret@example|p50@example/u);
});

test("the 50-recipient cap applies after expansion and deduplication", async (t) => {
  const f = fixture(t);
  const addresses = Array.from({ length: 50 }, (_, i) => `p${i}@example.com`);
  f.save({ ...config(addresses, ["same"]), groups: { same: addresses } });
  let calls = 0;
  const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail: () => email }, async (_smtp, input) => {
    calls++;
    assert.deepEqual(input.to, addresses);
    return { ...accepted, accepted: addresses };
  });
  assert.equal((await notify(request, f.context)).recipientCount, 50);
  assert.equal(calls, 1);
});

test("SMTP and content errors are isolated; unexpected send rejection remains unknown and is not retried", async (t) => {
  const f = fixture(t);
  f.save(config());
  for (const loadEmail of [() => null, () => { throw new Error("private SMTP detail"); }]) {
    const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail }, async () => { assert.fail("must not send"); });
    assert.equal((await notify(request, f.context)).errorCode, "ENOTIFICATION_SMTP");
  }
  const notify = createNotificationDispatcher({ configPath: f.configPath, loadEmail: () => email }, async () => {
    throw new Error("private socket detail");
  });
  assert.equal((await notify({ ...request, buildEmail() { throw new Error("private body"); } }, f.context)).errorCode, "ENOTIFICATION_CONTENT");
  assert.equal((await notify(request, f.context)).status, "unknown");
  assert.doesNotMatch(JSON.stringify(f.logs), /private/u);
});

test("daily SMTP config reuses environment precedence and defers validation until delivery", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.directory, ".env"), [
    "SQL_WEB_SMTP_HOST=relay.example.com", "SQL_WEB_SMTP_PORT=2525",
    "SQL_WEB_MAIL_FROM_ADDRESS='\"JV OEE Agent\"@sdsscn.com'", "SQL_WEB_MAIL_FROM_NAME=JV OEE Agent",
  ].join("\n"));
  const loaded = loadDataCommandConfig(f.directory, { SQL_WEB_SMTP_HOST: "127.0.0.1" });
  assert.equal(loaded.notificationOptions.configPath, path.join(f.directory, ".data", "notifications.json"));
  assert.deepEqual(loaded.notificationOptions.loadEmail(), { host: "127.0.0.1", port: 2525,
    fromAddress: '"JV OEE Agent"@sdsscn.com', fromName: "JV OEE Agent" });
  const incomplete = loadDataCommandConfig(f.directory, { SQL_WEB_MAIL_FROM_ADDRESS: "" });
  assert.throws(() => incomplete.notificationOptions.loadEmail());
});
