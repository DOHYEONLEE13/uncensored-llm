export type WebSearchMode = "auto" | "on" | "off";

export type WebSearchStatus =
  | "unused"
  | "searching"
  | "used"
  | "fallback"
  | "failed";

export interface WebSearchSource {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
}

export interface MiraWebSearchMetadata {
  mode: WebSearchMode;
  status: WebSearchStatus;
  used: boolean;
  reason?: string;
  warning?: string;
  sources: WebSearchSource[];
}

export interface ChatStreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface ChatStreamCallbacks {
  onContent?: (content: string) => void | Promise<void>;
  onUsage?: (usage: ChatStreamUsage) => void | Promise<void>;
  onMeta?: (metadata: MiraWebSearchMetadata) => void | Promise<void>;
  onError?: (error: ChatStreamError) => void | Promise<void>;
}

interface ErrorDetails {
  type?: string;
  code?: string | number;
  status?: number;
}

export class ChatStreamError extends Error {
  readonly type?: string;
  readonly code?: string | number;
  readonly status?: number;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "ChatStreamError";
    this.type = details.type;
    this.code = details.code;
    this.status = details.status;
  }
}

type UnknownRecord = Record<string, unknown>;

interface ParsedSseEvent {
  event: string;
  data: string;
}

const MAX_WEB_SEARCH_SOURCES = 8;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeMode(value: unknown): WebSearchMode {
  return value === "on" || value === "off" ? value : "auto";
}

function normalizeStatus(value: unknown, used: boolean): WebSearchStatus {
  switch (value) {
    case "searching":
    case "used":
    case "fallback":
    case "failed":
    case "unused":
      return value;
    case "not-used":
    case "not_used":
      return "unused";
    default:
      return used ? "used" : "unused";
  }
}

function normalizeSource(value: unknown): WebSearchSource | undefined {
  const raw = typeof value === "string" ? { url: value } : value;
  if (!isRecord(raw)) return undefined;

  const rawUrl = optionalString(raw.url ?? raw.href ?? raw.link);
  if (!rawUrl) return undefined;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return undefined;
  }

  parsedUrl.hash = "";
  const url = parsedUrl.toString();
  const derivedDomain = parsedUrl.hostname.replace(/^www\./i, "");
  const domain = optionalString(raw.domain ?? raw.site) ?? derivedDomain;
  const title = optionalString(raw.title ?? raw.name) ?? domain;
  const snippet = optionalString(raw.snippet ?? raw.description ?? raw.text);

  return {
    title,
    url,
    domain,
    ...(snippet ? { snippet } : {}),
  };
}

export function normalizeWebSearchSources(value: unknown): WebSearchSource[] {
  if (!Array.isArray(value)) return [];

  const sources: WebSearchSource[] = [];
  const seenUrls = new Set<string>();

  for (const candidate of value) {
    const source = normalizeSource(candidate);
    if (!source) continue;

    const dedupeUrl = new URL(source.url);
    dedupeUrl.hostname = dedupeUrl.hostname.replace(/^www\./i, "");
    const dedupeKey = dedupeUrl.toString().toLocaleLowerCase("en-US");
    if (seenUrls.has(dedupeKey)) continue;

    seenUrls.add(dedupeKey);
    sources.push(source);
    if (sources.length === MAX_WEB_SEARCH_SOURCES) break;
  }

  return sources;
}

function extractWebSearchMetadata(
  payload: UnknownRecord,
  eventName: string,
): MiraWebSearchMetadata | undefined {
  let candidate: unknown;

  if (isRecord(payload.webSearch)) {
    candidate = payload.webSearch;
  } else if (isRecord(payload.mira) && isRecord(payload.mira.webSearch)) {
    candidate = payload.mira.webSearch;
  } else if (isRecord(payload.mira_meta) && isRecord(payload.mira_meta.web_search)) {
    candidate = payload.mira_meta.web_search;
  } else if (
    (eventName === "mira-meta" || payload.type === "mira.web_search") &&
    isRecord(payload)
  ) {
    candidate = payload;
  }

  if (!isRecord(candidate)) return undefined;

  const explicitUsed =
    typeof candidate.used === "boolean" ? candidate.used : undefined;
  const rawStatus = candidate.status;
  const inferredUsed =
    rawStatus === "used" ||
    (rawStatus === "fallback" && candidate.searched !== false);
  const used = explicitUsed ?? inferredUsed;

  return {
    mode: normalizeMode(candidate.mode),
    status: normalizeStatus(rawStatus, used),
    used,
    ...(optionalString(candidate.reason) ? {
      reason: optionalString(candidate.reason),
    } : {}),
    ...(optionalString(candidate.warning) ? {
      warning: optionalString(candidate.warning),
    } : {}),
    sources: normalizeWebSearchSources(
      candidate.sources ?? candidate.citations ?? candidate.references,
    ),
  };
}

function extractUsage(payload: UnknownRecord): ChatStreamUsage | undefined {
  if (!isRecord(payload.usage)) return undefined;

  const inputTokens =
    finiteNonNegativeNumber(payload.usage.prompt_tokens) ??
    finiteNonNegativeNumber(payload.usage.input_tokens);
  const outputTokens =
    finiteNonNegativeNumber(payload.usage.completion_tokens) ??
    finiteNonNegativeNumber(payload.usage.output_tokens);
  const reportedTotal = finiteNonNegativeNumber(payload.usage.total_tokens);
  const reasoningTokens =
    finiteNonNegativeNumber(payload.usage.reasoning_tokens) ??
    (isRecord(payload.usage.completion_tokens_details)
      ? finiteNonNegativeNumber(payload.usage.completion_tokens_details.reasoning_tokens)
      : undefined);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reportedTotal === undefined
  ) {
    return undefined;
  }

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = outputTokens ?? 0;

  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: reportedTotal ?? normalizedInput + normalizedOutput,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function extractContent(payload: UnknownRecord): string[] {
  if (!Array.isArray(payload.choices)) return [];

  const chunks: string[] = [];
  for (const choice of payload.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const content = choice.delta.content;

    if (typeof content === "string") {
      if (content.length > 0) chunks.push(content);
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text =
        typeof part.text === "string"
          ? part.text
          : isRecord(part.text) && typeof part.text.value === "string"
            ? part.text.value
            : undefined;
      if (text) chunks.push(text);
    }
  }

  return chunks;
}

function extractStreamError(
  payload: UnknownRecord,
  eventName: string,
): ChatStreamError | undefined {
  if (typeof payload.error === "string") {
    return new ChatStreamError(payload.error);
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const hasErrorFinishReason = choices.some(
    (choice) => isRecord(choice) && choice.finish_reason === "error",
  );
  const rawError = isRecord(payload.error)
    ? payload.error
    : eventName === "error"
      ? payload
      : hasErrorFinishReason
        ? { message: "스트리밍 응답 중 오류가 발생했습니다." }
        : undefined;
  if (!rawError) return undefined;

  const message =
    optionalString(rawError.message ?? rawError.detail ?? rawError.error) ??
    "The upstream chat stream returned an error.";
  const type = optionalString(rawError.type);
  const codeValue = rawError.code;
  const code =
    typeof codeValue === "string" || typeof codeValue === "number"
      ? codeValue
      : undefined;
  const status = finiteNonNegativeNumber(rawError.status);

  return new ChatStreamError(message, {
    ...(type ? { type } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  });
}

async function parseEvent(
  parsedEvent: ParsedSseEvent,
  callbacks: ChatStreamCallbacks,
): Promise<boolean> {
  const data = parsedEvent.data.trim();
  if (!data) return false;
  if (data === "[DONE]") return true;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (cause) {
    if (parsedEvent.event === "ping" || parsedEvent.event === "keepalive") {
      return false;
    }
    throw new ChatStreamError("The chat stream contained invalid JSON.", {
      type: cause instanceof SyntaxError ? "invalid_sse_json" : "stream_error",
    });
  }

  if (!isRecord(payload)) return false;

  const streamError = extractStreamError(payload, parsedEvent.event);
  if (streamError) {
    await callbacks.onError?.(streamError);
    throw streamError;
  }

  const metadata = extractWebSearchMetadata(payload, parsedEvent.event);
  if (metadata) await callbacks.onMeta?.(metadata);

  const usage = extractUsage(payload);
  if (usage) await callbacks.onUsage?.(usage);

  for (const content of extractContent(payload)) {
    await callbacks.onContent?.(content);
  }

  return false;
}

/**
 * Consumes an OpenAI-compatible server-sent event stream.
 *
 * The parser is byte-boundary safe, supports all SSE line endings and multiline
 * `data:` fields, and stops at the first `[DONE]` sentinel. Reasoning-only
 * fields are intentionally ignored.
 */
export async function consumeChatStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: ChatStreamCallbacks = {},
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let finished = false;

  const dispatchEvent = async (): Promise<void> => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const parsedEvent: ParsedSseEvent = {
      event: eventName,
      data: dataLines.join("\n"),
    };
    eventName = "message";
    dataLines = [];
    finished = await parseEvent(parsedEvent, callbacks);
  };

  const processLine = async (line: string): Promise<void> => {
    if (line.length === 0) {
      await dispatchEvent();
      return;
    }
    if (line.startsWith(":")) return;

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value || "message";
  };

  const drainLines = async (final: boolean): Promise<void> => {
    while (!finished) {
      let lineEndingIndex = -1;
      for (let index = 0; index < textBuffer.length; index += 1) {
        const character = textBuffer[index];
        if (character === "\n" || character === "\r") {
          lineEndingIndex = index;
          break;
        }
      }

      if (lineEndingIndex === -1) break;
      if (
        textBuffer[lineEndingIndex] === "\r" &&
        lineEndingIndex === textBuffer.length - 1 &&
        !final
      ) {
        break;
      }

      const line = textBuffer.slice(0, lineEndingIndex);
      const endingLength =
        textBuffer[lineEndingIndex] === "\r" &&
        textBuffer[lineEndingIndex + 1] === "\n"
          ? 2
          : 1;
      textBuffer = textBuffer.slice(lineEndingIndex + endingLength);
      await processLine(line);
    }

    if (final && !finished && textBuffer.length > 0) {
      const finalLine = textBuffer;
      textBuffer = "";
      await processLine(finalLine);
    }
    if (final && !finished) await dispatchEvent();
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      textBuffer += decoder.decode(value, { stream: true });
      await drainLines(false);
    }

    if (!finished) {
      textBuffer += decoder.decode();
      await drainLines(true);
    }
  } finally {
    reader.releaseLock();
  }
}
