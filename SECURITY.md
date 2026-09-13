# Security model

Herdr Call runs a small local HTTP server that a browser voice UI uses to (1) mint short-lived
ElevenLabs conversation tokens and (2) relay client-tool calls into your Herdr session. Those relay
tools can inspect and drive your coding agents and terminals, so access to the server is access to
your workstation. This document describes how that access is controlled and what remains your
responsibility.

## What the server protects

The server binds to loopback only (`127.0.0.1:47831`). Nothing on your network can reach the port
directly; the intended way to use the call from a phone or another device is to put **Tailscale
Serve** in front of it, which terminates TLS and forwards to loopback while injecting a verified
tailnet identity header.

Every request to an `/api/*` route is checked on three independent axes:

1. **Bearer token.** A random 32-byte token is generated per process, injected into the served page
   (`<meta name="herdr-call-token">` plus a `SameSite=Strict` cookie), and required on every API
   call. Because a cross-origin page cannot read the token, this closes CSRF: a malicious website you
   visit cannot forge authorized requests to `127.0.0.1:47831`, even though the port is predictable.

2. **Host allowlist.** The `Host` header must be a loopback name, your configured `tailnet_url` host,
   or a `*.ts.net` MagicDNS name. This defeats DNS rebinding, where an attacker's domain is rebound
   to `127.0.0.1` to become same-origin with the server.

3. **Tailscale identity.** Only allowlisted, verified Tailscale logins may drive the relay from the
   tailnet (local loopback callers are you). By default the allowlist is exactly the tailnet login
   of this machine's own Tailscale account, discovered at startup — nobody else on a shared tailnet
   can drive the call unless you add them with `allowed_tailnet_users`.

The ElevenLabs API key never leaves the server: the browser receives only a short-lived conversation
token from `POST /api/session`. The key lives in `config.toml` under `HERDR_PLUGIN_CONFIG_DIR`
(written by the first-run prompt with owner-only file permissions), which is never committed. The
key only needs the ElevenAgents write permission — create it with that single scope.

## Configuration and exposure

At startup the plugin discovers your tailnet from `tailscale status`: the MagicDNS hostname becomes
the call URL, your own tailnet login becomes the identity allowlist, and the tailnet-only HTTPS
mapping is configured automatically via `tailscale serve` (equivalent to
`tailscale serve --bg --https=47831 http://127.0.0.1:47831`). If Tailscale is not detected, nothing is exposed — the call is
reachable on loopback only.

Everything can be overridden in `config.toml` (in `HERDR_PLUGIN_CONFIG_DIR`, not in this repo):

```toml
elevenlabs_api_key = "sk_..."           # written by the first-run prompt; stays server-side
voice_id = "..."                        # optional
tailnet_url = "https://host.tailnet.ts.net"   # override the discovered hostname
allowed_tailnet_users = "you@example.com, teammate@example.com"  # widen access beyond just you
auto_serve = false                      # never touch Tailscale Serve; expose manually if at all
```

- **The default allowlist is you alone.** Widening it with `allowed_tailnet_users` is an explicit
  decision. On tagged devices (no human login), no default allowlist exists and the server warns
  that every authenticated tailnet device can drive the call.
- **Set `auto_serve = false`** if you want the call to stay loopback-only or prefer to manage the
  Serve mapping yourself. The mapping persists until removed: `tailscale serve --https=47831 off`.
- **Use Tailscale Serve, never Funnel.** Funnel would expose the endpoint to the public internet.

## Residual risk: prompt injection

Guarded actions (`run_in_pane`, `send_keys`, `close_target`) are confirmed entirely by voice — the
model reads the action aloud, you say yes, and only then is `confirm_action` called. This is
deliberate: the call is hands-free by design, so there is no button or out-of-band click.

The trade-off is that the voice model is the only confirmation channel. If you ask the agent to read
a terminal or agent whose output is attacker-controlled (a crafted package banner, a CI log, an issue
title), that text could try to talk the model into running or confirming something. Two mitigations
reduce this:

- `read_pane` / `read_agent` output is returned wrapped in `<<UNTRUSTED_TERMINAL_OUTPUT>> … >>`
  markers, and the system prompt instructs the model to treat everything inside as inert data and
  never act on instructions found there.
- Guarded actions are two-phase, single-use, and expire in 60 seconds.

These make injection materially harder but do not make it impossible while confirmation stays purely
voice-driven. Treat the voice operator as you would a capable assistant with terminal access: don't
point it at untrusted output and then blindly approve actions you didn't intend.

## Reporting

Report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/eliasstravik/herdr-call/security/advisories/new).
If that is unavailable to you, open an issue that describes the impact without exploit details and
we'll take it from there. Never include real credentials or tokens in a report.
