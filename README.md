# agello

**agent + hello.** Talk to a coding agent running in a [herdr](https://herdr.dev) pane from your browser.

- Chat with the agent from a web page; terminal input, browser input and agent replies are shown as separate bubbles
- Live session status, tool activity, and prompts queued while the agent is busy (same order as the terminal)
- Conversation saved per pane in the browser, kept across reloads
- Optional live view of a `terminal-browser` screen, with an on/off switch to control it yourself
- Embeddable `<agent-bridge>` web component

Currently supports **Claude Code** sessions.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- [herdr](https://herdr.dev) (the agent must run inside a herdr pane)
- Optional: `terminal-browser` for the screen panel

## Install

```sh
git clone https://github.com/obov/agello
cd agello
bun link        # puts `agello` on your PATH
```

## Usage

Run inside the herdr pane where the agent is running (`$HERDR_PANE_ID` is picked up automatically):

```sh
agello start --open      # start in the background and open the page
agello status            # list running servers
agello stop              # stop
```

Or target another pane:

```sh
agello start --pane w1:p2 --port 8766
```

Messages sent from the page arrive in the agent as:

```
[browser] action=message your text
```

The approve / reject buttons send `action=approve` / `action=reject`.

### Commands

| Command | Description |
|---|---|
| `agello start [options]` | Start a server in the background |
| `agello stop [--port N \| --all]` | Stop a server |
| `agello status [--json]` | List running servers and agent state |
| `agello open [--port N]` | Open the page in the default browser |

`start` options: `--pane <id>`, `--port <n>` (default 8765), `--session <id>`, `--browser <terminal-browser key>`, `--allow-origin <origin>` (repeatable), `--open`, `--foreground`.

State and logs: `~/.local/state/agello/<port>.json`, `<port>.log`.

## Embed

```html
<script type="module" src="http://127.0.0.1:8765/agent-bridge.js"></script>
<agent-bridge screen style="height: 600px"></agent-bridge>
```

| Attribute | |
|---|---|
| `server` | server origin (default: where the script was loaded from) |
| `heading` | header text |
| `screen` | show the terminal-browser screen panel |
| `no-header`, `no-actions`, `no-history` | hide header / hide approve-reject / don't persist chat |

Theme with CSS variables: `--ab-accent`, `--ab-bg`, `--ab-panel`, `--ab-text`, `--ab-muted`, `--ab-line`.
Events: `agent-status`, `agent-message`, `agent-tool`, `agent-queue`, `agent-screen`. Method: `el.send(text, action)`.
See `web/embed-example.html`.

## How it works

- **Send**: `herdr agent prompt <pane> "<text>"` (kept to 3 lines so Claude Code does not treat it as a paste)
- **Status**: `herdr agent get` / `herdr pane get`, polled every 1.5s
- **Chat**: tails the Claude Code transcript (`$CLAUDE_CONFIG_DIR/projects/*/<session>.jsonl`) and streams it over SSE
- **Screen**: finds the terminal-browser CDP port via `terminal-browser ls --json` and relays `Page.startScreencast` frames; user control forwards `Input.*` events only

## Security

The server listens on `127.0.0.1` only. Data and input endpoints accept requests from the same origin and `localhost` pages only; other origins get `403` unless added with `--allow-origin`. Anything allowed to post to `/send` can type into your agent session, so keep the allow list short.

## License

MIT
