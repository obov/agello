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
bun add -g agello      # or: npm i -g agello  (Bun is still required to run it)
```

Or run without installing: `bunx agello start --open`

From source:

```sh
git clone https://github.com/obov/agello
cd agello
bun link               # puts `agello` on your PATH
```

## Usage

Run inside the herdr pane where the agent is running (`$HERDR_PANE_ID` is picked up automatically):

```sh
agello start --open      # start in the background and open the page
agello status            # list running servers (pane, agent state, screen browser)
agello stop              # stop this pane's server
```

Or target another pane:

```sh
agello start --pane w1:p2
agello stop --pane w1:p2
```

One server per pane. `start` reuses the pane's server if it is already running, and otherwise picks the first free port from 8765 (so servers for different panes never collide). The screen panel only uses the terminal-browser given with `--browser` or the one in the agent's own herdr tab, never another tab's.

Messages sent from the page arrive in the agent as:

```
[browser] action=message your text
```

The approve / reject buttons send `action=approve` / `action=reject`.

### Commands

| Command | Description |
|---|---|
| `agello start [options]` | Start a server in the background |
| `agello stop [--port N \| --pane ID \| --all]` | Stop a server (default: this pane's) |
| `agello status [--json]` | List running servers, agent state and screen browser |
| `agello open [--port N \| --pane ID]` | Open the page (default: this pane's server) |
| `agello present [x,y,w,h] [--port N \| --pane ID]` | Presentation mode (see below) |
| `agello present stop` | End presentation mode |
| `agello script load <file> \| show` | Load / show a presentation script |
| `agello present resume \| pause \| goto <n[.m]>` | Play the script from where it stopped / stop it / move to a step |

`start` options: `--pane <id>`, `--port <n>` (default: first free from 8765), `--session <id>`, `--browser <terminal-browser key>`, `--allow-origin <origin>` (repeatable), `--open`, `--foreground`.

State and logs: `~/.local/state/agello/<port>.json`, `<port>.log`.

### Presentation mode

`agello present x,y,w,h` (CSS px of the browser's visible viewport; omit for the whole screen):

- only that rectangle is sent to the page (`Page.captureScreenshot` with a clip, at device resolution)
- the screen panel expands to fill the window
- agent replies appear over it as bubbles that fade after 10s
- `agello present stop` returns to the normal layout; the replies are in the chat as usual
- the viewer can ask a question with the raise-hand button (its bubble fades after 10s too) or end the presentation with the end button; the agent then receives `[browser] action=present-stop`
- raising the hand tells the agent at once (`action=hand-raise`) so it can pause; closing the input without asking sends `action=hand-lower`

Run `present` again to move the crop. User control is off while presenting.

#### Scripts

Write the talk ahead so each line appears the moment its screen does:

```json
{ "rect": "28,157,688,477",
  "steps": [
    { "go": "#1", "say": ["First line", "Second line"] },
    { "go": "#2", "say": ["..."], "hold": 6 } ] }
```

- step: `go` brings the screen there (`#n` sets `location.hash`, anything else is JS run in the page; agello knows nothing about the deck), `say` lines are one bubble each, `hold` seconds a line stays on screen (default from length, 10 to 20s; never below 10s). Pacing: screen change, 1s, line, fade out, 0.3s, next line; after a step's last line 0.7s before the next screen
- `present resume` plays from where it stopped (starts presentation mode with the script's `rect`); it first re-runs the current step's `go`, so the agent may move the screen freely while answering
- raising a hand pauses at once; the agent gets `action=hand-raise` with the position (`마지막 표시 2.1 · 다음 2.2`)
- `script load` again after editing keeps the position; `present goto 2.2` then `present resume` replays from a fixed line
- at the end the agent gets `action=present-done`; while the script is paused and the agent is working, the page shows a small loader

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
