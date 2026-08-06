# Getting started — take your first call

This guide takes you from nothing installed to talking with your Herdr session from your phone, in about five minutes.

## 1. Check the prerequisites

- [Herdr](https://herdr.dev) 0.8.0 or newer.
- Node 20 or newer and npm on your `PATH`.
- An [ElevenLabs](https://elevenlabs.io) account.
- [Tailscale](https://tailscale.com) running on this machine and on the device you'll call from.

## 2. Install the plugin

```bash
herdr plugin install eliasstravik/herdr-call
```

The install runs `npm ci` and `npm run build` inside the plugin directory. Nothing else is downloaded or executed.

## 3. Paste your ElevenLabs key

1. Create an API key at [elevenlabs.io → API keys](https://elevenlabs.io/app/settings/api-keys) with **only the ElevenAgents write permission** — nothing else is needed; leave every other permission off.
2. Run the **Start voice call** action in Herdr.
3. Paste the key when the call pane asks — first run only.

The plugin saves the key server-side (readable only by your user), provisions the voice agent and its 26 tools automatically, and never sends the key to the browser.

## 4. Call your agent

Everything else configures itself:

- Your tailnet hostname is discovered from Tailscale, so the call URL becomes `https://<your-machine>.<your-tailnet>.ts.net:47831`.
- The persistent tailnet-only HTTPS mapping is configured through Tailscale Serve automatically.
- Access is locked to your own tailnet login by default.

The pane prints the call URL and a QR code. Scan it with your phone — or open the page right there on your desk — and press **Start call**.

## 5. Confirm the call works

Say hello, then try:

- *"What are my agents doing?"* — you should hear a spoken summary of your workspaces and agents.
- *"Tell the api agent to fix the failing tests, and let me know when it's done."*
- *"Run `git status` in the deploy pane."* — the exact command is read back to you and runs only after you say yes.

## Optional configuration

Everything below is optional. `config.toml` lives in the plugin's `HERDR_PLUGIN_CONFIG_DIR` (Herdr shows the path in `herdr plugin list`):

| Key | Default | Purpose |
|---|---|---|
| `elevenlabs_api_key` | written by the first-run prompt | ElevenLabs API key; stays server-side |
| `voice_id` | a built-in default voice | Use a different ElevenLabs voice |
| `tailnet_url` | discovered from Tailscale | Override the call URL and Host allowlist |
| `allowed_tailnet_users` | your own tailnet login | Widen access, e.g. `"you@example.com, teammate@example.com"` |
| `auto_serve` | `true` | Set `false` to never touch Tailscale Serve |

With `auto_serve = false`, expose the call yourself when you want it reachable:

```bash
tailscale serve --bg 47831        # tailnet-only; remove with: tailscale serve --https=47831 off
```

Use **Serve**, never **Funnel** — Funnel would expose the endpoint to the public internet.

## Security

Access to this server is access to your workstation, so read [`SECURITY.md`](../SECURITY.md). The defaults are safe — tailnet-only HTTPS, access limited to your own tailnet login, and spoken confirmation for every command — but don't point the voice agent at untrusted terminal output and then approve actions you didn't intend.

## Development

```bash
npm install
npm run check   # type-check
npm test        # unit tests
npm run build   # produce dist/
```

## Troubleshooting

- **"Tailscale was not detected" in the pane:** Start Tailscale on this machine, then restart the call pane. Until then the call works on this machine only, at `http://127.0.0.1:47831`.
- **Tailscale Serve fails with a permissions error (Linux):** Make your user the Tailscale operator with `sudo tailscale set --operator=$USER`, or run the printed manual command with `sudo`.
- **The phone can't open the call URL:** Confirm the phone is on the same tailnet and Tailscale is connected on it.
- **The microphone never activates:** Open the `https://…ts.net:47831` URL — microphone access needs the HTTPS page, not `http://127.0.0.1`.
- **ElevenLabs rejects the key:** Confirm the key has the ElevenAgents write permission, then correct `elevenlabs_api_key` in `config.toml` and restart the call pane.
- **Someone else on the tailnet should join the call:** Add their tailnet login to `allowed_tailnet_users` — by default only you are allowed.

For more help, [open an issue](https://github.com/eliasstravik/herdr-call/issues).
