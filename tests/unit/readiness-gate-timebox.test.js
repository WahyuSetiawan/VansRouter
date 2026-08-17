// Readiness-gate time-box (Task 1.A): handleStreamingResponse must release the
// HTTP 200 + SSE headers within STREAM_READINESS_PEEK_TIMEOUT_MS (default 500ms)
// even when the upstream's first byte is slow, so a slow-to-start upstream can't
// hold the client's headers hostage for the full TTFT. The deferred first chunk
// is handed to the reconstructed stream and delivered once it arrives.
import { describe, it, expect } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

function makeController() {
  return createStreamController({
    onDisconnect: () => {},
    onError: () => {},
    provider: "agentrouter",
    model: "glm-5.2"
  });
}

const baseCtx = {
  provider: "agentrouter",
  model: "glm-5.2",
  sourceFormat: "claude",
  targetFormat: "openai",
  userAgent: "test",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  translatedBody: null,
  finalBody: null,
  requestStartTime: Date.now(),
  connectionId: "conn-1",
  apiKey: "sk-test",
  apiKeyName: "test-key",
  clientRawRequest: null,
  onRequestSuccess: null,
  reqLogger: null,
  toolNameMap: new Map(),
  onStreamComplete: () => {}
};

// Upstream whose first byte only appears after `delayMs`.
function makeSlowFirstChunkResponse(delayMs, chunk) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start() {
        // Delay before the stream yields any chunk.
        return new Promise((resolve) => setTimeout(resolve, delayMs));
      },
      pull(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("readiness-gate time-box", () => {
  it("fast upstream first byte → success returned promptly", async () => {
    const t0 = Date.now();
    const result = await handleStreamingResponse({
      ...baseCtx,
      providerResponse: makeSlowFirstChunkResponse(20, "data: {\"ok\":true}\n\n"),
      streamController: makeController()
    });
    const elapsed = Date.now() - t0;
    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(400); // well under the 500ms budget
  });

  it("slow upstream first byte (>500ms) → Response still returned within the ~500ms budget (not waiting for TTFT)", async () => {
    const t0 = Date.now();
    const result = await handleStreamingResponse({
      ...baseCtx,
      providerResponse: makeSlowFirstChunkResponse(1500, "data: {\"ok\":true}\n\n"),
      streamController: makeController()
    });
    const elapsed = Date.now() - t0;
    expect(result.success).toBe(true);
    // The readiness gate must NOT block for the full 1500ms upstream delay —
    // it returns once the 500ms peek timeout fires, so elapsed << 1500ms.
    expect(elapsed).toBeLessThan(1200);
  });
});
