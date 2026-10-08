type Frame = {
  kind: "object" | "array";
  state: "key-or-end" | "key" | "colon" | "value-or-end" | "value" | "comma-or-end";
};

/** Validate the entire streamed document, including the envelope after the row array. */
export class JsonDocumentValidator {
  #frames: Frame[] = [];
  #rootDone = false;
  #token = "";
  #string = false;
  #escaped = false;
  #key = false;

  push(text: string): void {
    for (const char of text) this.#pushChar(char);
  }

  finish(): void {
    if (this.#token && !this.#string) this.#finishToken();
    if (this.#token || this.#frames.length || !this.#rootDone) {
      throw new Error("JSON 响应不完整");
    }
  }

  #pushChar(char: string): void {
    if (this.#string) {
      this.#token += char;
      if (this.#escaped) this.#escaped = false;
      else if (char === "\\") this.#escaped = true;
      else if (char === '"') this.#finishToken();
      return;
    }
    if (this.#token) {
      if (!/[\s,\]}]/u.test(char)) {
        this.#token += char;
        return;
      }
      this.#finishToken();
    }
    if (/[ \t\r\n]/u.test(char)) return;
    const frame = this.#frames.at(-1);
    if (char === "}" || char === "]") {
      if (!frame || (char === "}" ? frame.kind !== "object" : frame.kind !== "array") ||
          !["key-or-end", "value-or-end", "comma-or-end"].includes(frame.state)) {
        throw new Error("JSON 容器结束位置无效");
      }
      this.#frames.pop();
      this.#completeValue();
      return;
    }
    if (frame?.state === "colon") {
      if (char !== ":") throw new Error("JSON 对象字段缺少冒号");
      frame.state = "value";
      return;
    }
    if (frame?.state === "comma-or-end") {
      if (char !== ",") throw new Error("JSON 元素之间缺少逗号");
      frame.state = frame.kind === "object" ? "key" : "value";
      return;
    }
    const key = frame?.state === "key" || frame?.state === "key-or-end";
    if (key && char !== '"') throw new Error("JSON 对象字段名必须是字符串");
    if (!frame && this.#rootDone) throw new Error("JSON 正文之后存在额外内容");
    if (char === "{" || char === "[") {
      this.#frames.push({ kind: char === "{" ? "object" : "array",
        state: char === "{" ? "key-or-end" : "value-or-end" });
    } else {
      this.#key = key;
      this.#string = char === '"';
      this.#token = char;
    }
  }

  #finishToken(): void {
    const value: unknown = JSON.parse(this.#token);
    if (!this.#string && (typeof value === "object" && value !== null || typeof value === "string")) {
      throw new Error("JSON 标量格式无效");
    }
    this.#token = "";
    this.#string = false;
    if (this.#key) {
      this.#frames.at(-1)!.state = "colon";
      this.#key = false;
    } else this.#completeValue();
  }

  #completeValue(): void {
    const frame = this.#frames.at(-1);
    if (frame) frame.state = "comma-or-end";
    else this.#rootDone = true;
  }
}
