import type { ParsedSseEvent } from "../shared/contracts.ts";

export type StreamToolStatus = "queued" | "running" | "done" | "error";

export function formatToolStatusText(name: string, status: StreamToolStatus): string {
  const operation = name === "query_database" ? "查询数据库" : "修改数据库";
  if (status === "queued") return `准备${operation}`;
  if (status === "running") return `正在${operation}`;
  if (status === "error") return "数据库操作失败";
  return "数据库操作完成";
}

export interface StreamTextItem {
  readonly type: "text";
  readonly turn: number;
  readonly text: string;
}

export interface StreamToolItem {
  readonly type: "tool";
  readonly turn: number;
  readonly id: string;
  readonly name: string;
  readonly status: StreamToolStatus;
}

export type StreamTraceItem = StreamTextItem | StreamToolItem;

export interface StreamPresentation {
  readonly items: readonly StreamTraceItem[];
  readonly finalText: string;
  readonly activeTurn: number | null;
  readonly currentTextIndex: number | null;
  readonly waiting: boolean;
  readonly finalized: boolean;
  readonly failed: boolean;
}

export type PresentationSseEvent = Exclude<ParsedSseEvent, { event: "done" | "status" }>;

export function createStreamPresentation(): StreamPresentation {
  return {
    items: [],
    finalText: "",
    activeTurn: null,
    currentTextIndex: null,
    waiting: false,
    finalized: false,
    failed: false,
  };
}

function updateTool(
  state: StreamPresentation,
  data: { readonly turn: number; readonly id: string; readonly name: string },
  status: StreamToolStatus,
): StreamPresentation {
  const index = state.items.findIndex((item) => item.type === "tool" && item.id === data.id);
  const tool: StreamToolItem = {
    type: "tool",
    turn: data.turn,
    id: data.id,
    name: data.name,
    status,
  };
  const items = [...state.items];
  if (index === -1) items.push(tool);
  else items[index] = tool;
  return {
    ...state,
    items,
    currentTextIndex: null,
    waiting: false,
  };
}

export function reduceStreamPresentation(
  state: StreamPresentation,
  parsed: PresentationSseEvent,
): StreamPresentation {
  if (parsed.event === "turn_start") {
    return {
      ...state,
      activeTurn: parsed.data.turn,
      currentTextIndex: null,
      waiting: true,
      failed: false,
    };
  }
  if (parsed.event === "text_delta") {
    const items = [...state.items];
    const current = state.currentTextIndex === null ? undefined : items[state.currentTextIndex];
    let currentTextIndex = state.currentTextIndex;
    if (current?.type === "text" && current.turn === parsed.data.turn) {
      items[state.currentTextIndex ?? -1] = {
        ...current,
        text: current.text + parsed.data.delta,
      };
    } else {
      currentTextIndex = items.length;
      items.push({ type: "text", turn: parsed.data.turn, text: parsed.data.delta });
    }
    return { ...state, items, currentTextIndex, waiting: false };
  }
  if (parsed.event === "tool_call") return updateTool(state, parsed.data, "queued");
  if (parsed.event === "tool_start") return updateTool(state, parsed.data, "running");
  if (parsed.event === "tool_end") {
    return updateTool(state, parsed.data, parsed.data.isError ? "error" : "done");
  }
  if (parsed.event === "turn_end") {
    if (!parsed.data.final) {
      return {
        ...state,
        activeTurn: null,
        currentTextIndex: null,
        waiting: false,
      };
    }
    const finalText = state.items
      .filter((item): item is StreamTextItem => (
        item.type === "text" && item.turn === parsed.data.turn
      ))
      .map((item) => item.text)
      .join("");
    return {
      ...state,
      items: state.items.filter((item) => item.turn !== parsed.data.turn),
      finalText: state.finalText + finalText,
      activeTurn: null,
      currentTextIndex: null,
      waiting: false,
      finalized: true,
    };
  }
  return {
    ...state,
    activeTurn: null,
    currentTextIndex: null,
    waiting: false,
    failed: true,
  };
}

export function settleStreamPresentation(state: StreamPresentation): StreamPresentation {
  return { ...state, activeTurn: null, currentTextIndex: null, waiting: false };
}
