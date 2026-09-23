import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import type { EmailConfig } from "../../src/server/email.ts";

interface SmtpOptions {
  readonly reject?: readonly string[];
  readonly senderRejected?: boolean;
  readonly dataResult?: "drop" | "stall" | "reject";
  readonly onData?: () => void;
  readonly noGreeting?: boolean;
}

export async function smtpServer(t: TestContext, options: SmtpOptions = {}) {
  const commands: string[] = [];
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (!options.noGreeting) socket.write("220 local test SMTP\r\n");
    let buffer = "";
    let receiving = false;
    let lines: string[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const index = buffer.indexOf("\r\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (receiving) {
          if (line !== ".") {
            lines.push(line.startsWith("..") ? line.slice(1) : line);
            continue;
          }
          receiving = false;
          messages.push(lines.join("\r\n"));
          lines = [];
          options.onData?.();
          if (options.dataResult === "drop") socket.destroy();
          else if (options.dataResult === "reject") socket.write("554 Message rejected\r\n");
          else if (options.dataResult !== "stall") socket.write("250 Queued as test-001\r\n");
          continue;
        }
        commands.push(line);
        if (line.startsWith("EHLO")) socket.write("250-test.local\r\n250-AUTH LOGIN\r\n250 SIZE 50480000\r\n");
        else if (line.startsWith("MAIL FROM:")) socket.write(options.senderRejected ? "550 Sender rejected\r\n" : "250 OK\r\n");
        else if (line.startsWith("RCPT TO:")) {
          const recipient = /^RCPT TO:<(.+)>$/u.exec(line)?.[1];
          socket.write(recipient && options.reject?.includes(recipient) ? "550 No such user\r\n" : "250 OK\r\n");
        } else if (line === "DATA") {
          receiving = true;
          socket.write("354 Send message\r\n");
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("500 Unsupported\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config: EmailConfig = {
    host: "127.0.0.1", port: address.port,
    fromAddress: '"JV OEE Agent"@sdsscn.com', fromName: "JV OEE Agent",
  };
  return { config, commands, messages, sockets };
}

export function decodedBody(message: string, contentType: string): string {
  const boundary = /boundary="([^"]+)"/u.exec(message)?.[1];
  const parts = boundary ? message.split(`--${boundary}`) : [message];
  const part = parts.find((value) => value.includes(`Content-Type: ${contentType}`));
  assert.ok(part, `${contentType} part exists`);
  const body = part.slice(part.indexOf("\r\n\r\n") + 4).trim();
  return /Content-Transfer-Encoding: base64/u.test(part) ? Buffer.from(body, "base64").toString("utf8") : body;
}
