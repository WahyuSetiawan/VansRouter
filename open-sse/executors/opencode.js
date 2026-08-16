import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import crypto from "crypto";
import { resolveSessionId } from "../utils/sessionManager.js";

// OpenCode free tier limits requests per egress IP.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body, stream, credentials) {
    const session = resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.connectionId, scope: "opencode" });
    if (credentials) credentials.runtimeOpencodeSession = `ses_${String(session || crypto.randomUUID()).replace(/^ses_/, "").replaceAll("-", "")}`;
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const raw = Object.fromEntries(Object.entries(credentials?.rawHeaders || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": raw["user-agent"]?.toLowerCase().includes("opencode") ? raw["user-agent"] : "opencode",
      "x-opencode-client": raw["x-opencode-client"] || "desktop",
      "x-opencode-session": raw["x-opencode-session"] || credentials?.runtimeOpencodeSession || `ses_${crypto.randomUUID().replaceAll("-", "")}`,
      "x-opencode-request": raw["x-opencode-request"] || `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      "x-opencode-project": raw["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*"
    };
  }

  parseError(response, bodyText) {
    const status = response?.status || 0;
    const text = String(bodyText || "");
    if ((status === 429 || status === 403) && IP_LIMIT_BODY.test(text)) {
      return {
        status,
        message: text.slice(0, 300) || `OpenCode free limit (${status})`,
        poolScoped: { reason: "ip-limit" },
      };
    }
    return null;
  }
}
