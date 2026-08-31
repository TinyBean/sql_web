import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  decodeErrorResponse,
  decodeHealthResponse,
  decodeSchemaResponse,
  decodeSessionsResponse,
  parseJson,
  type Decoder,
} from "../client/api-contracts.ts";
import { DemoDatabase } from "../src/database.ts";
import { createWebServer, type WebSessionPort } from "../src/http-server.ts";

const projectRoot = process.cwd();

async function fetchContract<ResponseBody>(
  url: string,
  decode: Decoder<ResponseBody>,
): Promise<ResponseBody> {
  const response = await fetch(url);
  return decode(parseJson(await response.text(), url), url);
}

async function createFixture(t: TestContext): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "sqlite-qa-http-"));
  const database = DemoDatabase.open({
    filePath: path.join(directory, "demo.sqlite"),
    schemaPath: path.join(projectRoot, "sql", "schema.sql"),
    seedPath: path.join(projectRoot, "sql", "seed.sql"),
  });
  const sessions: WebSessionPort = {
    status: () => ({
      tools: ["query_database", "execute_database"],
      model: { provider: "test-provider", model: "test-model" },
      availableModelCount: 0,
      activeSessionCount: 0,
    }),
    list: async () => [],
    create: async () => ({
      id: "fake-session",
      title: "新会话",
      model: null,
      tools: ["query_database", "execute_database"],
      streaming: false,
      messages: [],
    }),
    get: async () => { throw new Error("not used in this test"); },
    getSerialized: async () => { throw new Error("not used in this test"); },
    prompt: async () => {},
    abort: async () => {},
  };
  const logger = { error() {} };
  const server = createWebServer({
    database,
    sessions,
    publicDir: path.join(projectRoot, "public"),
    logger,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string", "server should have a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return baseUrl;
}

test("serves the app with restrictive security headers", async (t) => {
  const baseUrl = await createFixture(t);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(await response.text(), /DataLens/u);
  const contractModule = await fetch(`${baseUrl}/api-contracts.js`);
  assert.equal(contractModule.status, 200);
  assert.match(contractModule.headers.get("content-type") ?? "", /javascript/u);
});

test("exposes health, schema, and session endpoints", async (t) => {
  const baseUrl = await createFixture(t);
  const health = await fetchContract(`${baseUrl}/api/health`, decodeHealthResponse);
  assert.deepEqual(health.agent.tools, ["query_database", "execute_database"]);

  const schema = await fetchContract(`${baseUrl}/api/schema`, decodeSchemaResponse);
  assert.equal(schema.objects.some((object) => object.name === "orders"), true);
  assert.equal(schema.objects.some((object) => "sql" in object), false);

  const sessions = await fetchContract(`${baseUrl}/api/sessions`, decodeSessionsResponse);
  assert.deepEqual(sessions, { sessions: [] });
});

test("rejects non-JSON session creation requests", async (t) => {
  const baseUrl = await createFixture(t);
  const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 415);
  const payload = decodeErrorResponse(parseJson(await response.text()));
  assert.match(payload.error, /Content-Type/u);
});
