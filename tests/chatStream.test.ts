import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatStreamError,
  consumeChatStream,
  type ChatStreamUsage,
  type MiraWebSearchMetadata,
} from "../src/chatStream.ts";

const encoder = new TextEncoder();

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return streamFromChunks([encoder.encode(text)]);
}

test("decodes UTF-8 content split at every byte boundary", async () => {
  const sse = `data: ${JSON.stringify({
    choices: [{ delta: { content: "안녕 🌍" } }],
  })}\n\ndata: [DONE]\n\n`;
  const byteChunks = Array.from(encoder.encode(sse), (byte) =>
    Uint8Array.of(byte),
  );
  let content = "";

  await consumeChatStream(streamFromChunks(byteChunks), {
    onContent(delta) {
      content += delta;
    },
  });

  assert.equal(content, "안녕 🌍");
});

test("supports CRLF, comments, event fields, and multiline data", async () => {
  const sse = [
    ": keep-alive",
    "event: message",
    "id: 42",
    'data: {"choices":[',
    'data: {"delta":{"content":"multiline"}}',
    "data: ]}",
    "",
    "data: [DONE]",
    "",
  ].join("\r\n");
  let content = "";

  await consumeChatStream(streamFromText(sse), {
    onContent(delta) {
      content += delta;
    },
  });

  assert.equal(content, "multiline");
});

test("normalizes OpenAI-compatible usage fields", async () => {
  const events = [
    `data: ${JSON.stringify({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  let usage: ChatStreamUsage | undefined;

  await consumeChatStream(streamFromText(events), {
    onUsage(nextUsage) {
      usage = nextUsage;
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
});

test("delivers MIRA metadata before later content", async () => {
  const sse = [
    "event: mira-meta",
    `data: ${JSON.stringify({
      webSearch: {
        mode: "auto",
        status: "not-used",
        reason: "stable_question",
      },
    })}`,
    "",
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "answer" } }],
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const callbackOrder: string[] = [];
  let metadata: MiraWebSearchMetadata | undefined;

  await consumeChatStream(streamFromText(sse), {
    onMeta(nextMetadata) {
      metadata = nextMetadata;
      callbackOrder.push("meta");
    },
    onContent() {
      callbackOrder.push("content");
    },
  });

  assert.deepEqual(callbackOrder, ["meta", "content"]);
  assert.deepEqual(metadata, {
    mode: "auto",
    status: "unused",
    used: false,
    reason: "stable_question",
    sources: [],
  });
});

test("rejects unsafe sources, deduplicates URLs, and keeps at most eight", async () => {
  const validSources = Array.from({ length: 10 }, (_, index) => ({
    url: `https://source-${index}.example/article`,
    title: `Source ${index}`,
  }));
  const sse = [
    "event: mira-meta",
    `data: ${JSON.stringify({
      webSearch: {
        mode: "on",
        status: "used",
        sources: [
          { url: "javascript:alert(1)", title: "Unsafe" },
          { url: "data:text/html,unsafe", title: "Unsafe data" },
          { url: "https://www.Example.com/path#first", title: "First" },
          { url: "https://example.com/path", title: "Duplicate" },
          ...validSources,
        ],
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  let metadata: MiraWebSearchMetadata | undefined;

  await consumeChatStream(streamFromText(sse), {
    onMeta(nextMetadata) {
      metadata = nextMetadata;
    },
  });

  assert.ok(metadata);
  assert.equal(metadata.sources.length, 8);
  assert.equal(metadata.sources[0]?.url, "https://www.example.com/path");
  assert.equal(metadata.sources[0]?.domain, "example.com");
  assert.equal(metadata.sources[1]?.url, "https://source-0.example/article");
  assert.ok(
    metadata.sources.every(
      (source) =>
        source.url.startsWith("https://") || source.url.startsWith("http://"),
    ),
  );
});

test("stops consuming events after the DONE sentinel", async () => {
  const sse = [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "before" } }],
    })}`,
    "",
    "data: [DONE]",
    "",
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "after" } }],
    })}`,
    "",
  ].join("\n");
  let content = "";

  await consumeChatStream(streamFromText(sse), {
    onContent(delta) {
      content += delta;
    },
  });

  assert.equal(content, "before");
});

test("surfaces an upstream SSE error through callback and rejection", async () => {
  const sse = [
    "event: error",
    `data: ${JSON.stringify({
      error: {
        type: "webSearch_balance_required",
        message: "Web search balance is required.",
        code: "insufficient_balance",
        status: 402,
      },
    })}`,
    "",
  ].join("\n");
  let callbackError: ChatStreamError | undefined;

  await assert.rejects(
    consumeChatStream(streamFromText(sse), {
      onError(error) {
        callbackError = error;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChatStreamError);
      assert.equal(error.type, "webSearch_balance_required");
      assert.equal(error.code, "insufficient_balance");
      assert.equal(error.status, 402);
      assert.equal(error.message, "Web search balance is required.");
      return true;
    },
  );

  assert.equal(callbackError?.type, "webSearch_balance_required");
});

test("preserves string errors and error finish reasons from compatible providers", async () => {
  await assert.rejects(
    consumeChatStream(
      streamFromText(`data: ${JSON.stringify({ error: "provider failed" })}\n\n`),
    ),
    /provider failed/,
  );

  await assert.rejects(
    consumeChatStream(
      streamFromText(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "error" }] })}\n\n`,
      ),
    ),
    /스트리밍 응답 중 오류/,
  );
});
