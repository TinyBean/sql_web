import type {
  AutomaticCompactionReason,
  ChatImage,
  ChatMessage,
  JsonObject,
  ParsedSseEvent,
} from "../shared/contracts.ts";

export type StreamToolStatus = "queued" | "running" | "done" | "error";

export function formatToolStatusText(_name: string, status: StreamToolStatus): string {
  if (status === "queued") return "准备执行工具";
  if (status === "running") return "正在执行工具";
  if (status === "error") return "工具执行失败";
  return "工具执行完成";
}

export function formatToolArguments(arguments_: JsonObject): string {
  return JSON.stringify(arguments_, null, 2);
}

/** Select only an assistant response belonging to the latest submitted user turn. */
export function latestAssistantAfterLastUser(
  messages: readonly ChatMessage[],
): ChatMessage | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < 0) return undefined;
  return messages.slice(lastUserIndex + 1).findLast((message) => message.role === "assistant");
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
  readonly arguments: JsonObject;
  readonly status: StreamToolStatus;
}

export type StreamTraceItem = StreamTextItem | StreamToolItem;

export interface StreamPresentation {
  readonly items: readonly StreamTraceItem[];
  readonly finalText: string;
  readonly activeTurn: number | null;
  readonly currentTurnText: string;
  readonly images: readonly ChatImage[];
  readonly compactingReason: AutomaticCompactionReason | null;
  readonly waiting: boolean;
  readonly finalized: boolean;
  readonly failed: boolean;
  readonly settled: boolean;
}

export type PresentationSseEvent = Exclude<ParsedSseEvent, { event: "done" | "status" }>;

export function createStreamPresentation(): StreamPresentation {
  return {
    items: [],
    finalText: "",
    activeTurn: null,
    currentTurnText: "",
    images: [],
    compactingReason: null,
    waiting: false,
    finalized: false,
    failed: false,
    settled: false,
  };
}

function flushCurrentTurnText(
  state: StreamPresentation,
  turn: number,
): StreamTraceItem[] {
  if (!state.currentTurnText) return [...state.items];
  return [...state.items, { type: "text", turn, text: state.currentTurnText }];
}

function updateTool(
  state: StreamPresentation,
  data: {
    readonly turn: number;
    readonly id: string;
    readonly name: string;
    readonly arguments?: JsonObject;
  },
  status: StreamToolStatus,
): StreamPresentation {
  const items = flushCurrentTurnText(state, data.turn);
  const index = items.findIndex((item) => item.type === "tool" && item.id === data.id);
  const previous = items[index];
  const tool: StreamToolItem = {
    type: "tool",
    turn: data.turn,
    id: data.id,
    name: data.name,
    arguments: data.arguments ?? (previous?.type === "tool" ? previous.arguments : {}),
    status,
  };
  if (index === -1) items.push(tool);
  else items[index] = tool;
  return {
    ...state,
    items,
    currentTurnText: "",
    waiting: false,
  };
}

export function reduceStreamPresentation(
  state: StreamPresentation,
  parsed: PresentationSseEvent,
): StreamPresentation {
  if (state.settled) return state;
  if (parsed.event === "compaction_start") {
    return { ...state, compactingReason: parsed.data.reason };
  }
  if (parsed.event === "compaction_end") {
    return state.compactingReason === parsed.data.reason
      ? { ...state, compactingReason: null }
      : state;
  }
  if (parsed.event === "turn_start") {
    if (state.activeTurn !== null || state.finalized) return state;
    return {
      ...state,
      activeTurn: parsed.data.turn,
      currentTurnText: "",
      waiting: true,
      failed: false,
    };
  }
  if (parsed.event === "text_delta") {
    if (state.activeTurn !== parsed.data.turn) return state;
    return {
      ...state,
      currentTurnText: state.currentTurnText + parsed.data.delta,
      waiting: false,
    };
  }
  if (parsed.event === "tool_call") {
    return state.activeTurn === parsed.data.turn
      ? updateTool(state, parsed.data, "queued")
      : state;
  }
  if (parsed.event === "tool_start") {
    return state.activeTurn === parsed.data.turn
      ? updateTool(state, parsed.data, "running")
      : state;
  }
  if (parsed.event === "tool_end") {
    return state.activeTurn === parsed.data.turn
      ? updateTool(state, parsed.data, parsed.data.isError ? "error" : "done")
      : state;
  }
  if (parsed.event === "generated_image") {
    if (state.activeTurn !== parsed.data.turn) return state;
    if (state.images.some((image) => image.id === parsed.data.image.id)) return state;
    return { ...state, images: [...state.images, parsed.data.image] };
  }
  if (parsed.event === "turn_end") {
    if (state.activeTurn !== parsed.data.turn) return state;
    if (!parsed.data.final) {
      return {
        ...state,
        items: flushCurrentTurnText(state, parsed.data.turn),
        activeTurn: null,
        currentTurnText: "",
        waiting: false,
      };
    }
    return {
      ...state,
      finalText: state.currentTurnText,
      activeTurn: null,
      currentTurnText: "",
      waiting: false,
      finalized: true,
    };
  }
  return {
    ...state,
    activeTurn: null,
    compactingReason: null,
    waiting: false,
    failed: true,
    settled: true,
  };
}

export function settleStreamPresentation(state: StreamPresentation): StreamPresentation {
  return {
    ...state,
    activeTurn: null,
    compactingReason: null,
    waiting: false,
    settled: true,
  };
}
