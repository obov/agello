# agello

**agent + hello.** Talk to a coding agent running in a [herdr](https://herdr.dev) pane from your browser.

- Chat with the agent from a web page; terminal input, browser input and agent replies are shown as separate bubbles
- Live session status, tool activity, and prompts queued while the agent is busy (same order as the terminal)
- Conversation saved per pane in the browser, kept across reloads
- Interactive terminal view of the existing herdr pane: live cursor, keyboard input, and automatic resize
- Optional live view of a `terminal-browser` screen, with an on/off switch to control it yourself
- Annotate: point at an element on that screen and send a request about it, with its CSS selector
- Tab sound: hear that screen's audio on the page instead of the agent's machine
- Embeddable `<agent-bridge>` web component

Chat currently supports **Claude Code** sessions. The terminal view connects directly to the pane, including ordinary shells and other terminal applications.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- [herdr](https://herdr.dev) (the agent must run inside a herdr pane); interactive terminal view requires `herdr terminal session control`
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

### Annotate

The `주석` button on the screen panel turns on annotate mode: hovering tints the element under the pointer (with its tag and size), clicking outlines it and opens an input next to it. The wheel still scrolls the page, and the outline follows the element as the page changes. The request arrives as:

```
[browser] action=annotate make this red / and bolder
대상: #app > main > button:nth-of-type(2)
요소: button.primary "Save" · 위치 120,340 크기 96x32 · http://localhost:3000/
```

Selector: nearest unique `id` / `data-testid` ancestor, then `tag:nth-of-type` steps (light DOM only). Coordinates are CSS px of the viewport. Off while presenting and while "내 조작" is on.

### Tab sound

The `소리` button on the screen panel plays the relayed tab's audio on that page. While at least one page has it on, the tab is muted in the agent's terminal-browser; when the last one turns it off or closes, local playback returns within 4 seconds. agello reroutes the page's Web Audio output and `<audio>`/`<video>` elements into PCM chunks (`GET /screen/audio`, SSE), since CDP has no audio stream. Not captured: Web Audio connected before it was turned on (reload the tab), cross-origin media without CORS (keeps playing locally), cross-site iframes. Audio trails the screen by about 0.2s.

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

### Pane picker

Click the status in the header to open a drawer with herdr's workspace -> tab -> pane tree (the current pane's workspace is expanded; a workspace with a single tab lists its panes directly). Search filters by workspace, title, folder, or agent. Picking a pane switches the page to that pane's server, starting it if needed (`?server=` keeps the choice across reloads). Panes without Claude Code open as a terminal, since chat supports Claude Code only.

`+` adds a workspace (top), a tab (workspace row), or splits a pane (pane row); new panes open as a terminal. Nothing can be closed from the page: closing a herdr pane ends its processes.

### Interactive terminal

Click the terminal icon in the header to replace the chat with the pane's live terminal (the screen panel stays). Keyboard input (including Korean text, arrow keys, and Ctrl+C) goes directly to that terminal. The viewport follows the browser size, and the mouse wheel scrolls through Herdr. Click the icon again or close the page to release control; the pane and its process keep running. If disconnected, use **다시 연결** to restore the current screen.

Only one browser connection can control a pane through this server at a time. Agello never forcibly takes over another Herdr controller. While connected, resizing the browser also changes the source terminal size. Terminal input is raw input, without the chat's `[browser]` prefix.

The xterm.js renderer and its styles are served locally; no terminal CDN is required. Herdr sends an initial ANSI screen and subsequent frame updates over the WebSocket, including cursor state. Terminal frames are not stored in browser chat history.

### Presentation mode

`agello present x,y,w,h` (CSS px of the browser's visible viewport; omit for the whole screen):

- only that rectangle is sent to the page (`Page.captureScreenshot` with a clip, at device resolution)
- the screen panel expands to fill the window
- agent replies appear over it as bubbles that fade after 10s
- `agello present stop` returns to the normal layout; the replies are in the chat as usual
- the viewer can ask a question with the raise-hand button (its bubble fades after 10s too) or end the presentation with the end button; the agent then receives `[browser] action=present-stop`
- raising the hand tells the agent at once (`action=hand-raise`) so it can pause; closing it with X (or Esc) before asking sends `action=hand-lower`
- the input stays open for the whole question: after the agent answers, follow-up questions go in the same input (no need to raise the hand again); X (or Esc) then sends `action=hand-done`, and the agent resumes

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
- raising a hand pauses at once and rewinds one line, so `present resume` replays the interrupted line; the agent gets `action=hand-raise` with the position (`마지막 표시 2.1 · 다음 2.1`)
- raising, cancelling (X before asking) and finishing a question (X after an answer) show a small light event bubble for 5s right away, apart from the conversation bubbles; sending a question shows none
- `script load` again after editing keeps the position; `present goto 2.2` then `present resume` replays from a fixed line
- at the end the agent gets `action=present-done`; while the script is paused and the agent is working, the page shows a small loader

#### Optional TTS and recording

The screen panel's **발표 설정** remains available during presentation. TTS and recording both start OFF and can be used independently:

| TTS | Recording | Result |
|---|---|---|
| OFF | OFF | Existing timed script captions |
| OFF | ON | Presentation images and captions in a silent video |
| ON | OFF | Spoken script, with captions synchronized to audio playback |
| ON | ON | Presentation images, captions, and TTS audio in the controlling viewer's video |

1. Open **발표 설정**. Enter a Typecast API key and optionally change the voice ID, then click **키·목소리 적용**. The default voice is `tc_6a0e85a97f7750959b970d5d`; the provider uses Korean (`kor`) and model `ssfm-v30`.
2. Alternatively, **로컬 키 불러오기** reads only `TYPECAST_API_KEY` from `../yt-outlier/.env`, relative to the server's working directory. It does not execute the file or import other settings. A server started with `TYPECAST_API_KEY` in its environment also has a key ready, with TTS still OFF.
3. Click **TTS 켜기** in the viewer that should play sound. This click grants browser audio playback permission. Click **대본 재생** after loading a script; **일시정지** stops playback, and **다시 재생** starts a completed script again from its first step.
4. Click **녹화 시작**, then **녹화 종료** and **영상 저장** to download the recording. Recording can start before presentation if a screen image is already available. Stopping recording leaves script and audio playback running.

With TTS enabled, each script caption appears after that viewer starts the actual audio, and closes when the audio finishes. The audio's duration replaces the script's `hold`; ordinary agent replies still use their existing caption timer. Raising a hand immediately stops audio locally, and resumed playback repeats the interrupted line. Pausing, changing steps, updating a script, or disconnecting cancels outdated speech. A TTS failure pauses the script; fix the key or connection, or turn TTS OFF, then resume.

Only the viewer that enabled TTS plays audio and acknowledges speech progress. Other viewers receive the same captions and can record a silent video. To include TTS audio, record in the viewer that enabled TTS. Audio settings are fixed when recording starts: stop recording before changing TTS. If another viewer changes the controlling audio role, a recording whose audio setting changes is finalized automatically.

Recording uses a 1280×720 canvas that fits the relayed browser image with letterboxing and draws the current captions below it. It records these images and plain caption text, rather than the page's entire DOM: chat, settings, question input, and control buttons are excluded; caption Markdown styling is flattened. Long captions are wrapped and truncated to the safe area. The canvas targets 30fps, while source screen updates can be slower (presentation screenshots are approximately 10fps). A background or minimized tab may render more slowly. Use a current Chromium browser for the verified recording path; other browsers depend on their `canvas.captureStream`, Web Audio, and `MediaRecorder` support. MP4 is preferred when supported, with WebM as a fallback. Streaming WebM duration metadata is finalized when its header supports the correction; otherwise the original browser recording is retained.

Recording stops at 15 minutes or 256MB, at presentation end, on server changes, or on connection loss. Keep the page open until **영상 저장** appears and download it before closing or reloading; recording data is held in browser memory. A later recording replaces the earlier download link.

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
- **Panes**: `GET /panes` (`herdr workspace/tab/pane list`), `POST /panes/connect` (`agello start --pane`), `POST /panes/create` (`herdr workspace create`, `tab create`, `pane split`, always `--no-focus`)
- **Terminal**: `/terminal` WebSocket relays `herdr terminal session control <pane>` ANSI frames and validated input, resize, and scroll commands to xterm.js
- **Screen**: finds the terminal-browser CDP port via `terminal-browser ls --json` and relays `Page.startScreencast` frames; user control forwards `Input.*` events only

## Security

The server listens on `127.0.0.1` only. Data and input endpoints accept requests from the same origin and `localhost` pages only; other origins get `403` unless added with `--allow-origin`. Allowed origins can send chat prompts and connect to `/terminal` to type directly into the pane, so keep the allow list short.

TTS keys remain in server memory until replaced, cleared with **키 삭제**, or the server stops. Password inputs are cleared after applying; keys and speech-driver tokens are never put in browser storage, chat history, scripts, or SSE broadcasts. Keys are sent only to the local server and Typecast. Script text is sent to Typecast when TTS is ON, and generated audio is cached in server memory for reuse. Allowed origins can also configure TTS and read generated audio, so allow only trusted pages.

## Development

Run `bun install` and `bun test`. Tests cover the pane tree and creation (against a mock herdr), local terminal assets, origin rejection, ANSI frames, keyboard bytes, resize, exclusive control, reconnect, TTS coordination, stale speech cancellation, and recording lifecycle and metadata.

## License

MIT
