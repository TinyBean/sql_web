import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const ARTIFACT_URI_PATTERN = /^artifact:\/\/([A-Za-z0-9-]{8,100})\/([^/]+)$/u;
const SNAPSHOT_MANIFEST_NAME = "snapshots.json";
const SNAPSHOT_MANIFEST_VERSION = 1;
const MAX_SNAPSHOT_NAME_INPUT_CHARACTERS = 64;
const MAX_SNAPSHOT_NAME_CHARACTERS = 32;
const MAX_SNAPSHOT_MANIFEST_BYTES = 256 * 1024;

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

export interface EphemeralArtifact<Value> {
  readonly filePath: string;
  readonly byteCount: number;
  readonly value: Value;
}

export interface DataSnapshotDescriptor {
  readonly name: string;
  readonly version: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly createdAt: string;
}

export interface CreatedDataSnapshot<Value> extends DataSnapshotDescriptor {
  readonly replaced: boolean;
  readonly value: Value;
}

export interface ResolvedDataSnapshot extends DataSnapshotDescriptor {
  readonly filePath: string;
}

interface SnapshotWriteMetadata {
  readonly columns: readonly string[];
  readonly rowCount: number;
}

interface SnapshotManifestEntry extends DataSnapshotDescriptor {
  readonly fileUri: string;
}

interface SnapshotManifest {
  readonly version: typeof SNAPSHOT_MANIFEST_VERSION;
  readonly snapshots: Readonly<Record<string, SnapshotManifestEntry>>;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ArtifactInputError("会话 ID 无效，无法创建或读取查询文件");
  }
}

export function normalizeDataSnapshotName(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ArtifactInputError("数据快照名称不能为空");
  }
  const normalizedInput = value.normalize("NFKC").trim();
  if (Array.from(normalizedInput).length > MAX_SNAPSHOT_NAME_INPUT_CHARACTERS) {
    throw new ArtifactInputError(
      `数据快照名称不能超过 ${MAX_SNAPSHOT_NAME_INPUT_CHARACTERS} 个字符`,
    );
  }
  const slug = normalizedInput
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const shortened = Array.from(slug)
    .slice(0, MAX_SNAPSHOT_NAME_CHARACTERS)
    .join("")
    .replace(/-+$/gu, "");
  if (!shortened) {
    throw new ArtifactInputError("数据快照名称必须包含中文、英文字母或数字");
  }
  return shortened;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseSnapshotManifest(value: unknown): SnapshotManifest {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("version" in value) || value.version !== SNAPSHOT_MANIFEST_VERSION ||
    !("snapshots" in value) || typeof value.snapshots !== "object" ||
    value.snapshots === null || Array.isArray(value.snapshots)
  ) {
    throw new ArtifactInputError("数据快照索引无效");
  }
  const snapshots: Record<string, SnapshotManifestEntry> = {};
  for (const [name, entry] of Object.entries(value.snapshots)) {
    if (
      normalizeDataSnapshotName(name) !== name ||
      typeof entry !== "object" || entry === null || Array.isArray(entry) ||
      !("name" in entry) || entry.name !== name ||
      !("version" in entry) || typeof entry.version !== "string" ||
      !("fileUri" in entry) || typeof entry.fileUri !== "string" ||
      !("columns" in entry) || !isStringArray(entry.columns) ||
      !("rowCount" in entry) || !Number.isInteger(entry.rowCount) || entry.rowCount < 0 ||
      !("byteCount" in entry) || !Number.isInteger(entry.byteCount) || entry.byteCount < 1 ||
      !("createdAt" in entry) || typeof entry.createdAt !== "string" ||
      Number.isNaN(Date.parse(entry.createdAt))
    ) {
      throw new ArtifactInputError("数据快照索引条目无效");
    }
    snapshots[name] = entry as SnapshotManifestEntry;
  }
  return { version: SNAPSHOT_MANIFEST_VERSION, snapshots };
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

  #readSnapshotManifest(): SnapshotManifest {
    const manifestPath = path.join(this.#sessionDir, SNAPSHOT_MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      return { version: SNAPSHOT_MANIFEST_VERSION, snapshots: {} };
    }
    const metadata = lstatSync(manifestPath);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size < 1 || metadata.size > MAX_SNAPSHOT_MANIFEST_BYTES
    ) {
      throw new ArtifactInputError("数据快照索引文件无效");
    }
    try {
      return parseSnapshotManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof ArtifactInputError) throw error;
      throw new ArtifactInputError("数据快照索引无法解析");
    }
  }

  #writeSnapshotManifest(manifest: SnapshotManifest): void {
    mkdirSync(this.#sessionDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#sessionDir, 0o700);
    const manifestPath = path.join(this.#sessionDir, SNAPSHOT_MANIFEST_NAME);
    const temporaryPath = path.join(
      this.#sessionDir,
      `.snapshots-${randomUUID()}.tmp`,
    );
    const payload = JSON.stringify(manifest);
    if (Buffer.byteLength(payload) > MAX_SNAPSHOT_MANIFEST_BYTES) {
      throw new ArtifactInputError("数据快照索引超过允许的大小");
    }
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(temporaryPath, "wx", 0o600);
      writeSync(fileDescriptor, payload);
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporaryPath, manifestPath);
    } catch (error) {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      rmSync(temporaryPath, { force: true });
      throw error;
    }
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
      throw new ArtifactInputError("JSON 文件地址必须是有效的 artifact:// URI");
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

  createDataSnapshot<Value extends SnapshotWriteMetadata>(
    requestedName: string,
    write: (fileDescriptor: number) => Value,
  ): CreatedDataSnapshot<Value> {
    const name = normalizeDataSnapshotName(requestedName);
    const manifest = this.#readSnapshotManifest();
    const previous = manifest.snapshots[name];
    const created = this.createJson(write);
    const artifactMatch = ARTIFACT_URI_PATTERN.exec(created.fileUri);
    const artifactName = artifactMatch?.[2];
    if (!artifactName || !ARTIFACT_ID_PATTERN.test(artifactName)) {
      rmSync(this.resolveJsonUri(created.fileUri), { force: true });
      throw new ArtifactInputError("新建数据快照的内部标识无效");
    }
    if (
      !Number.isInteger(created.value.rowCount) || created.value.rowCount < 0 ||
      !isStringArray(created.value.columns)
    ) {
      rmSync(this.resolveJsonUri(created.fileUri), { force: true });
      throw new ArtifactInputError("新建数据快照的元数据无效");
    }
    const descriptor: SnapshotManifestEntry = {
      name,
      version: artifactName.slice(0, -".json".length),
      fileUri: created.fileUri,
      columns: [...created.value.columns],
      rowCount: created.value.rowCount,
      byteCount: created.byteCount,
      createdAt: new Date().toISOString(),
    };
    try {
      this.#writeSnapshotManifest({
        version: SNAPSHOT_MANIFEST_VERSION,
        snapshots: { ...manifest.snapshots, [name]: descriptor },
      });
    } catch (error) {
      rmSync(this.resolveJsonUri(created.fileUri), { force: true });
      throw error;
    }
    if (previous) {
      try {
        rmSync(this.resolveJsonUri(previous.fileUri), { force: true });
      } catch {
        // The manifest already points at the new complete snapshot. A stale old
        // file is harmless and will be removed with the session.
      }
    }
    const { fileUri: _fileUri, ...publicDescriptor } = descriptor;
    return {
      ...publicDescriptor,
      replaced: previous !== undefined,
      value: created.value,
    };
  }

  resolveDataSnapshot(requestedName: string): ResolvedDataSnapshot {
    const name = normalizeDataSnapshotName(requestedName);
    const manifest = this.#readSnapshotManifest();
    const snapshot = manifest.snapshots[name];
    if (!snapshot) {
      const available = Object.keys(manifest.snapshots).sort();
      throw new ArtifactInputError(
        `当前会话不存在数据快照 ${JSON.stringify(name)}；可用快照：${
          available.length ? available.join("、") : "无"
        }`,
      );
    }
    const filePath = this.resolveJsonUri(snapshot.fileUri);
    const metadata = lstatSync(filePath);
    if (metadata.size !== snapshot.byteCount) {
      throw new ArtifactInputError("数据快照文件大小与索引不一致");
    }
    const { fileUri: _fileUri, ...descriptor } = snapshot;
    return { ...descriptor, filePath };
  }

  listDataSnapshots(): DataSnapshotDescriptor[] {
    return Object.values(this.#readSnapshotManifest().snapshots)
      .map(({ fileUri: _fileUri, ...descriptor }) => descriptor)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async withEphemeralJson<Value, Result>(
    write: (fileDescriptor: number) => Value,
    use: (artifact: EphemeralArtifact<Value>) => Promise<Result>,
  ): Promise<Result> {
    const created = this.createJson(write);
    const filePath = this.resolveJsonUri(created.fileUri);
    try {
      return await use({ filePath, byteCount: created.byteCount, value: created.value });
    } finally {
      rmSync(filePath, { force: true });
    }
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
