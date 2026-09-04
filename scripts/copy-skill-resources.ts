import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve("src", "server", "skills");
const destinationRoot = path.resolve("dist", "src", "server", "skills");

function copyResources(sourceDirectory: string, destinationDirectory: string): void {
  mkdirSync(destinationDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      copyResources(sourcePath, destinationPath);
    } else if (entry.isFile() && !entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

copyResources(sourceRoot, destinationRoot);
