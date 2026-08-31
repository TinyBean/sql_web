import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const target of [path.join(projectRoot, "dist"), path.join(projectRoot, "public", "generated")]) {
  rmSync(target, { recursive: true, force: true });
}
