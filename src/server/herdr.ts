import { createConnection, type Socket } from "node:net";

export interface HerdrClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
}

export interface HerdrRequestOptions {
  timeoutMs?: number;
}

export class HerdrRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

interface ResponseEnvelope {
  id: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface HerdrEventEnvelope<T = unknown> {
  event: string;
  data: T;
}

export type HerdrEventListener = (event: HerdrEventEnvelope) => void;

export class HerdrClient {
  readonly #socketPath: string;
  readonly #requestTimeoutMs: number;
  readonly #eventListeners = new Set<HerdrEventListener>();
  readonly #sockets = new Set<Socket>();
  #requestNumber = 0;

  constructor(options: HerdrClientOptions) {
    this.#socketPath = options.socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  onEvent(listener: HerdrEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    options: HerdrRequestOptions = {},
  ): Promise<unknown> {
    const id = `herdr-call-${++this.#requestNumber}`;
    const keepOpen = method === "events.subscribe";

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      this.#sockets.add(socket);
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Herdr request timed out: ${method}`));
      }, options.timeoutMs ?? this.#requestTimeoutMs);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      };

      const handleMessage = (message: ResponseEnvelope | HerdrEventEnvelope) => {
        if ("event" in message) {
          for (const listener of this.#eventListeners) listener(message);
          return;
        }
        if (message.id !== id || settled) return;

        settled = true;
        clearTimeout(timeout);
        if (message.error) {
          socket.destroy();
          reject(new HerdrRequestError(message.error.code, message.error.message));
          return;
        }

        resolve(message.result);
        if (!keepOpen) socket.end();
      };

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error) fail(error);
        });
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              handleMessage(JSON.parse(line) as ResponseEnvelope | HerdrEventEnvelope);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", fail);
      socket.on("close", () => {
        this.#sockets.delete(socket);
        if (!settled) fail(new Error("Herdr socket closed"));
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }
}
