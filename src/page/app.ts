import { Conversation, type Conversation as ConversationInstance } from "@elevenlabs/client";

import { TOOL_DEFINITIONS } from "../shared/tools.js";

const startButton = element<HTMLButtonElement>("start-call");
const muteButton = element<HTMLButtonElement>("mute-call");
const endButton = element<HTMLButtonElement>("end-call");
const startControls = element<HTMLElement>("start-controls");
const callControls = element<HTMLElement>("call-controls");
const statusText = element<HTMLElement>("status-text");
const statusDot = element<HTMLElement>("status-dot");
const durationElement = element<HTMLElement>("call-duration");
const errorElement = element<HTMLElement>("error-message");

let conversation: ConversationInstance | null = null;
let eventSource: EventSource | null = null;
let durationTimer: number | undefined;
let callStartedAt = 0;
let muted = false;

const authToken =
  document.querySelector<HTMLMetaElement>('meta[name="herdr-call-token"]')?.content ?? "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${authToken}`, ...extra };
}

const clientTools = Object.fromEntries(
  TOOL_DEFINITIONS.map((tool) => [
    tool.name,
    async (parameters: unknown) => {
      const response = await fetch("/api/tool", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name: tool.name, arguments: parameters }),
      });
      const payload = (await response.json()) as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Tool ${tool.name} failed`);
      return JSON.stringify(payload.result ?? null);
    },
  ]),
);

startButton.addEventListener("click", () => void startCall());
muteButton.addEventListener("click", toggleMute);
endButton.addEventListener("click", () => void endCall());
window.addEventListener("beforeunload", () => {
  eventSource?.close();
  void conversation?.endSession();
});

if (!window.isSecureContext) {
  startButton.disabled = true;
  showError("Microphone access requires HTTPS. Open this page through Tailscale Serve.");
}

async function startCall(): Promise<void> {
  if (conversation) return;
  clearError();
  startButton.disabled = true;
  setStatus("connecting", "Requesting microphone access…");

  try {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of permissionStream.getTracks()) track.stop();

    setStatus("connecting", "Connecting privately…");
    const tokenResponse = await fetch("/api/session", { method: "POST", headers: authHeaders() });
    const token = (await tokenResponse.json()) as {
      conversation_token?: string;
      error?: string;
    };
    if (!tokenResponse.ok || !token.conversation_token) {
      throw new Error(token.error ?? "Could not create a voice session");
    }

    conversation = await Conversation.startSession({
      conversationToken: token.conversation_token,
      connectionType: "webrtc",
      clientTools,
      onConnect: () => setConnected(),
      onDisconnect: () => setDisconnected(),
      onError: (message) => showError(message),
      onModeChange: ({ mode }) => {
        document.body.dataset.callState = mode;
        setStatus(mode, mode === "speaking" ? "Agent speaking" : muted ? "Microphone muted" : "Listening");
      },
    });
  } catch (error) {
    conversation = null;
    startButton.disabled = false;
    setStatus("error", "Could not connect");
    showError(error instanceof Error ? error.message : "Could not start the call");
  }
}

function setConnected(): void {
  document.body.dataset.callState = "connected";
  startControls.hidden = true;
  callControls.hidden = false;
  callStartedAt = Date.now();
  durationElement.hidden = false;
  updateDuration();
  durationTimer = window.setInterval(updateDuration, 1_000);
  setStatus("connected", "Connected");
  openEventStream();
}

function openEventStream(): void {
  eventSource?.close();
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("context", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { text?: string };
    if (payload.text) conversation?.sendContextualUpdate(payload.text);
  });
}

function toggleMute(): void {
  if (!conversation) return;
  muted = !muted;
  conversation.setMicMuted(muted);
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButton.textContent = muted ? "Unmute" : "Mute";
  setStatus(muted ? "ready" : "listening", muted ? "Muted" : "Listening");
}

async function endCall(): Promise<void> {
  const active = conversation;
  conversation = null;
  eventSource?.close();
  eventSource = null;
  if (active) await active.endSession();
  setDisconnected();
}

function setDisconnected(): void {
  conversation = null;
  eventSource?.close();
  eventSource = null;
  if (durationTimer !== undefined) window.clearInterval(durationTimer);
  durationTimer = undefined;
  durationElement.hidden = true;
  callControls.hidden = true;
  startControls.hidden = false;
  startButton.disabled = false;
  muted = false;
  muteButton.setAttribute("aria-pressed", "false");
  muteButton.textContent = "Mute";
  document.body.dataset.callState = "ready";
  setStatus("ready", "Ready");
}

function updateDuration(): void {
  const elapsed = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1_000));
  const minutes = Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  durationElement.textContent = `${minutes}:${seconds}`;
}

function setStatus(state: string, text: string): void {
  statusDot.dataset.state = state;
  statusText.textContent = text;
}

function showError(message: string): void {
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearError(): void {
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing page element: ${id}`);
  return value as T;
}
