import type { SessionProvider } from "./http.js";

export interface ElevenLabsSessionProviderOptions {
  apiKey: string;
  agentId: string;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}

export class ElevenLabsSessionProvider implements SessionProvider {
  readonly #apiKey: string;
  readonly #agentId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBaseUrl: string;

  constructor(options: ElevenLabsSessionProviderOptions) {
    if (!options.apiKey) throw new Error("ElevenLabs API key is required");
    if (!options.agentId) throw new Error("ElevenLabs agent id is required");
    this.#apiKey = options.apiKey;
    this.#agentId = options.agentId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.elevenlabs.io";
  }

  async createSession(): Promise<{ conversationToken: string; conversationId: string }> {
    const url = new URL("/v1/convai/conversation/token", this.#apiBaseUrl);
    url.searchParams.set("agent_id", this.#agentId);
    const response = await this.#fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "xi-api-key": this.#apiKey,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs conversation token request failed (${response.status})`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.token !== "string" || typeof body.conversation_id !== "string") {
      throw new Error("ElevenLabs conversation token response was malformed");
    }
    return {
      conversationToken: body.token,
      conversationId: body.conversation_id,
    };
  }
}
