import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { authorizeHost, authorizeRequest, createAuthPolicy, tokenCookie } from "./auth.js";

export interface RelayHandler {
  handle(name: string, input: unknown): Promise<unknown>;
}

export interface SessionProvider {
  createSession(): Promise<{ conversationToken: string; conversationId: string }>;
}

export interface CallServerOptions {
  relay: RelayHandler;
  sessionProvider: SessionProvider;
  authToken: string;
  eventHub?: CallEventHub;
  assetsDirectory?: string;
  tailnetUrl?: string;
  allowedTailnetUsers?: readonly string[];
}

const TOKEN_PLACEHOLDER = "__HERDR_CALL_TOKEN__";

export class CallEventHub {
  readonly #clients = new Set<ServerResponse>();

  connect(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write("retry: 3000\n\n");
    this.#clients.add(response);

    const remove = () => this.#clients.delete(response);
    request.once("close", remove);
    response.once("close", remove);
  }

  publish(event: string, data: unknown): void {
    if (!/^[a-z0-9_-]+$/i.test(event)) throw new Error(`Invalid SSE event name: ${event}`);
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#clients) client.write(message);
  }
}

export function createCallServer(options: CallServerOptions): Server {
  const eventHub = options.eventHub ?? new CallEventHub();
  const policy = createAuthPolicy({
    token: options.authToken,
    ...(options.tailnetUrl ? { tailnetUrl: options.tailnetUrl } : {}),
    ...(options.allowedTailnetUsers ? { allowedTailnetUsers: options.allowedTailnetUsers } : {}),
  });
  return createServer(async (request, response) => {
    setCommonHeaders(response);

    try {
      const isApiRoute = (request.url ?? "").startsWith("/api/");
      const auth = isApiRoute
        ? authorizeRequest(policy, request)
        : authorizeHost(policy, request);
      if (!auth.ok) {
        sendJson(response, auth.status, { error: auth.message });
        return;
      }

      if (request.method === "POST" && request.url === "/api/session") {
        const session = await options.sessionProvider.createSession();
        sendJson(
          response,
          200,
          {
            conversation_token: session.conversationToken,
            conversation_id: session.conversationId,
          },
          { "Cache-Control": "no-store" },
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/tool") {
        if (!isJsonContentType(request)) {
          sendJson(response, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const body = asRecord(await readJsonBody(request));
        if (typeof body.name !== "string") {
          sendJson(response, 400, { error: "Tool name is required" });
          return;
        }
        const result = await options.relay.handle(body.name, body.arguments ?? {});
        sendJson(response, 200, { result }, { "Cache-Control": "no-store" });
        return;
      }
      if (request.method === "GET" && request.url === "/api/events") {
        eventHub.connect(request, response);
        return;
      }
      if (request.method === "GET" && options.assetsDirectory) {
        const asset = staticAsset(request.url);
        if (asset) {
          const rawContents = await readFile(join(options.assetsDirectory, asset.file));
          const headers: Record<string, string> = {
            "Content-Type": asset.contentType,
            "Cache-Control": asset.file === "index.html" ? "no-store" : "public, max-age=3600",
          };
          if (asset.file === "index.html") {
            headers["Set-Cookie"] = tokenCookie(options.authToken);
            const html = rawContents.toString("utf8").replaceAll(TOKEN_PLACEHOLDER, options.authToken);
            response.writeHead(200, headers);
            response.end(html);
            return;
          }
          response.writeHead(200, headers);
          response.end(rawContents);
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  });
}

function isJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.split(";")[0]?.trim() === "application/json";
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function staticAsset(url: string | undefined): { file: string; contentType: string } | undefined {
  const pathname = new URL(url ?? "/", "http://127.0.0.1").pathname;
  const assets: Record<string, { file: string; contentType: string }> = {
    "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  };
  return assets[pathname];
}
