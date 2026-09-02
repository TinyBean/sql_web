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
import type { SessionArtifactStore } from "./artifact-store.ts";

const MAX_CODE_BYTES = 20_000;
const MAX_INLINE_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_IMAGE_WIDTH = 1_600;
const MAX_IMAGE_HEIGHT = 1_200;
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
import sys

with open("/input/input.json", "r", encoding="utf-8") as input_file:
    input_data = json.load(input_file)

_CJK_REGULAR_FONT_PATH = "/fonts/chinese-regular.otf"
_CJK_BOLD_FONT_PATH = "/fonts/chinese-bold.otf"

def _configure_chinese_font():
    import matplotlib
    from matplotlib import font_manager
    from matplotlib.ft2font import FT2Font

    required_characters = "中文设备运行停机"
    for font_path in (_CJK_REGULAR_FONT_PATH, _CJK_BOLD_FONT_PATH):
        if not os.path.isfile(font_path):
            raise RuntimeError("code_interpreter 中文字体文件不存在")
        character_map = FT2Font(font_path).get_charmap()
        if not all(ord(character) in character_map for character in required_characters):
            raise RuntimeError("code_interpreter 中文字体覆盖不完整")
        font_manager.fontManager.addfont(font_path)
    family = font_manager.FontProperties(fname=_CJK_REGULAR_FONT_PATH).get_name()
    matplotlib.rcParams["font.family"] = "sans-serif"
    matplotlib.rcParams["font.sans-serif"] = [family, "DejaVu Sans"]
    matplotlib.rcParams["axes.unicode_minus"] = False
    return family

CJK_FONT_FAMILY = _configure_chinese_font()
CJK_FONT_PATH = _CJK_REGULAR_FONT_PATH
CJK_BOLD_FONT_PATH = _CJK_BOLD_FONT_PATH

def chinese_font(size=20, bold=False):
    """Return a Pillow font that supports Chinese text."""
    from PIL import ImageFont
    font_path = CJK_BOLD_FONT_PATH if bold else CJK_FONT_PATH
    return ImageFont.truetype(font_path, size=int(size))

_emitted_figure_ids = set()
_image_count = 0

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

def emit_image(value):
    global _image_count
    if _image_count >= 3:
        raise RuntimeError("每次代码执行最多生成 3 张图片")
    filename = f"/work/image-{_image_count + 1}.png"
    try:
        from matplotlib.figure import Figure
    except ImportError:
        Figure = None
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Figure is not None and isinstance(value, Figure):
        value.savefig(filename, format="png", bbox_inches="tight", dpi=120)
        _emitted_figure_ids.add(id(value))
    elif Image is not None and isinstance(value, Image.Image):
        value.save(filename, format="PNG")
    else:
        raise TypeError("emit_image 只接受 Matplotlib Figure 或 Pillow Image")
    _normalize_png(filename)
    _image_count += 1

namespace = {
    "__builtins__": __builtins__,
    "__name__": "__main__",
    "input_data": input_data,
    "emit_image": emit_image,
    "CJK_FONT_PATH": CJK_FONT_PATH,
    "CJK_BOLD_FONT_PATH": CJK_BOLD_FONT_PATH,
    "CJK_FONT_FAMILY": CJK_FONT_FAMILY,
    "chinese_font": chinese_font,
}
with open("/input/code.py", "r", encoding="utf-8") as code_file:
    source = code_file.read()
exec(compile(source, "<code_interpreter>", "exec"), namespace, namespace)

if "matplotlib.pyplot" in sys.modules:
    import matplotlib.pyplot as plt
    for figure_number in plt.get_fignums():
        figure = plt.figure(figure_number)
        if id(figure) in _emitted_figure_ids:
            continue
        if _image_count >= 3:
            print("存在超过 3 张的图表，额外图表已忽略", file=sys.stderr)
            break
        emit_image(figure)
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
}

export interface CodeInterpreterDetails {
  readonly kind: "code_interpreter";
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
    images.push({
      mimeType: "image/png",
      data: bytes.toString("base64"),
      alt: `代码计算图表 ${index}`,
    });
  }
  return images;
}

function resultText(details: CodeInterpreterDetails): string {
  return JSON.stringify({
    stdout: details.stdout || "(no stdout)",
    ...(details.stderr ? { stderr: details.stderr } : {}),
    stdoutTruncated: details.stdoutTruncated,
    stderrTruncated: details.stderrTruncated,
    imageCount: details.images.length,
    imageDelivery: details.images.length ? "attached_to_answer" : "none",
  });
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
          "emit_image(image)",
          "print(json.dumps({'sandbox': 'ok'}))",
        ].join("\n"),
        "{}",
        undefined,
        undefined,
      );
      if (!probe.details.stdout.includes('"sandbox": "ok"') || probe.details.images.length !== 1) {
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
    inputJson: string | undefined,
    artifacts: SessionArtifactStore | undefined,
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
    signal?.throwIfAborted();

    const executionDir = mkdtempSync(path.join(tmpdir(), "sql-web-code-exec-"));
    const inputDir = path.join(executionDir, "input");
    const workDir = path.join(executionDir, "work");
    let filterDescriptor: number | undefined;
    try {
      mkdirSync(inputDir, { mode: 0o700 });
      mkdirSync(workDir, { mode: 0o700 });
      const codePath = path.join(inputDir, "code.py");
      writeFileSync(codePath, code, { mode: 0o600 });

      let inputPath: string;
      if (inputJson?.startsWith("artifact://")) {
        if (!artifacts) throw new CodeInterpreterError("当前执行没有可用的会话查询文件");
        inputPath = artifacts.resolveJsonUri(inputJson);
      } else {
        const inline = inputJson ?? "null";
        if (Buffer.byteLength(inline, "utf8") > MAX_INLINE_INPUT_BYTES) {
          throw new CodeInterpreterError(`内联 input_json 不能超过 ${MAX_INLINE_INPUT_BYTES} 字节`);
        }
        try {
          JSON.parse(inline);
        } catch {
          throw new CodeInterpreterError("input_json 不是有效 JSON 或 artifact:// 文件地址");
        }
        inputPath = path.join(inputDir, "input.json");
        writeFileSync(inputPath, inline, { mode: 0o600 });
      }

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
        inputPath,
        "/input/input.json",
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
        throw new CodeInterpreterError(`Python 执行失败：${diagnostic}`);
      }
      const details: CodeInterpreterDetails = {
        kind: "code_interpreter",
        stdout: processResult.stdout.text,
        stderr: processResult.stderr.text,
        stdoutTruncated: processResult.stdout.truncated,
        stderrTruncated: processResult.stderr.truncated,
        durationMs: Date.now() - startedAt,
        images: collectImages(workDir),
      };
      return { text: resultText(details), details };
    } finally {
      if (filterDescriptor !== undefined) closeSync(filterDescriptor);
      rmSync(executionDir, { recursive: true, force: true });
    }
  }

  dispose(): void {
    if (this.#runtimeDir) rmSync(this.#runtimeDir, { recursive: true, force: true });
  }
}
