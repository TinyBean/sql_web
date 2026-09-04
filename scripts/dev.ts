import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npmCommand, ["run", "dev:server"], { stdio: "inherit" }),
  spawn(npmCommand, ["run", "dev:client"], { stdio: "inherit" }),
];

let stopping = false;
let exitCode = 0;
let activeChildren = children.length;

function stopChildren(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("开发进程启动失败", error);
    exitCode = 1;
    stopChildren("SIGTERM");
  });
  child.on("exit", (code, signal) => {
    activeChildren -= 1;
    if (!stopping && (code !== 0 || signal)) {
      exitCode = code ?? 1;
      stopChildren("SIGTERM");
    }
    if (activeChildren === 0) process.exit(exitCode);
  });
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));
