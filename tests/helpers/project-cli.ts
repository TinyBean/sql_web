import { copyFileSync, cpSync, symlinkSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../../src/server/config.ts";

// CLI entrypoints locate .env relative to their modules, independently of the caller's cwd.
export function stageProjectCli(directory: string, script: string): string[] {
  const codeRoot = path.resolve(import.meta.dirname, "../..");
  for (const name of ["src", "scripts"]) {
    cpSync(path.join(codeRoot, name), path.join(directory, name), { recursive: true });
  }
  copyFileSync(path.join(PROJECT_ROOT, "package.json"), path.join(directory, "package.json"));
  const schema = "scripts/database/schema.sql";
  copyFileSync(path.join(PROJECT_ROOT, schema), path.join(directory, schema));
  symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(directory, "node_modules"), "dir");
  const extension = path.extname(import.meta.filename);
  const entry = path.join(directory, "scripts", script + extension);
  return extension === ".ts" ? ["--import", import.meta.resolve("tsx"), entry] : [entry];
}
