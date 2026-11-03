# shopee-mcp — per-server runbook

Gives Bots read access to Shopee (product search, detail, reviews, shops, flash
sales) through the unofficial [`@bintangtimurlangit/shopee-mcp`](https://github.com/bintangtimurlangit/shopee-mcp)
MCP server, mounted as a DS Bot **capability** (stdio transport). No code
changes — everything below is runtime setup, done once per server.

Facts that shape the setup:

- Shopee blocks anonymous and headless requests. `shopee-mcp` drives a real
  **headed** Chromium (CloakBrowser) with a persistent profile; on a headless
  server it must run under `xvfb`.
- Login is **interactive** (OTP/captcha possible) and the session lives on the
  machine in `~/.shopee-mcp/chrome-profile`. One login per server.
- The capability is mounted per Bot session and spawns one browser per mount —
  attach it to **one** Bot only; concurrent instances share the same Chrome
  profile and can conflict.

## 1. Install

```sh
npm install -g @bintangtimurlangit/shopee-mcp   # Node >= 18, downloads CloakBrowser (~200 MB)
command -v shopee-mcp shopee-mcp-login          # both must be on PATH
```

Headless server only:

```sh
sudo apt-get install -y xvfb x11vnc            # x11vnc only needed for the login step
```

## 2. Log in once (needs a person)

`shopee-mcp-login` opens a browser window where a human signs into Shopee.
On a desktop just run `shopee-mcp-login`. On a headless server, expose the
virtual display over VNC:

```sh
Xvfb :99 -screen 0 1280x900x24 &               # virtual display
x11vnc -display :99 -localhost -nopw -once &   # VNC on localhost:5900
DISPLAY=:99 shopee-mcp-login
```

SSH-tunnel `5900` (`ssh -L 5900:localhost:5900 server`), connect a VNC client,
sign in, then press Enter in the terminal. The session is saved to
`~/.shopee-mcp/chrome-profile`; kill the `Xvfb`/`x11vnc` processes afterwards.

Do not copy a profile between OSes — Chrome encrypts cookies with the local
OS keyring, so copied cookies can fail to decrypt.

## 3. Add the capability

In the DS Bot UI: **Settings → Capabilities → Add capability**, then:

| Field | Headless Linux server | Machine with a display |
| ----- | --------------------- | ---------------------- |
| Name | `shopee` | `shopee` |
| Type | `MCP server` | `MCP server` |
| Connection | `Local command` | `Local command` |
| Command | `xvfb-run` | `shopee-mcp` |
| Arguments (one per line) | `-a`<br>`shopee-mcp` | _(empty)_ |
| Environment (JSON) | `{"SHOPEE_DOMAIN": "shopee.vn", "SHOPEE_ACCOUNT_TOOLS": "off"}` | same |

- `SHOPEE_DOMAIN`: the regional domain the login was made on
  (`shopee.vn`, `shopee.co.id`, `shopee.com.my`, …).
- `SHOPEE_ACCOUNT_TOOLS=off` keeps the server strictly read-only. With `auto`,
  a logged-in session also exposes `add_to_cart`, `like_product`,
  `follow_shop`, `claim_shop_voucher` — tools that **modify the account**.
- On Windows the `shopee-mcp` command is a `.cmd` shim that `spawn()` cannot
  resolve; use command `node` with the absolute path to
  `node_modules/@bintangtimurlangit/shopee-mcp/build/index.js` as the single
  argument instead.

## 4. Attach to one Bot

**Settings → Bots → (the Bot) → Capabilities → switch `shopee` on.** The row
shows `Ready` once the mount succeeds. Saved capabilities survive restarts —
nothing needs re-enabling after a reboot.

## 5. Verify

Ask the Bot, or call through the client:

- `check_login_status` → "Logged in to shopee.vn" (or the "not signed in"
  prompt → redo step 2)
- `search_products` `{"query": "bơm lốp ô tô"}` → a priced product list

## Operations

- **Re-login** when tools start answering "Not signed in" — Shopee sessions
  expire. `check_login_status` reports the state; rerun step 2.
- **Upgrades**: `npm install -g @bintangtimurlangit/shopee-mcp@latest`. Newer
  CloakBrowser binaries matter — Shopee's anti-bot detection is a moving
  target and stale binaries start failing with `error 90309999`.
- **Remove**: detach the capability in the Bot's settings, delete it in
  Capabilities, then `npm uninstall -g @bintangtimurlangit/shopee-mcp` and
  delete `~/.shopee-mcp`.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `Not signed in` / tools return the login prompt | Session missing or expired → step 2 |
| `error 90309999` or empty results | Anti-bot rejected the request — confirm the command is headed (`xvfb-run` on servers), upgrade the package, retry |
| Capability status `Could not connect` | `xvfb-run` missing, `shopee-mcp` not on PATH, or first CloakBrowser download still running — check stderr, toggle the switch again |
| Status `Needs approval` | Capability was created by a Bot, not the UI — click **Allow** in Settings → Capabilities |
| Second Bot's mount fails / profile errors | Two mounts share `~/.shopee-mcp/chrome-profile` — keep it attached to one Bot |
