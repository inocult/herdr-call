import assert from "node:assert/strict";
import { test } from "node:test";

import { ElevenLabsSessionProvider } from "../src/server/elevenlabs.js";

test("session provider mints a WebRTC token server-side with the API key header", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const provider = new ElevenLabsSessionProvider({
    apiKey: "server-secret-key",
    agentId: "agent_123",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ token: "ephemeral-token", conversation_id: "conversation-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const session = await provider.createSession();

  assert.deepEqual(session, {
    conversationToken: "ephemeral-token",
    conversationId: "conversation-123",
  });
  assert.equal(
    requests[0]?.url,
    "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_123",
  );
  assert.equal(new Headers(requests[0]?.init?.headers).get("xi-api-key"), "server-secret-key");
  assert.doesNotMatch(JSON.stringify(session), /server-secret-key/);
});
