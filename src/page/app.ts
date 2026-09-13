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
let levelFrame: number | undefined;
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
        setStatus(mode, mode === "speaking" ? "Desk speaking" : muted ? "Microphone muted" : "Listening");
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
  startLevelMeter();
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
  stopLevelMeter();
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

// The orb follows who is actually talking, not just whose turn it is: the SDK
// exposes smoothed microphone and playback volumes (0..1), which we ease a
// little more and hand to CSS as custom properties plus a data-voice flag.
const VOICE_THRESHOLD = 0.04;
let inLevel = 0;
let outLevel = 0;

function startLevelMeter(): void {
  stopLevelMeter();
  const tick = (): void => {
    const active = conversation;
    if (!active) return;
    const rawIn = muted ? 0 : clamp01(active.getInputVolume());
    const rawOut = clamp01(active.getOutputVolume());
    // Rise quickly, fall slowly, so speech reads as a glow rather than a flicker.
    inLevel = rawIn > inLevel ? inLevel + (rawIn - inLevel) * 0.55 : inLevel * 0.86;
    outLevel = rawOut > outLevel ? outLevel + (rawOut - outLevel) * 0.55 : outLevel * 0.86;
    const style = document.body.style;
    style.setProperty("--voice-in", inLevel.toFixed(3));
    style.setProperty("--voice-out", outLevel.toFixed(3));
    document.body.dataset.voice =
      outLevel > VOICE_THRESHOLD && outLevel >= inLevel
        ? "agent"
        : inLevel > VOICE_THRESHOLD
          ? "user"
          : "idle";
    levelFrame = window.requestAnimationFrame(tick);
  };
  levelFrame = window.requestAnimationFrame(tick);
}

function stopLevelMeter(): void {
  if (levelFrame !== undefined) window.cancelAnimationFrame(levelFrame);
  levelFrame = undefined;
  inLevel = 0;
  outLevel = 0;
  document.body.style.removeProperty("--voice-in");
  document.body.style.removeProperty("--voice-out");
  delete document.body.dataset.voice;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
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
