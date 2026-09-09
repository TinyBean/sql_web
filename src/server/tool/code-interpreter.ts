import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { JsonObject, JsonValue } from "../../shared/contracts.ts";
import { isGeneratedImageReferenceName } from "../../shared/image-references.ts";
import { MAX_QUERY_ARTIFACT_BYTES } from "./artifact-store.ts";

const MAX_CODE_BYTES = 20_000;
const MAX_USER_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_DATABASE_INPUT_BYTES = MAX_QUERY_ARTIFACT_BYTES;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_IMAGE_WIDTH = 1_600;
const MAX_IMAGE_HEIGHT = 1_200;
const MAX_IMAGE_METADATA_BYTES = 128;
const WALL_TIMEOUT_MS = 15_000;

const PREPARE_CHINESE_FONTS = String.raw`
import os
import shutil
import sys

regular_target, bold_target = sys.argv[1:3]

def extract_face(source, family, target):
    from fontTools.ttLib import TTCollection
    collection = TTCollection(source)
    for font in collection.fonts:
        families = {
            record.toUnicode()
            for record in font["name"].names
            if record.nameID == 1
        }
        if family in families:
            font.save(target)
            return True
    return False

prepared = False
try:
    regular_sources = (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    )
    bold_sources = (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    )
    regular_source = next(path for path in regular_sources if os.path.isfile(path))
    bold_source = next(path for path in bold_sources if os.path.isfile(path))
    prepared = (
        extract_face(regular_source, "Noto Sans CJK SC", regular_target)
        and extract_face(bold_source, "Noto Sans CJK SC", bold_target)
    )
except Exception:
    prepared = False

if not prepared:
    for target in (regular_target, bold_target):
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
    fallback_sources = (
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    )
    fallback = next((path for path in fallback_sources if os.path.isfile(path)), None)
    if fallback:
        shutil.copyfile(fallback, regular_target)
        shutil.copyfile(fallback, bold_target)
        prepared = True

if not prepared:
    raise RuntimeError("未找到 Noto Sans CJK SC 或可用的中文回退字体")
`;

const PYTHON_RUNNER = String.raw`
import json
import os
import re

with open("/input/database.json", "r", encoding="utf-8") as database_file:
    raw_database_data = json.load(database_file)
with open("/input/user.json", "r", encoding="utf-8") as user_file:
    raw_user_data = json.load(user_file)

class _AttributeDict(dict):
    """JSON object with both value["key"] and value.key access."""
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as error:
            raise AttributeError(name) from error

def _attribute_json(value):
    if isinstance(value, dict):
        return _AttributeDict((key, _attribute_json(item)) for key, item in value.items())
    if isinstance(value, list):
        return [_attribute_json(item) for item in value]
    return value

database_data = _attribute_json(raw_database_data)
user_data = _attribute_json(raw_user_data)

input_data = _AttributeDict(database=database_data, user=user_data)
snapshot_rows = [] if database_data is None else database_data["rows"]

_CJK_REGULAR_FONT_PATH = "/fonts/chinese-regular.otf"
_CJK_BOLD_FONT_PATH = "/fonts/chinese-bold.otf"

def _configure_chinese_font():
    import copy
    import matplotlib
    from matplotlib import font_manager
    from matplotlib.ft2font import FT2Font

    required_characters = "中文设备运行停机"
    registered_fonts = []
    for font_path in (_CJK_REGULAR_FONT_PATH, _CJK_BOLD_FONT_PATH):
        if not os.path.isfile(font_path):
            raise RuntimeError("code_interpreter 中文字体文件不存在")
        character_map = FT2Font(font_path).get_charmap()
        if not all(ord(character) in character_map for character in required_characters):
            raise RuntimeError("code_interpreter 中文字体覆盖不完整")
        font_manager.fontManager.addfont(font_path)
        registered_fonts.append(next(
            entry for entry in reversed(font_manager.fontManager.ttflist)
            if entry.fname == font_path
        ))
    family = font_manager.FontProperties(fname=_CJK_REGULAR_FONT_PATH).get_name()
    for alias_name in ("SimHei",):
        for registered_font in registered_fonts:
            alias = copy.copy(registered_font)
            alias.name = alias_name
            font_manager.fontManager.ttflist.append(alias)
    font_manager.fontManager._findfont_cached.cache_clear()
    matplotlib.rcParams["font.family"] = "sans-serif"
    matplotlib.rcParams["font.sans-serif"] = [family, "DejaVu Sans"]
    matplotlib.rcParams["axes.unicode_minus"] = False
    font_manager.fontManager.defaultFamily["ttf"] = family
    return family

CJK_FONT_FAMILY = _configure_chinese_font()
CJK_FONT_PATH = _CJK_REGULAR_FONT_PATH
CJK_BOLD_FONT_PATH = _CJK_BOLD_FONT_PATH

def chinese_font(size=20, bold=False):
    """Return a Pillow font that supports Chinese text."""
    from PIL import ImageFont
    font_path = CJK_BOLD_FONT_PATH if bold else CJK_FONT_PATH
    return ImageFont.truetype(font_path, size=int(size))

def matplotlib_chinese_font(size=None, bold=False):
    """Return Matplotlib font properties backed by the bundled system CJK font."""
    from matplotlib.font_manager import FontProperties
    font_path = CJK_BOLD_FONT_PATH if bold else CJK_FONT_PATH
    return FontProperties(fname=font_path, size=size)

def _contains_cjk_text(value):
    return any(
        "\u3400" <= character <= "\u4dbf"
        or "\u4e00" <= character <= "\u9fff"
        or "\uf900" <= character <= "\ufaff"
        for character in value
    )

def _apply_chinese_font_to_figure(figure):
    from matplotlib.text import Text

    bold_names = {"bold", "heavy", "semibold", "demibold", "demi", "black", "extra bold"}
    for artist in figure.findobj(match=Text):
        if not _contains_cjk_text(artist.get_text()):
            continue
        weight = artist.get_fontweight()
        bold = (
            isinstance(weight, (int, float)) and weight >= 600
            or str(weight).lower() in bold_names
        )
        artist.set_fontproperties(matplotlib_chinese_font(artist.get_fontsize(), bold=bold))

_image_count = 0
_result_count = 0
_RESULT_MISSING = object()
_RESULT_KEYS = {"summary", "metrics", "intermediates", "data", "notes"}

def _json_default(value):
    item = getattr(value, "item", None)
    if callable(item):
        return item()
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        return to_list()
    iso_format = getattr(value, "isoformat", None)
    if callable(iso_format):
        return iso_format()
    if value.__class__.__module__ == "decimal" and value.__class__.__name__ == "Decimal":
        return str(value)
    raise TypeError(f"{value.__class__.__name__} 不是 JSON 值")

def _normalize_result(value):
    if not isinstance(value, dict):
        return {"summary": "计算完成", "data": value}
    normalized = dict(value)
    unknown = {key: normalized.pop(key) for key in list(normalized) if key not in _RESULT_KEYS}
    if unknown:
        if "data" not in normalized:
            normalized["data"] = unknown
        else:
            normalized["data"] = {"value": normalized["data"], "additional": unknown}
    summary = normalized.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        normalized["summary"] = "计算完成"
    notes = normalized.get("notes")
    if isinstance(notes, str):
        normalized["notes"] = [notes]
    elif isinstance(notes, tuple):
        normalized["notes"] = list(notes)
    return normalized

def emit_result(value=_RESULT_MISSING, **fields):
    global _result_count
    if _result_count != 0:
        raise RuntimeError("每次代码执行只能调用一次 emit_result")
    if value is not _RESULT_MISSING and fields:
        raise TypeError("emit_result 不能同时使用位置值和关键字字段")
    submitted = fields if value is _RESULT_MISSING else value
    with open("/work/result.json", "x", encoding="utf-8") as result_file:
        json.dump(
            _normalize_result(submitted),
            result_file,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            default=_json_default,
        )
    _result_count = 1

def _normalize_reference_name(value):
    if not isinstance(value, str):
        raise TypeError("reference_name 必须是字符串")
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not normalized or not re.search(r"[a-z]", normalized):
        raise ValueError("reference_name 归一化后必须包含有意义的英文字母")
    if len(normalized) > 50:
        raise ValueError("reference_name 归一化后长度不能超过 50 个字符")
    return normalized

def _normalize_png(filename):
    from PIL import Image
    with Image.open(filename) as source:
        source.load()
        source.thumbnail((1600, 1200))
        if source.mode not in ("RGB", "RGBA", "L", "LA", "P"):
            source = source.convert("RGBA")
        temporary = filename + ".normalized"
        source.save(temporary, format="PNG", optimize=True)
    os.replace(temporary, filename)

def emit_image(value, reference_name):
    global _image_count
    if _image_count >= 3:
        raise RuntimeError("每次代码执行最多生成 3 张图片")
    normalized_reference_name = _normalize_reference_name(reference_name)
    image_number = _image_count + 1
    filename = f"/work/image-{image_number}.png"
    try:
        from matplotlib.figure import Figure
    except ImportError:
        Figure = None
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Figure is not None and isinstance(value, Figure):
        _apply_chinese_font_to_figure(value)
        value.savefig(filename, format="png", bbox_inches="tight", dpi=120)
    elif Image is not None and isinstance(value, Image.Image):
        value.save(filename, format="PNG")
    else:
        raise TypeError("emit_image 只接受 Matplotlib Figure 或 Pillow Image")
    _normalize_png(filename)
    with open(f"/work/image-{image_number}.json", "w", encoding="utf-8") as metadata_file:
        json.dump({"referenceName": normalized_reference_name}, metadata_file, separators=(",", ":"))
    _image_count += 1

namespace = {
    "__builtins__": __builtins__,
    "__name__": "__main__",
    "input_data": input_data,
    "snapshot_rows": snapshot_rows,
    "emit_result": emit_result,
    "emit_image": emit_image,
    "CJK_FONT_PATH": CJK_FONT_PATH,
    "CJK_BOLD_FONT_PATH": CJK_BOLD_FONT_PATH,
    "CJK_FONT_FAMILY": CJK_FONT_FAMILY,
    "chinese_font": chinese_font,
    "matplotlib_chinese_font": matplotlib_chinese_font,
}
with open("/input/code.py", "r", encoding="utf-8") as code_file:
    source = code_file.read()
exec(compile(source, "<code_interpreter>", "exec"), namespace, namespace)
if _result_count != 1:
    raise RuntimeError("代码必须且只能调用一次 emit_result")
`;

const NETWORK_SYSCALLS_X64 = [
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  288, 299, 307,
  // Block io_uring as well so it cannot be used to bypass the socket filter.
  425, 426, 427,
] as const;

export interface CodeInterpreterOptions {
  readonly pythonPath: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly projectRoot: string;
}

export interface CodeInterpreterStatus {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface CodeInterpreterImage {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly alt: string;
  readonly referenceName: string;
}

export interface CodeInterpreterStructuredResult {
  readonly summary: string;
  readonly metrics?: JsonObject;
  readonly intermediates?: JsonObject;
  readonly data?: JsonValue;
  readonly notes?: readonly string[];
}

export interface CodeInterpreterSnapshotInput {
  readonly name: string;
  readonly version: string;
  readonly createdAt: string;
  readonly databasePath: string;
  readonly rowCount: number;
  readonly byteCount: number;
}

export interface CodeInterpreterInput {
  readonly snapshot: CodeInterpreterSnapshotInput | null;
  readonly userInput: JsonObject | null;
}

export interface CodeInterpreterProvenance {
  readonly source: "sqlite" | "none";
  readonly snapshotName: string | null;
  readonly snapshotVersion: string | null;
  readonly snapshotCreatedAt: string | null;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly truncated: false;
  readonly hasUserInput: boolean;
}

export interface CodeInterpreterDetails {
  readonly kind: "code_interpreter";
  readonly result: CodeInterpreterStructuredResult;
  readonly provenance: CodeInterpreterProvenance;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly images: readonly CodeInterpreterImage[];
}

export interface CodeInterpreterExecution {
  readonly text: string;
  readonly details: CodeInterpreterDetails;
}

export interface CodeInterpreterImageReference {
  readonly id: string;
  readonly markdown: string;
}

interface CapturedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface ProcessResult {
  readonly stdout: CapturedOutput;
  readonly stderr: CapturedOutput;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export class CodeInterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeInterpreterError";
  }
}

function writeSeccompInstruction(
  buffer: Buffer,
  index: number,
  code: number,
  jumpTrue: number,
  jumpFalse: number,
  value: number,
): void {
  const offset = index * 8;
  buffer.writeUInt16LE(code, offset);
  buffer.writeUInt8(jumpTrue, offset + 2);
  buffer.writeUInt8(jumpFalse, offset + 3);
  buffer.writeUInt32LE(value >>> 0, offset + 4);
}

function createNetworkSeccompFilter(): Buffer {
  if (process.arch !== "x64") {
    throw new CodeInterpreterError(`code_interpreter 暂不支持 ${process.arch} 架构`);
  }
  const instructions: Array<readonly [number, number, number, number]> = [
    // Load seccomp_data.arch and kill the process on a non-x86_64 ABI.
    [0x20, 0, 0, 4],
    [0x15, 1, 0, 0xc000003e],
    [0x06, 0, 0, 0x80000000],
    // Load seccomp_data.nr.
    [0x20, 0, 0, 0],
  ];
  for (const syscall of NETWORK_SYSCALLS_X64) {
    instructions.push(
      [0x15, 0, 1, syscall],
      // SECCOMP_RET_ERRNO | EPERM
      [0x06, 0, 0, 0x00050001],
    );
  }
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jumpTrue, jumpFalse, value], index) => {
    writeSeccompInstruction(buffer, index, code, jumpTrue, jumpFalse, value);
  });
  return buffer;
}

function captureStream(stream: NodeJS.ReadableStream): Promise<CapturedOutput> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let totalBytes = 0;
    let truncated = false;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (capturedBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - capturedBytes;
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      truncated = totalBytes > MAX_OUTPUT_BYTES;
    });
    stream.once("error", reject);
    stream.once("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated }));
  });
}

function runChild(
  child: ChildProcess,
  signal: AbortSignal | undefined,
): Promise<ProcessResult> {
  if (!child.stdout || !child.stderr) {
    return Promise.reject(new CodeInterpreterError("无法捕获 Python 进程输出"));
  }
  const stdout = captureStream(child.stdout);
  const stderr = captureStream(child.stderr);
  let timedOut = false;
  const terminate = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, WALL_TIMEOUT_MS);
  timer.unref();
  const abort = (): void => terminate();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) terminate();

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", async (exitCode, processSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        resolve({
          stdout: await stdout,
          stderr: await stderr,
          exitCode,
          signal: processSignal,
          timedOut,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function imageReferenceName(workDir: string, index: number): string {
  const filename = path.join(workDir, `image-${index}.json`);
  let metadata;
  try {
    metadata = lstatSync(filename);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CodeInterpreterError(`第 ${index} 张图片缺少 reference_name 元数据`);
    }
    throw error;
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size < 1 || metadata.size > MAX_IMAGE_METADATA_BYTES
  ) {
    throw new CodeInterpreterError(`第 ${index} 张图片的 reference_name 元数据无效`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch {
    throw new CodeInterpreterError(`第 ${index} 张图片的 reference_name 元数据无效`);
  }
  if (
    typeof decoded !== "object" || decoded === null ||
    !("referenceName" in decoded) ||
    !isGeneratedImageReferenceName(decoded.referenceName)
  ) {
    throw new CodeInterpreterError(`第 ${index} 张图片的 reference_name 元数据无效`);
  }
  return decoded.referenceName;
}

function collectImages(workDir: string): CodeInterpreterImage[] {
  const images: CodeInterpreterImage[] = [];
  let totalBytes = 0;
  for (let index = 1; index <= MAX_IMAGES; index += 1) {
    const filename = path.join(workDir, `image-${index}.png`);
    let metadata;
    try {
      metadata = lstatSync(filename);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CodeInterpreterError(`第 ${index} 张图片不是普通 PNG 文件`);
    }
    if (metadata.size > MAX_IMAGE_BYTES || totalBytes + metadata.size > MAX_TOTAL_IMAGE_BYTES) {
      throw new CodeInterpreterError("代码生成的图片超过大小限制");
    }
    const bytes = readFileSync(filename);
    const dimensions = pngDimensions(bytes);
    if (!dimensions || dimensions.width > MAX_IMAGE_WIDTH || dimensions.height > MAX_IMAGE_HEIGHT) {
      throw new CodeInterpreterError("代码生成了无效或尺寸过大的 PNG 图片");
    }
    totalBytes += bytes.length;
    const referenceName = imageReferenceName(workDir, index);
    images.push({
      mimeType: "image/png",
      data: bytes.toString("base64"),
      alt: referenceName,
      referenceName,
    });
  }
  return images;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function collectStructuredResult(workDir: string): CodeInterpreterStructuredResult {
  const filename = path.join(workDir, "result.json");
  let metadata;
  try {
    metadata = lstatSync(filename);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CodeInterpreterError("代码必须且只能调用一次 emit_result");
    }
    throw error;
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size < 1 || metadata.size > MAX_RESULT_BYTES
  ) {
    throw new CodeInterpreterError(`emit_result 结果必须是小于等于 ${MAX_RESULT_BYTES} 字节的 JSON 文件`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch {
    throw new CodeInterpreterError("emit_result 生成了无效 JSON");
  }
  if (!isJsonObject(decoded)) {
    throw new CodeInterpreterError("emit_result 必须接收 JSON 对象");
  }
  const allowedKeys = new Set(["summary", "metrics", "intermediates", "data", "notes"]);
  if (Object.keys(decoded).some((key) => !allowedKeys.has(key))) {
    throw new CodeInterpreterError(
      "emit_result 只允许 summary、metrics、intermediates、data 和 notes 字段",
    );
  }
  if (typeof decoded["summary"] !== "string" || !decoded["summary"].trim()) {
    throw new CodeInterpreterError("emit_result.summary 必须是非空字符串");
  }
  if (decoded["metrics"] !== undefined && !isJsonObject(decoded["metrics"])) {
    throw new CodeInterpreterError("emit_result.metrics 必须是 JSON 对象");
  }
  if (decoded["intermediates"] !== undefined && !isJsonObject(decoded["intermediates"])) {
    throw new CodeInterpreterError("emit_result.intermediates 必须是 JSON 对象");
  }
  if (decoded["data"] !== undefined && !isJsonValue(decoded["data"])) {
    throw new CodeInterpreterError("emit_result.data 必须是 JSON 值");
  }
  if (
    decoded["notes"] !== undefined &&
    (!Array.isArray(decoded["notes"]) || !decoded["notes"].every((note) => typeof note === "string"))
  ) {
    throw new CodeInterpreterError("emit_result.notes 必须是字符串数组");
  }
  return decoded as unknown as CodeInterpreterStructuredResult;
}

export function formatCodeInterpreterResult(
  details: CodeInterpreterDetails,
  imageReferences: readonly CodeInterpreterImageReference[] = [],
): string {
  return JSON.stringify({
    result: details.result,
    provenance: details.provenance,
    ...(details.stdout ? { stdout: details.stdout } : {}),
    ...(details.stderr ? { stderr: details.stderr } : {}),
    stdoutTruncated: details.stdoutTruncated,
    stderrTruncated: details.stderrTruncated,
    imageCount: details.images.length,
    imageDelivery: details.images.length ? "attached_to_answer" : "none",
    ...(imageReferences.length ? { imageReferences } : {}),
  });
}

function assertSnapshotInput(snapshot: CodeInterpreterSnapshotInput): void {
  if (!snapshot.name || !snapshot.version || Number.isNaN(Date.parse(snapshot.createdAt))) {
    throw new CodeInterpreterError("数据快照元数据无效");
  }
  if (!Number.isInteger(snapshot.rowCount) || snapshot.rowCount < 0) {
    throw new CodeInterpreterError("数据库输入行数无效");
  }
  if (
    !Number.isInteger(snapshot.byteCount) || snapshot.byteCount < 1 ||
    snapshot.byteCount > MAX_DATABASE_INPUT_BYTES
  ) {
    throw new CodeInterpreterError("数据库输入大小无效");
  }
  let metadata;
  try {
    metadata = lstatSync(snapshot.databasePath);
  } catch {
    throw new CodeInterpreterError("数据库输入文件不存在");
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== snapshot.byteCount ||
    metadata.size > MAX_DATABASE_INPUT_BYTES
  ) {
    throw new CodeInterpreterError("数据库输入文件无效");
  }
}

function pythonRetryHint(input: CodeInterpreterInput): string {
  const databaseHint = input.snapshot === null
    ? "本次未传数据快照，input_data.database 为 None，snapshot_rows 为空列表。"
    : "snapshot_rows 是 list[dict]；每行已经是对象，请直接使用 row['列名']，不要再执行 zip(columns, row)。input_data 同时支持方括号和属性访问。";
  return `${databaseHint} 最终结果请调用一次 emit_result(...)；notes 可传字符串或字符串数组。`;
}

export class CodeInterpreterRuntime {
  readonly status: CodeInterpreterStatus;
  readonly #options: CodeInterpreterOptions;
  readonly #runtimeDir: string | null;
  readonly #runnerPath: string | null;
  readonly #seccompPath: string | null;
  readonly #regularFontPath: string | null;
  readonly #boldFontPath: string | null;

  private constructor(
    options: CodeInterpreterOptions,
    status: CodeInterpreterStatus,
    runtimeDir: string | null,
  ) {
    this.#options = options;
    this.status = status;
    this.#runtimeDir = runtimeDir;
    this.#runnerPath = runtimeDir === null ? null : path.join(runtimeDir, "runner.py");
    this.#seccompPath = runtimeDir === null ? null : path.join(runtimeDir, "network.bpf");
    this.#regularFontPath = runtimeDir === null ? null : path.join(runtimeDir, "chinese-regular.otf");
    this.#boldFontPath = runtimeDir === null ? null : path.join(runtimeDir, "chinese-bold.otf");
  }

  static async create(options: CodeInterpreterOptions): Promise<CodeInterpreterRuntime> {
    const resolvedOptions = {
      pythonPath: path.resolve(options.pythonPath),
      bwrapPath: path.resolve(options.bwrapPath),
      prlimitPath: path.resolve(options.prlimitPath),
      projectRoot: path.resolve(options.projectRoot),
    };
    let runtimeDir: string | null = null;
    try {
      if (process.platform !== "linux") throw new CodeInterpreterError("仅支持 Linux 沙箱");
      await Promise.all([
        access(resolvedOptions.pythonPath, fsConstants.X_OK),
        access(resolvedOptions.bwrapPath, fsConstants.X_OK),
        access(resolvedOptions.prlimitPath, fsConstants.X_OK),
      ]);
      runtimeDir = mkdtempSync(path.join(tmpdir(), "sql-web-code-runtime-"));
      writeFileSync(path.join(runtimeDir, "runner.py"), PYTHON_RUNNER, { mode: 0o600 });
      writeFileSync(path.join(runtimeDir, "network.bpf"), createNetworkSeccompFilter(), { mode: 0o600 });
      const regularFontPath = path.join(runtimeDir, "chinese-regular.otf");
      const boldFontPath = path.join(runtimeDir, "chinese-bold.otf");
      const fontPreparation = spawnSync(
        resolvedOptions.pythonPath,
        ["-I", "-c", PREPARE_CHINESE_FONTS, regularFontPath, boldFontPath],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
      );
      if (fontPreparation.error || fontPreparation.status !== 0) {
        const diagnostic = fontPreparation.stderr.trim() || fontPreparation.error?.message ||
          `退出码 ${fontPreparation.status}`;
        throw new CodeInterpreterError(`中文字体准备失败：${diagnostic}`);
      }
      chmodSync(regularFontPath, 0o600);
      chmodSync(boldFontPath, 0o600);
      const runtime = new CodeInterpreterRuntime(
        resolvedOptions,
        { available: true, reason: null },
        runtimeDir,
      );
      const probe = await runtime.execute(
        [
          "import json, socket",
          "import numpy, scipy, matplotlib",
          "from PIL import Image",
          "if not CJK_FONT_PATH or not CJK_FONT_FAMILY:",
          "    raise RuntimeError('Chinese font probe failed')",
          "blocked = False",
          "try:",
          "    socket.socket()",
          "except PermissionError:",
          "    blocked = True",
          `project_visible = __import__('os').path.exists(${JSON.stringify(resolvedOptions.projectRoot)})`,
          "if not blocked or project_visible:",
          "    raise RuntimeError('sandbox isolation probe failed')",
          "image = Image.new('RGB', (8, 8), 'white')",
          "emit_image(image, 'sandbox-probe')",
          "emit_result({'summary': 'sandbox ok', 'metrics': {'sandbox': 'ok'}})",
          "print(json.dumps({'sandbox': 'ok'}))",
        ].join("\n"),
        {
          snapshot: null,
          userInput: null,
        },
        undefined,
      );
      if (
        !probe.details.stdout.includes('"sandbox": "ok"') || probe.details.images.length !== 1 ||
        probe.details.result.summary !== "sandbox ok"
      ) {
        throw new CodeInterpreterError("沙箱自检未返回预期结果");
      }
      return runtime;
    } catch (error) {
      if (runtimeDir !== null) rmSync(runtimeDir, { recursive: true, force: true });
      const reason = error instanceof Error && error.message ? error.message : "沙箱自检失败";
      return new CodeInterpreterRuntime(resolvedOptions, { available: false, reason }, null);
    }
  }

  async execute(
    code: string,
    input: CodeInterpreterInput,
    signal: AbortSignal | undefined,
  ): Promise<CodeInterpreterExecution> {
    if (
      !this.status.available || !this.#runnerPath || !this.#seccompPath ||
      !this.#regularFontPath || !this.#boldFontPath
    ) {
      throw new CodeInterpreterError(this.status.reason ?? "code_interpreter 当前不可用");
    }
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
      throw new CodeInterpreterError(`Python 代码不能超过 ${MAX_CODE_BYTES} 字节`);
    }
    if (input.snapshot !== null) assertSnapshotInput(input.snapshot);
    const userInputJson = JSON.stringify(input.userInput);
    if (Buffer.byteLength(userInputJson, "utf8") > MAX_USER_INPUT_BYTES) {
      throw new CodeInterpreterError(`user_input 不能超过 ${MAX_USER_INPUT_BYTES} 字节`);
    }
    signal?.throwIfAborted();

    const executionDir = mkdtempSync(path.join(tmpdir(), "sql-web-code-exec-"));
    const inputDir = path.join(executionDir, "input");
    const workDir = path.join(executionDir, "work");
    let filterDescriptor: number | undefined;
    try {
      mkdirSync(inputDir, { mode: 0o700 });
      mkdirSync(workDir, { mode: 0o700 });
      const codePath = path.join(inputDir, "code.py");
      const emptyDatabasePath = path.join(inputDir, "database.json");
      const userInputPath = path.join(inputDir, "user.json");
      writeFileSync(codePath, code, { mode: 0o600 });
      if (input.snapshot === null) writeFileSync(emptyDatabasePath, "null", { mode: 0o600 });
      writeFileSync(userInputPath, userInputJson, { mode: 0o600 });
      const databasePath = input.snapshot?.databasePath ?? emptyDatabasePath;

      filterDescriptor = openSync(this.#seccompPath, "r");
      const args = [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--share-net",
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--seccomp",
        "3",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/etc/alternatives",
        "/etc/alternatives",
        "--ro-bind",
        "/etc/ld.so.cache",
        "/etc/ld.so.cache",
        "--ro-bind",
        "/etc/matplotlibrc",
        "/etc/matplotlibrc",
        "--ro-bind-try",
        "/etc/fonts",
        "/etc/fonts",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--dir",
        "/tmp/mpl",
        "--dir",
        "/input",
        "--dir",
        "/fonts",
        "--ro-bind",
        this.#regularFontPath,
        "/fonts/chinese-regular.otf",
        "--ro-bind",
        this.#boldFontPath,
        "/fonts/chinese-bold.otf",
        "--ro-bind",
        this.#runnerPath,
        "/runner.py",
        "--ro-bind",
        codePath,
        "/input/code.py",
        "--ro-bind",
        databasePath,
        "/input/database.json",
        "--ro-bind",
        userInputPath,
        "/input/user.json",
        "--bind",
        workDir,
        "/work",
        "--chdir",
        "/work",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/tmp/home",
        "--setenv",
        "MPLCONFIGDIR",
        "/tmp/mpl",
        "--setenv",
        "MPLBACKEND",
        "Agg",
        "--setenv",
        "OPENBLAS_NUM_THREADS",
        "1",
        "--setenv",
        "OMP_NUM_THREADS",
        "1",
        "--setenv",
        "MKL_NUM_THREADS",
        "1",
        this.#options.prlimitPath,
        "--as=2147483648",
        "--cpu=10",
        "--nproc=16",
        "--nofile=64",
        "--fsize=8388608",
        "--",
        this.#options.pythonPath,
        "-I",
        "/runner.py",
      ];
      const startedAt = Date.now();
      const child = spawn(this.#options.bwrapPath, args, {
        stdio: ["ignore", "pipe", "pipe", filterDescriptor],
      });
      closeSync(filterDescriptor);
      filterDescriptor = undefined;
      const processResult = await runChild(child, signal);
      signal?.throwIfAborted();
      if (processResult.timedOut) throw new CodeInterpreterError("Python 执行超过 15 秒，已终止");
      if (processResult.exitCode !== 0) {
        const diagnostic = processResult.stderr.text.trim() ||
          `进程被 ${processResult.signal ?? `退出码 ${processResult.exitCode}`} 终止`;
        throw new CodeInterpreterError(
          `Python 执行失败：${diagnostic}\n重试提示：${pythonRetryHint(input)}`,
        );
      }
      const details: CodeInterpreterDetails = {
        kind: "code_interpreter",
        result: collectStructuredResult(workDir),
        provenance: {
          source: input.snapshot === null ? "none" : "sqlite",
          snapshotName: input.snapshot?.name ?? null,
          snapshotVersion: input.snapshot?.version ?? null,
          snapshotCreatedAt: input.snapshot?.createdAt ?? null,
          rowCount: input.snapshot?.rowCount ?? 0,
          byteCount: input.snapshot?.byteCount ?? 0,
          truncated: false,
          hasUserInput: input.userInput !== null,
        },
        stdout: processResult.stdout.text,
        stderr: processResult.stderr.text,
        stdoutTruncated: processResult.stdout.truncated,
        stderrTruncated: processResult.stderr.truncated,
        durationMs: Date.now() - startedAt,
        images: collectImages(workDir),
      };
      return { text: formatCodeInterpreterResult(details), details };
    } finally {
      if (filterDescriptor !== undefined) closeSync(filterDescriptor);
      rmSync(executionDir, { recursive: true, force: true });
    }
  }

  dispose(): void {
    if (this.#runtimeDir) rmSync(this.#runtimeDir, { recursive: true, force: true });
  }
}
