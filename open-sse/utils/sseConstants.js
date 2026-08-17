// Shared SSE primitives (no imports → safe for executors + stream.js)
export const SSE_DONE = "data: [DONE]\n\n";

// SSE comment line — valid per spec, ignored by all compliant clients.
// Sent periodically on idle chat streams to keep proxies/LBs from
// timing out the connection while the model "thinks" silently.
export const SSE_KEEPALIVE_COMMENT = ": keepalive\n\n";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive"
};

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
};

// Variant for client-facing SSE responses (adds permissive CORS)
export const SSE_HEADERS_CORS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
};
