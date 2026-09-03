import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const ARTIFACT_URI_PATTERN = /^artifact:\/\/([A-Za-z0-9-]{8,100})\/([^/]+)$/u;

export const MAX_QUERY_ARTIFACT_BYTES = 32 * 1024 * 1024;

export class ArtifactInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactInputError";
  }
}

export interface CreatedArtifact<Value> {
  readonly fileUri: string;
  readonly byteCount: number;
  readonly value: Value;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ArtifactInputError("会话 ID 无效，无法创建或读取查询文件");
  }
}

export class SessionArtifactStore {
  readonly #rootDir: string;
  readonly #sessionId: string;
  readonly #sessionDir: string;

  constructor(rootDir: string, sessionId: string) {
    assertSessionId(sessionId);
    this.#rootDir = path.resolve(rootDir);
    this.#sessionId = sessionId;
    this.#sessionDir = path.join(this.#rootDir, sessionId);
  }

  createJson<Value>(write: (fileDescriptor: number) => Value): CreatedArtifact<Value> {
    mkdirSync(this.#sessionDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#sessionDir, 0o700);
    const artifactName = `${randomUUID()}.json`;
    const finalPath = path.join(this.#sessionDir, artifactName);
    const temporaryPath = path.join(this.#sessionDir, `.${artifactName}.tmp`);
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(temporaryPath, "wx", 0o600);
      const value = write(fileDescriptor);
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporaryPath, finalPath);
      const metadata = lstatSync(finalPath);
      return {
        fileUri: `artifact://${this.#sessionId}/${artifactName}`,
        byteCount: metadata.size,
        value,
      };
    } catch (error) {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      rmSync(temporaryPath, { force: true });
      rmSync(finalPath, { force: true });
      throw error;
    }
  }

  resolveJsonUri(uri: string): string {
    const match = ARTIFACT_URI_PATTERN.exec(uri);
    if (!match) {
      throw new ArtifactInputError("input_json 文件地址必须是有效的 artifact:// URI");
    }
    const [, sessionId, artifactName] = match;
    if (sessionId !== this.#sessionId) {
      throw new ArtifactInputError("不能读取其他会话生成的查询文件");
    }
    if (!artifactName || !ARTIFACT_ID_PATTERN.test(artifactName)) {
      throw new ArtifactInputError("查询文件地址无效");
    }

    const candidate = path.join(this.#sessionDir, artifactName);
    if (!existsSync(candidate)) throw new ArtifactInputError("查询文件不存在或已被删除");
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ArtifactInputError("查询文件类型无效");
    }
    if (metadata.size > MAX_QUERY_ARTIFACT_BYTES) {
      throw new ArtifactInputError("查询文件超过允许的大小");
    }

    const realSessionDir = realpathSync(this.#sessionDir);
    const realCandidate = realpathSync(candidate);
    const relative = path.relative(realSessionDir, realCandidate);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ArtifactInputError("查询文件不在当前会话目录中");
    }
    return realCandidate;
  }
}

export class ArtifactStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
  }

  forSession(sessionId: string): SessionArtifactStore {
    return new SessionArtifactStore(this.rootDir, sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await rm(path.join(this.rootDir, sessionId), { recursive: true, force: true });
  }
}
