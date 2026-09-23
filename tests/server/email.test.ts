import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { sendEmail } from "../../src/server/email.ts";
import { smtpServer, decodedBody } from "../helpers/smtp.ts";
import { createEmailTool } from "../../src/server/tool/email-tools.ts";

const input = {
  to: ["Cheng.Wu@sdsscn.com"], subject: "邮件工具测试：中文与表格",
  text: "这是一封测试邮件。\n项目：中文表格\n状态：测试通过\n.保留正文",
  html: '<h2>邮件工具测试</h2><table><tr><th>项目</th><th>状态</th></tr><tr><td>中文表格</td><td>测试通过</td></tr></table>',
};

test("email tool submits Chinese MIME and quoted sender, strips active HTML and logs only metadata", async (t) => {
  const smtp = await smtpServer(t);
  const logs: unknown[] = [];
  const tool = createEmailTool(smtp.config, { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) }, "test-session");
  const result = await tool.execute("mail-test", {
    ...input,
    html: input.html + '<script>secret_script()</script><img src="https://example.com/tracker"><iframe src="file:///tmp/private">hidden</iframe><p onclick="bad()" style="background:url(https://example.com)">安全正文</p><a href="https://example.com">链接文字</a>',
  }, undefined, undefined, undefined as never);
  assert.equal(result.details.status, "accepted");
  assert.deepEqual(result.details.accepted, input.to);
  assert.deepEqual(result.details.rejected, []);
  assert.match(result.details.response ?? "", /^250 /u);
  assert.match(result.details.message, /实际送达尚未确认/u);
  assert.ok(smtp.commands.includes('MAIL FROM:<"JV OEE Agent"@sdsscn.com>'));
  assert.ok(smtp.commands.includes("RCPT TO:<Cheng.Wu@sdsscn.com>"));
  assert.equal(smtp.commands.some((line) => line.startsWith("AUTH")), false);
  assert.equal(smtp.messages.length, 1);
  const message = smtp.messages[0]!;
  const unfolded = message.replace(/\r\n[ \t]+/gu, " ");
  assert.match(unfolded, /From: JV OEE Agent <"JV OEE Agent"@sdsscn\.com>/u);
  assert.ok(unfolded.includes(`Message-ID: ${result.details.messageId}`));
  assert.doesNotMatch(unfolded, /^Reply-To:/mu);
  const subject = /Subject: ([^\r\n]+)/u.exec(unfolded)?.[1] ?? "";
  const decodedSubject = subject.replace(/\?=\s+(?==\?)/gu, "?=").replace(/=\?UTF-8\?B\?([^?]+)\?=/giu, (_match, encoded: string) => Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(decodedSubject, input.subject);
  assert.equal(decodedBody(message, "text/plain").trim(), input.text);
  const html = decodedBody(message, "text/html");
  assert.match(html, /<table border="1" cellpadding="6" cellspacing="0">/u);
  assert.match(html, /<td>中文表格<\/td>/u);
  assert.match(html, /安全正文/u);
  assert.doesNotMatch(html, /script|img|iframe|onclick|style=|https:|file:|secret_script/u);
  const log = JSON.stringify(logs);
  assert.match(log, /email.completed/u);
  assert.match(log, /recipientCount/u);
  assert.doesNotMatch(log, /Cheng\.Wu|中文表格|安全正文|Queued as|MAIL FROM/u);
});

test("plain text mail works and repeated addresses are deduplicated", async (t) => {
  const smtp = await smtpServer(t);
  const result = await sendEmail(smtp.config, { to: [...input.to, ...input.to], subject: input.subject, text: input.text });
  assert.equal(result.status, "accepted");
  assert.equal(smtp.commands.filter((command) => command.startsWith("RCPT TO")).length, 1);
  assert.equal(decodedBody(smtp.messages[0]!, "text/plain").trim(), input.text);
});

test("reports partial acceptance without retrying accepted recipients", async (t) => {
  const smtp = await smtpServer(t, { reject: ["missing@sdsscn.com"] });
  const result = await sendEmail(smtp.config, { ...input, to: [...input.to, "missing@sdsscn.com"] });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.accepted, input.to);
  assert.deepEqual(result.rejected, ["missing@sdsscn.com"]);
  assert.equal(smtp.messages.length, 1);
});

test("reports definite rejection at recipient, sender and final DATA stages", async (t) => {
  for (const options of [{ reject: input.to }, { senderRejected: true }, { dataResult: "reject" as const }]) {
    const smtp = await smtpServer(t, options);
    const result = await sendEmail(smtp.config, input);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.accepted, []);
    if (options.reject) assert.deepEqual(result.rejected, input.to);
    assert.match(result.response ?? "", /^55[04]/u);
    assert.equal(smtp.commands.filter((line) => line.startsWith("MAIL FROM")).length, 1);
  }
});

test("connection errors and pre-cancelled calls do not submit mail", async (t) => {
  const smtp = await smtpServer(t);
  const cancelled = await sendEmail(smtp.config, input, { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.errorCode, "ECANCELLED");
  assert.equal(smtp.commands.length, 0);
  const unused = createServer();
  await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const address = unused.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const refused = await sendEmail({ ...smtp.config, port: address.port }, input, { timeoutMs: 1000 });
  assert.equal(refused.status, "failed");
  assert.equal(smtp.messages.length, 0);
});

test("timeout, disconnect and cancellation after DATA remain unknown and never retry", async (t) => {
  for (const scenario of ["timeout", "disconnect", "cancel"] as const) {
    const controller = new AbortController();
    const smtp = await smtpServer(t, {
      dataResult: scenario === "disconnect" ? "drop" : "stall",
      ...(scenario === "cancel" ? { onData: () => controller.abort() } : {}),
    });
    const result = await sendEmail(smtp.config, input, { signal: controller.signal, timeoutMs: 500 });
    assert.equal(result.status, "unknown", scenario);
    assert.match(result.message, /禁止自动重试/u);
    assert.equal(smtp.messages.length, 1);
    assert.equal(smtp.commands.filter((line) => line === "DATA").length, 1);
    if (scenario === "cancel") assert.equal(result.errorCode, "ECANCELLED");
    // Cancellation closes the actual socket, not only the transport wrapper.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(smtp.sockets.size, 0, scenario);
  }
});

test("invalid inputs and header injection fail before opening a connection", async (t) => {
  const smtp = await smtpServer(t);
  for (const invalid of [
    { ...input, to: ["bad"] }, { ...input, to: ["User <user@sdsscn.com>"] },
    { ...input, to: ["a@sdsscn.com,b@sdsscn.com"] }, { ...input, to: ["a@sdsscn.com\r\nBcc: b@sdsscn.com"] },
    { ...input, subject: "Hi\r\nBcc: b@sdsscn.com" }, { ...input, subject: "  " },
    { ...input, text: " " }, { ...input, to: [] }, { ...input, from: "forged@sdsscn.com" },
  ]) {
    await assert.rejects(sendEmail(smtp.config, invalid), TypeError);
  }
  await assert.rejects(sendEmail({ ...smtp.config, fromName: "Agent\r\nBcc: b@sdsscn.com" }, input), TypeError);
  await assert.rejects(sendEmail({ ...smtp.config, fromAddress: "JV OEE Agent@sdsscn.com" }, input), TypeError);
  assert.equal(smtp.commands.length, 0);
});
