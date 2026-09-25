// <agent-bridge> web component.
//
// Embed:
//   <script type="module" src="http://127.0.0.1:8765/agent-bridge.js"></script>
//   <agent-bridge style="height: 600px"></agent-bridge>
//
// Attributes
//   server       bridge server origin (default: origin this script was loaded from)
//   heading      header text (default: "agello")
//   no-header    hide header
//   no-actions   hide approve/reject buttons
//   no-history   do not persist chat in localStorage (default: persisted per server + pane)
//   screen       show live terminal-browser screen panel (side by side, stacked when narrow)
//                with a toggle that lets the viewer control the browser (mouse, wheel, keyboard)
//
// Theming (CSS custom properties on the element or an ancestor)
//   --ab-bg --ab-panel --ab-text --ab-muted --ab-line --ab-accent --ab-user --ab-font
//
// Events (bubbling, composed)
//   agent-status   detail: status object
//   agent-message  detail: { role: 'assistant'|'terminal'|'browser', text, action?, ts, id?, queued? }
//   agent-queue    detail: { phase: 'delivered'|'unqueued', id }
//   agent-tool     detail: { phase: 'start'|'end', id, name?, summary?, isError? }
//                  (tool calls are also kept in the conversation as one-line rows, like the terminal)
//   agent-screen   detail: { connected, browser?, url?, title?, agentControlled? }
//   agent-present  detail: { on, rect?: {x,y,w,h}, since? }
//   agent-pane     detail: { pane, server }  another pane was picked in the drawer (server attribute changed)
//
// Pane picker
//   Clicking the status in the header opens a drawer with herdr's workspace -> tab -> pane tree.
//   Picking a pane switches to that pane's own server (started on demand). Workspaces, tabs and
//   panes can be added there; nothing is closed from the page (closing kills the pane's processes).
//
// Presentation mode (started by the agent: `agello present [x,y,w,h]`)
//   The screen panel expands to fill the window and shows only the given
//   rectangle of the browser. Agent replies appear over it as bubbles that fade
//   after 10s; they are also added to the chat, so it is all there when the
//   presentation ends. User control is off while presenting.
//   A raise-hand button next to the bubbles opens a small input so the viewer
//   can ask the agent something mid-presentation (sent as action=message).
//   Opening it tells the agent right away (action=hand-raise) so it can pause;
//   closing it without asking sends action=hand-lower so it can go on.
//   The viewer's questions show as bubbles too, with the same 10s lifetime.
//   An end button above it stops the presentation for every viewer.
//
// Methods
//   el.send(text, action = 'message') -> Promise<{ok, error?}>
//   el.clearHistory()                  clear saved chat for the current pane
//   el.stopPresent()                   end presentation mode, tell the agent -> Promise<{ok, error?, notified?}>

const SCRIPT_ORIGIN = new URL(import.meta.url).origin;

let mdPromise;
function loadMarkdown() {
  mdPromise ??= Promise.all([
    import("https://cdn.jsdelivr.net/npm/marked/+esm"),
    import("https://cdn.jsdelivr.net/npm/dompurify/+esm"),
  ])
    .then(([m, p]) => (text) => p.default.sanitize(m.marked.parse(text)))
    .catch(() => null);
  return mdPromise;
}

const REASONS = {
  agent_not_found: "세션 종료 (pane 없음)",
  not_claude: "세션 종료 (지원 에이전트 아님)",
  session_changed: "다른 세션으로 교체됨",
};
const STATES = { idle: "대기 중", working: "작업 중", blocked: "입력 대기", done: "완료", unknown: "상태 불명" };
const SCREEN_REASONS = {
  browser_not_found: "지정한 terminal-browser(--browser)를 찾을 수 없음",
  no_browser_in_tab: "이 herdr 탭에 열린 terminal-browser 없음",
  tab_unknown: "에이전트의 herdr 탭을 확인할 수 없음",
  no_active_tab: "브라우저에 활성 탭 없음",
};
const ACTIONS = {
  message: "메시지", approve: "승인", reject: "거절",
  "present-stop": "발표 종료", "hand-raise": "손들기", "hand-lower": "손 내림",
};

const CSS = `
.pane-btn { display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px; border-radius: 999px; font-size: 12px;
            color: var(--_muted); max-width: 46cqi; }
.pane-btn .state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-btn .dot { flex: none; }
.drawer-backdrop { display: none; position: absolute; inset: 0; z-index: 20; background: rgb(0 0 0 / .25); }
.drawer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 21; width: min(360px, 92%); display: flex;
          flex-direction: column; background: var(--_panel); border-left: 1px solid var(--_line);
          box-shadow: -8px 0 24px rgb(0 0 0 / .18); transform: translateX(100%); visibility: hidden;
          transition: transform .18s ease, visibility 0s .18s; }
:host([panes-open]) .drawer { transform: none; visibility: visible; transition: transform .18s ease; }
:host([panes-open]) .drawer-backdrop { display: block; }
.drawer-head { display: flex; gap: 6px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--_line); }
.drawer-head strong { font-size: 13px; margin-right: auto; }
.icon-btn { padding: 1px 8px; border-radius: 6px; font-size: 14px; line-height: 1.5; }
.pane-filter { width: 100%; padding: 5px 9px; font: inherit; font-size: 12px; border: 1px solid var(--_line);
               border-radius: 7px; background: var(--_bg); color: var(--_text); }
.drawer-search { padding: 8px 12px; border-bottom: 1px solid var(--_line); }
.add-form { display: grid; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--_line); font-size: 12px; }
.add-form[hidden] { display: none; }
.add-form .add-title { font-weight: 600; }
.add-form input, .add-form select { padding: 4px 8px; font: inherit; border: 1px solid var(--_line); border-radius: 6px;
                                    background: var(--_bg); color: var(--_text); }
.add-form .add-row { display: flex; gap: 6px; justify-content: flex-end; }
.tree { flex: 1; overflow: auto; padding: 6px 0; font-size: 13px; }
.tree-row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer; min-width: 0; }
.tree-row:hover { background: var(--_user); }
.tree-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-row .meta { font-size: 11px; color: var(--_muted); flex: none; }
.tree-row .caret { width: 12px; flex: none; color: var(--_muted); font-size: 10px; }
.tree-row .row-add { visibility: hidden; padding: 0 6px; font-size: 12px; border-radius: 5px; flex: none; }
.tree-row:hover .row-add, .tree-row:focus-within .row-add { visibility: visible; }
.tree-row.ws .name { font-weight: 600; }
.tree-row.tab { padding-left: 26px; color: var(--_muted); }
.tree-row.pane { padding-left: 30px; }
.tree-row.pane.nested { padding-left: 46px; }
.tree-row.pane.current { background: color-mix(in srgb, var(--_accent) 16%, transparent); }
.tree-row .badge { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--_line); color: var(--_muted); flex: none; }
.tree-empty, .drawer-hint { padding: 8px 12px; font-size: 12px; color: var(--_muted); }
.drawer-hint:empty { display: none; }
.term-btn { display: inline-flex; align-items: center; justify-content: center; padding: 3px 7px; border-radius: 999px; }
.term-btn svg { width: 14px; height: 14px; }
.term-btn[aria-pressed="true"] { background: var(--_accent); border-color: var(--_accent); color: white; }
.terminal-panel { display: none; flex: 1; min-height: 0; flex-direction: column; background: #101114; }
:host([terminal-open]) .chat > .stage, :host([terminal-open]) .chat > footer { display: none; }
:host([terminal-open]) .terminal-panel { display: flex; }
.terminal-bar { display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-bottom: 1px solid #26272b; }
.terminal-status { flex: 1; font-size: 12px; color: #a1a1aa; overflow-wrap: anywhere; }
.terminal-retry { font-size: 11px; padding: 2px 9px; border-radius: 999px; }
.terminal-host { flex: 1; min-height: 0; padding: 8px 12px; overflow: hidden; }
.terminal-host textarea { min-height: 0; border: 0; padding: 0; resize: none; }

:host {
  --_bg: var(--ab-bg, #f6f6f4); --_panel: var(--ab-panel, #fff); --_text: var(--ab-text, #1f1f1f);
  --_muted: var(--ab-muted, #6b6b6b); --_line: var(--ab-line, #e4e4e0); --_accent: var(--ab-accent, #2f6fed);
  --_user: var(--ab-user, #ececea); --_font: var(--ab-font, system-ui, -apple-system, sans-serif);
  --_ok: #2a9d4b; --_busy: #d9a400; --_warn: #d9480f; --_dead: #c92a2a;
  display: flex; flex-direction: column; height: 560px; min-height: 240px;
  background: var(--_bg); color: var(--_text); font: 15px/1.55 var(--_font);
  border: 1px solid var(--_line); border-radius: 12px; overflow: hidden; box-sizing: border-box;
  container-type: inline-size;
}
@media (prefers-color-scheme: dark) {
  :host {
    --_bg: var(--ab-bg, #161616); --_panel: var(--ab-panel, #1e1e1e); --_text: var(--ab-text, #ececec);
    --_muted: var(--ab-muted, #9a9a9a); --_line: var(--ab-line, #2e2e2e); --_user: var(--ab-user, #2f2f2f);
    --_accent: var(--ab-accent, #3b74e6);
  }
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }

header { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--_line);
         background: var(--_panel); }
:host([no-header]) header { display: none; }
h1 { font-size: 14px; margin: 0; font-weight: 600; }
.session { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--_muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--_muted); }
.dot.idle, .dot.done { background: var(--_ok); } .dot.working { background: var(--_busy); }
.dot.blocked { background: var(--_warn); } .dot.dead { background: var(--_dead); }

.body { flex: 1; display: flex; min-height: 0; }
.chat { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.screen { display: none; }
:host([screen]) .screen { display: flex; flex-direction: column; flex: 1.3; min-width: 0; min-height: 0;
                          border-left: 1px solid var(--_line); background: var(--_panel); }
.screen-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px; color: var(--_muted);
              border-bottom: 1px solid var(--_line); min-width: 0; }
.screen-bar .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.live[hidden] { display: none; }
.live { flex: none; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--_line); }
.live.on { background: var(--_accent); border-color: var(--_accent); color: #fff; }
.viewport { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 10px;
            background: var(--_bg); }
.viewport img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px;
                box-shadow: 0 0 0 1px var(--_line); display: none; }
.viewport.has img { display: block; }
.viewport.has .placeholder { display: none; }
.viewport { overflow: hidden; }
.viewport img, .viewport .placeholder { position: relative; z-index: 1; }

/* agent control: rotating gradient ring + inner glow + badge */
.ring { position: absolute; inset: 0; overflow: hidden; opacity: 0; transition: opacity .35s ease;
        pointer-events: none; z-index: 0; }
.ring::before { content: ""; position: absolute; inset: -150%;
  background: conic-gradient(from 0deg, #ff3d7f, #ffb13d, #f5ff3d, #3dffb4, #3db4ff, #b43dff, #ff3d7f);
  animation: spin 2.4s linear infinite; }
.ring::after { content: ""; position: absolute; inset: 4px; background: var(--_bg); border-radius: 8px; }
.glow { position: absolute; inset: 4px; border-radius: 8px; pointer-events: none; z-index: 2; opacity: 0;
        transition: opacity .35s ease; }
.agent-badge { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 3;
  display: flex; align-items: center; gap: 7px; padding: 5px 14px; border-radius: 999px;
  font-size: 12px; font-weight: 600; color: #fff; letter-spacing: .02em; white-space: nowrap;
  background: linear-gradient(90deg, #ff3d7f, #b43dff, #3db4ff, #ff3d7f); background-size: 300% 100%;
  box-shadow: 0 4px 18px rgba(180, 61, 255, .45); opacity: 0; translate: 0 -8px; pointer-events: none;
  transition: opacity .3s ease, translate .3s ease; }
.agent-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #fff;
  animation: blink 1s ease-in-out infinite; }
.viewport.agent .ring, .viewport.agent .glow { opacity: 1; }
.viewport.agent .glow { animation: glow 1.6s ease-in-out infinite; }
.viewport.agent .agent-badge { opacity: 1; translate: 0 0; animation: slide 3s linear infinite; }
.viewport.agent img { box-shadow: none; }
@keyframes glow {
  0%, 100% { box-shadow: inset 0 0 18px 2px rgba(180, 61, 255, .35); }
  50% { box-shadow: inset 0 0 34px 8px rgba(61, 180, 255, .55); }
}
@keyframes blink { 50% { opacity: .25; } }
@keyframes slide { to { background-position: 300% 0; } }
@media (prefers-reduced-motion: reduce) {
  .ring::before { animation-duration: 12s; }
  .viewport.agent .glow, .viewport.agent .agent-badge, .agent-badge::before { animation: none; }
}
.viewport.control img { box-shadow: 0 0 0 2px var(--_ok); cursor: default; }
.kbd { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0;
       resize: none; pointer-events: none; }
.control-btn { flex: none; display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 4px 3px 10px;
               border: 0; background: none; color: var(--_muted); }
.control-btn .state-label { min-width: 2.2em; text-align: left; font-weight: 600; }
.control-btn .track { position: relative; width: 34px; height: 20px; border-radius: 999px; background: var(--_line);
                      transition: background .2s ease; }
.control-btn .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
                     background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s ease; }
.control-btn[aria-checked="true"] { color: var(--_text); }
.control-btn[aria-checked="true"] .state-label { color: var(--_ok); }
.control-btn[aria-checked="true"] .track { background: var(--_ok); }
.control-btn[aria-checked="true"] .knob { transform: translateX(14px); }
.control-btn:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .control-btn .track, .control-btn .knob { transition: none; } }
.placeholder { font-size: 13px; color: var(--_muted); text-align: center; }

/* presentation mode: the screen panel covers the window, chat stays hidden underneath.
   container-type would make the host the containing block of the fixed layer, so drop it. */
:host([presenting]) { container-type: normal; }
.body.present .screen { display: flex; position: fixed; inset: 0; z-index: 2147483000; border: 0;
                        width: auto; height: auto; background: #0b0b0c; }
.body.present .screen-bar, .body.present .ring, .body.present .glow, .body.present .agent-badge { display: none; }
.body.present .viewport { padding: 0; background: #0b0b0c; }
.body.present .viewport img { width: 100%; height: 100%; max-width: none; max-height: none; border-radius: 0;
                              box-shadow: none; }
.captions { display: none; }
.body.present .captions { position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; display: flex;
  flex-direction: column; align-items: center; gap: 10px; padding: 0 88px 28px; pointer-events: none; }
.caption { max-width: min(900px, 86%); padding: 12px 18px; border-radius: 16px; overflow-wrap: anywhere;
  font-size: 18px; line-height: 1.5; color: #fff; background: rgba(20, 20, 22, .72);
  -webkit-backdrop-filter: blur(16px) saturate(1.3); backdrop-filter: blur(16px) saturate(1.3);
  box-shadow: 0 8px 30px rgba(0, 0, 0, .35); animation: capIn .3s ease; }
.caption.plain { white-space: pre-wrap; }
.caption.user { background: color-mix(in srgb, var(--_accent) 88%, transparent); }
.caption.out { opacity: 0; translate: 0 6px; transition: opacity .5s ease, translate .5s ease; }
.caption > :first-child { margin-top: 0; } .caption > :last-child { margin-bottom: 0; }
.caption p, .caption ul, .caption ol { margin: .35em 0; }
.caption code { font-family: ui-monospace, Menlo, monospace; font-size: .85em; background: rgba(255,255,255,.14);
                padding: 1px 5px; border-radius: 4px; }
.caption pre { background: rgba(255,255,255,.1); padding: 8px 10px; border-radius: 8px; overflow-x: auto; }
.caption a { color: inherit; }
@keyframes capIn { from { opacity: 0; translate: 0 10px; } }

/* raise hand: ask the agent mid-presentation */
.hand-wrap { display: none; }
.body.present .hand-wrap { position: absolute; right: 22px; bottom: 28px; z-index: 5; display: flex;
  flex-direction: column; align-items: flex-end; gap: 10px; }
.hand, .end { width: 48px; height: 48px; padding: 0; border-radius: 50%; display: grid; place-items: center;
  color: #fff; border: 1px solid rgba(255,255,255,.18); background: rgba(20, 20, 22, .72);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); box-shadow: 0 8px 30px rgba(0,0,0,.35);
  transition: background .2s ease, transform .2s ease; }
.hand:hover, .end:hover { background: rgba(40, 40, 44, .85); transform: translateY(-2px); }
.hand[aria-expanded="true"] { background: var(--_accent); border-color: var(--_accent); }
.hand.sent { background: var(--_ok); border-color: var(--_ok); }
.end:hover { background: var(--_dead); border-color: var(--_dead); }
.end:disabled { opacity: .5; cursor: progress; }
.hand:focus-visible, .end:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.hand svg, .end svg { width: 22px; height: 22px; }
.ask { width: min(420px, calc(100vw - 44px)); padding: 12px; border-radius: 16px; color: #fff;
  background: rgba(20, 20, 22, .82); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  box-shadow: 0 8px 30px rgba(0,0,0,.4); animation: capIn .2s ease; }
.ask[hidden] { display: none; }
.ask textarea { min-height: 64px; background: rgba(255,255,255,.08); color: #fff;
  border-color: rgba(255,255,255,.16); font-size: 15px; }
.ask textarea::placeholder { color: rgba(255,255,255,.5); }
.ask .ask-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.ask .ask-hint { font-size: 12px; color: rgba(255,255,255,.6); flex: 1; }
@media (prefers-reduced-motion: reduce) { .hand, .ask { transition: none; animation: none; } }
@media (prefers-reduced-motion: reduce) { .caption { animation: none; } .caption.out { transition: none; } }
@container (max-width: 820px) {
  .body { flex-direction: column; }
  :host([screen]) .screen { order: -1; flex: none; height: 45%; border-left: 0; border-bottom: 1px solid var(--_line); }
}
.stage { position: relative; flex: 1; min-height: 0; display: flex; }
.log { flex: 1; overflow-y: auto; padding: 16px 16px 56px; }
.inner { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.empty { text-align: center; color: var(--_muted); font-size: 13px; padding: 32px 0; }

.msg { display: flex; flex-direction: column; max-width: 85%; }
.meta { font-size: 11px; color: var(--_muted); margin: 0 4px 3px; }
.bubble { padding: 9px 13px; border-radius: 14px; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; align-items: flex-end; }
.queue:empty { display: none; }
.queue { margin-top: 12px; }
.msg.queued .bubble { opacity: .55; outline: 1px dashed var(--_muted); outline-offset: 2px; }
.msg.terminal .bubble { background: var(--_user); border-bottom-right-radius: 4px; white-space: pre-wrap;
                        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13.5px; }
.msg.browser .bubble { background: var(--_accent); color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
.tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,.22); }
.msg.assistant { align-self: flex-start; }
.msg.tool-row { align-self: stretch; max-width: 100%; flex-direction: row; align-items: center; gap: 8px;
                font-size: 12.5px; color: var(--_muted); padding: 0 4px; margin: -4px 0; }
.tool-row .icon { width: 7px; height: 7px; border-radius: 50%; background: var(--_muted); flex: none; }
.tool-row.running .icon { background: var(--_busy); animation: blink 1s ease-in-out infinite; }
.tool-row.done .icon { background: var(--_ok); }
.tool-row.error .icon { background: var(--_dead); }
.tool-row b { color: var(--_text); font-weight: 600; flex: none; }
.tool-row .sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg.assistant .bubble { background: var(--_panel); border: 1px solid var(--_line); border-bottom-left-radius: 4px; }
.bubble.plain { white-space: pre-wrap; }
.bubble > :first-child { margin-top: 0; } .bubble > :last-child { margin-bottom: 0; }
.bubble p, .bubble ul, .bubble ol { margin: .4em 0; }
.bubble h1, .bubble h2, .bubble h3 { font-size: 15px; margin: .8em 0 .3em; }
.bubble code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; background: var(--_user);
               padding: 1px 4px; border-radius: 4px; }
.bubble pre { background: var(--_user); padding: 8px 10px; border-radius: 8px; overflow-x: auto; }
.bubble pre code { background: none; padding: 0; }
.bubble table { border-collapse: collapse; font-size: 13px; margin: .5em 0; display: block; overflow-x: auto; }
.bubble th, .bubble td { border: 1px solid var(--_line); padding: 4px 8px; text-align: left; }
.bubble a { color: inherit; }

/* loader overlay: frosted glass over the bottom of the log, messages scroll behind it */
.activity { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 16px; z-index: 1;
  background: color-mix(in srgb, var(--_bg) 55%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
  mask-image: linear-gradient(to bottom, transparent, #000 14px);
  animation: fadeUp .25s ease; }
.activity:empty { display: none; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .activity { animation: none; } }
.tool { max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 8px; font-size: 13px;
        color: var(--_muted); padding: 4px 0; }
.tool b { color: var(--_text); font-weight: 600; }
.tool span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spinner { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--_line);
           border-top-color: var(--_busy); animation: spin .8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

footer { border-top: 1px solid var(--_line); background: var(--_panel); padding: 10px 16px 14px; }
.composer { max-width: 760px; margin: 0 auto; }
.grip { height: 14px; margin: -6px 0 4px; display: flex; align-items: center; justify-content: center;
        cursor: ns-resize; touch-action: none; }
.grip::before { content: ""; width: 40px; height: 4px; border-radius: 2px; background: var(--_line);
                transition: background .15s ease, width .15s ease; }
.grip:hover::before, .grip.dragging::before, .grip:focus-visible::before { background: var(--_muted); width: 56px; }
.grip:focus-visible { outline: none; }
textarea { width: 100%; min-height: 56px; resize: none; font: inherit; padding: 9px 12px;
           border: 1px solid var(--_line); border-radius: 10px; background: var(--_bg); color: var(--_text); }
textarea:focus { outline: 2px solid var(--_accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
button { font: inherit; font-size: 13px; padding: 6px 13px; border-radius: 8px; cursor: pointer;
         border: 1px solid var(--_line); background: var(--_panel); color: var(--_text); }
button.primary { background: var(--_accent); border-color: var(--_accent); color: #fff; margin-left: auto; }
button:disabled { cursor: not-allowed; opacity: .45; }
:host([no-actions]) .secondary { display: none; }
.hint { font-size: 12px; color: var(--_muted); }
`;

const TEMPLATE = `
<header><h1 part="heading"></h1><div class="session"><button class="term-btn" aria-pressed="false" title="터미널에서 실행 중인 세션 보기 (다시 누르면 채팅)" aria-label="터미널"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/></svg></button><button class="pane-btn" aria-haspopup="dialog" aria-expanded="false" title="pane 선택"><span class="dot"></span><span class="state">연결 중</span><span aria-hidden="true">▾</span></button></div></header>
<div class="drawer-backdrop"></div>
<aside class="drawer" role="dialog" aria-label="pane 선택">
  <div class="drawer-head"><strong>pane 선택</strong><button class="icon-btn ws-add" title="workspace 추가" aria-label="workspace 추가">+</button><button class="icon-btn panes-refresh" title="새로고침" aria-label="새로고침">↻</button><button class="icon-btn drawer-close" title="닫기 (Esc)" aria-label="닫기">×</button></div>
  <div class="drawer-search"><input class="pane-filter" type="search" placeholder="workspace, 제목, 폴더 검색" aria-label="pane 검색"></div>
  <form class="add-form" hidden><span class="add-title"></span>
    <input name="label" placeholder="이름 (선택)" maxlength="80">
    <input name="cwd" placeholder="폴더 경로 (선택, 절대 경로)">
    <select name="direction" aria-label="분할 방향"><option value="right">오른쪽으로 분할</option><option value="down">아래로 분할</option></select>
    <div class="add-row"><button type="button" class="add-cancel">취소</button><button type="submit" class="primary">추가</button></div></form>
  <div class="tree" role="tree"></div><div class="drawer-hint" role="status"></div>
</aside>
<div class="body"><section class="chat">
<div class="terminal-panel" aria-label="터미널"><div class="terminal-bar"><span class="terminal-status" role="status"></span><button class="terminal-retry">다시 연결</button></div><div class="terminal-host"></div></div>
<div class="stage">
<div class="log" part="log"><div class="inner"><div class="empty">이 pane의 대화가 브라우저에 저장돼요.</div></div><div class="inner queue" part="queue"></div></div>
<div class="activity" part="activity"></div>
</div>
<footer part="composer"><div class="composer">
  <div class="grip" role="separator" aria-orientation="horizontal" aria-label="입력창 높이 조절 (위아래 방향키)" tabindex="0" title="끌어서 입력창 높이 조절"></div>
  <textarea placeholder="에이전트에게 보낼 메시지 (Enter 전송, Shift+Enter 줄바꿈)"></textarea>
  <div class="row">
    <button class="secondary" data-action="approve">승인</button>
    <button class="secondary" data-action="reject">거절</button>
    <span class="hint"></span>
    <button class="primary" data-action="message">전송</button>
  </div>
</div></footer>
</section>
<aside class="screen" part="screen">
  <div class="screen-bar"><span class="live" hidden>에이전트 조작 중</span><span class="url"></span>
    <button class="control-btn" role="switch" aria-checked="false" title="켜면 마우스와 키보드 입력이 브라우저로 전달돼요 (끄기: Shift+Esc)">
      <span>내 조작</span><span class="track"><span class="knob"></span></span><span class="state-label">OFF</span></button></div>
  <div class="viewport"><div class="ring"></div><div class="glow"></div><div class="agent-badge">에이전트 조작 중</div><img alt="에이전트 브라우저 화면" draggable="false"><textarea class="kbd" aria-label="브라우저 키보드 입력"></textarea><div class="placeholder">열린 terminal-browser 없음</div><div class="captions" part="captions" aria-live="polite"></div>
    <div class="hand-wrap">
      <form class="ask" part="ask" hidden><textarea aria-label="에이전트에게 질문" placeholder="에이전트에게 질문 (Enter 전송, Esc 닫기)"></textarea>
        <div class="ask-row"><span class="ask-hint"></span><button type="submit" class="primary">보내기</button></div></form>
      <button class="end" part="end" type="button" aria-label="발표 종료" title="발표 종료">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
      <button class="hand" part="hand" type="button" aria-expanded="false" aria-label="손들기: 에이전트에게 질문" title="손들기: 에이전트에게 질문">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
      </button>
    </div></div>
</aside></div>`;

class AgentBridge extends HTMLElement {
  static observedAttributes = ["heading", "server", "screen"];

  #root = this.attachShadow({ mode: "open" });
  #es = null;
  #screenEs = null;
  #controlWs = null;
  #terminalCleanup = null;
  #terminalVersion = 0;
  #terminalStyles = null;
  #panes = null; // {current, workspaces}
  #expanded = new Set();
  #adding = null; // {kind, workspace?, pane?}
  #frame = { w: 0, h: 0 };
  #moveQueued = null;
  #status = null;
  #tools = new Map();
  #md = null;
  #historyKey = null;
  #history = [];
  #present = { on: false };
  static HISTORY_LIMIT = 500;
  static CAPTION_MS = 10000; // presentation bubble lifetime
  static CAPTION_MAX = 3; // bubbles on screen at once (oldest leaves early)

  constructor() {
    super();
    this.#root.innerHTML = `<style>${CSS}</style>${TEMPLATE}`;
    const q = (s) => this.#root.querySelector(s);
    this.$ = {
      heading: q("h1"), dot: q(".dot"), state: q(".state"), log: q(".log"), inner: q(".inner"), queue: q(".queue"),
      activity: q(".activity"), box: q("textarea"), hint: q(".hint"),
      buttons: this.#root.querySelectorAll("button[data-action]"),
      live: q(".live"), url: q(".screen-bar .url"), viewport: q(".viewport"), img: q(".viewport img"),
      controlBtn: q(".control-btn"), kbd: q(".kbd"),
      body: q(".body"), screen: q(".screen"), captions: q(".captions"),
      hand: q(".hand"), end: q(".end"), ask: q(".ask"), askBox: q(".ask textarea"), askHint: q(".ask-hint"),
    };
    this.$.buttons.forEach((b) => b.addEventListener("click", () => this.#submit(b.dataset.action)));
    this.#bindGrip();
    this.$.box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.#submit("message");
      }
    });
    loadMarkdown().then((md) => (this.#md = md));
    this.#bindControl();
    this.#bindHand();
    q(".term-btn").addEventListener("click", () => this.#showTerminal(!this.hasAttribute("terminal-open")));
    q(".terminal-retry").addEventListener("click", () => this.#showTerminal(true));
    this.#bindPanes();
  }

  get server() {
    return (this.getAttribute("server") || SCRIPT_ORIGIN).replace(/\/$/, "");
  }

  connectedCallback() {
    this.$.heading.textContent = this.getAttribute("heading") || "agello";
    this.#connect();
    this.#syncScreen();
  }
  disconnectedCallback() {
    this.#showTerminal(false);
    this.#es?.close();
    this.#es = null;
    this.#screenEs?.close();
    this.#screenEs = null;
    this.#setControl(false);
  }
  attributeChangedCallback(name) {
    if (name === "heading") this.$.heading.textContent = this.getAttribute("heading") || "agello";
    if (name === "server" && this.isConnected) { this.#showTerminal(false); this.#openPanes(false); this.#connect(); this.#screenEs?.close(); this.#screenEs = null; this.#syncScreen(); }
    if (name === "screen" && this.isConnected) this.#syncScreen();
  }

  async #showTerminal(on) {
    const version = ++this.#terminalVersion;
    this.#terminalCleanup?.();
    this.#terminalCleanup = null;
    this.toggleAttribute("terminal-open", on);
    const q = (s) => this.#root.querySelector(s);
    q(".term-btn").setAttribute("aria-pressed", String(on));
    if (!on) return;
    this.#setControl(false);
    q(".terminal-status").textContent = "터미널 로딩 중…";
    try {
      if (!this.#terminalStyles) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `${SCRIPT_ORIGIN}/terminal.css`;
        link.dataset.terminalCss = "";
        this.#terminalStyles = new Promise((resolve, reject) => {
          link.onload = resolve;
          link.onerror = () => { this.#terminalStyles = null; link.remove(); reject(new Error("Stylesheet failed")); };
        });
        this.#root.append(link);
      }
      await this.#terminalStyles;
      const { mountTerminal } = await import(`${SCRIPT_ORIGIN}/terminal.js`);
      if (version !== this.#terminalVersion || !this.isConnected) return;
      this.#terminalCleanup = mountTerminal(q(".terminal-host"), q(".terminal-status"), this.server);
    } catch {
      if (version === this.#terminalVersion) q(".terminal-status").textContent = "터미널을 불러오지 못했습니다. 다시 연결해 주세요.";
    }
  }

  // ---------- pane picker (herdr workspace -> tab -> pane) ----------

  #bindPanes() {
    const q = (s) => this.#root.querySelector(s);
    q(".pane-btn").addEventListener("click", () => this.#openPanes(!this.hasAttribute("panes-open")));
    q(".drawer-close").addEventListener("click", () => this.#openPanes(false));
    q(".drawer-backdrop").addEventListener("click", () => this.#openPanes(false));
    q(".panes-refresh").addEventListener("click", () => this.#loadPanes());
    q(".ws-add").addEventListener("click", () => this.#startAdd({ kind: "workspace" }));
    q(".pane-filter").addEventListener("input", () => this.#renderPanes());
    q(".add-cancel").addEventListener("click", () => this.#startAdd(null));
    q(".add-form").addEventListener("submit", (e) => { e.preventDefault(); this.#submitAdd(); });
    q(".drawer").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); this.#adding ? this.#startAdd(null) : this.#openPanes(false); }
    });
    q(".tree").addEventListener("click", (e) => {
      const add = e.target.closest(".row-add");
      const row = e.target.closest(".tree-row");
      if (!row) return;
      const { kind, id, ws } = row.dataset;
      if (add) return this.#startAdd(kind === "ws" ? { kind: "tab", workspace: id } : { kind: "pane", pane: id, workspace: ws });
      if (kind === "pane") return this.#selectPane(id);
      this.#expanded.has(id) ? this.#expanded.delete(id) : this.#expanded.add(id);
      this.#renderPanes();
    });
    q(".tree").addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("tree-row")) { e.preventDefault(); e.target.click(); }
    });
  }

  #openPanes(on) {
    if (on === this.hasAttribute("panes-open")) return;
    this.toggleAttribute("panes-open", on);
    const q = (s) => this.#root.querySelector(s);
    q(".pane-btn").setAttribute("aria-expanded", String(on));
    if (!on) { this.#startAdd(null); q(".pane-btn").focus(); return; }
    q(".pane-filter").value = "";
    this.#loadPanes(true);
    q(".pane-filter").focus();
  }

  async #loadPanes(expandCurrent = false) {
    const hint = this.#root.querySelector(".drawer-hint");
    hint.textContent = "불러오는 중…";
    try {
      const res = await fetch(`${this.server}/panes`);
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      this.#panes = d;
      hint.textContent = "";
      if (expandCurrent) {
        const ws = d.workspaces.find((w) => w.tabs.some((t) => t.panes.some((p) => p.id === d.current)));
        const tab = ws?.tabs.find((t) => t.panes.some((p) => p.id === d.current));
        if (ws) this.#expanded.add(ws.id);
        if (tab) this.#expanded.add(tab.id);
      }
    } catch {
      hint.textContent = "pane 목록을 불러오지 못했습니다.";
    }
    this.#renderPanes();
  }

  #renderPanes() {
    const tree = this.#root.querySelector(".tree");
    const d = this.#panes;
    if (!d) { tree.replaceChildren(); return; }
    const filter = this.#root.querySelector(".pane-filter").value.trim().toLowerCase();
    const hit = (...xs) => !filter || xs.some((x) => String(x ?? "").toLowerCase().includes(filter));
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const row = (kind, id, cls, level, expanded) => {
      const r = el("div", `tree-row ${cls}`);
      Object.assign(r.dataset, { kind, id });
      r.tabIndex = 0;
      r.setAttribute("role", "treeitem");
      r.setAttribute("aria-level", String(level));
      if (expanded !== undefined) r.setAttribute("aria-expanded", String(expanded));
      return r;
    };
    const addBtn = (label) => { const b = el("button", "row-add", "+"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); return b; };
    const base = (p) => p.cwd?.split("/").filter(Boolean).pop();
    const rows = [];
    for (const ws of d.workspaces) {
      const tabs = ws.tabs.map((t) => ({ ...t, panes: t.panes.filter((p) => hit(ws.label, t.label, p.id, p.agent, p.title, p.cwd)) }))
        .filter((t) => t.panes.length);
      if (filter && !tabs.length) continue;
      const open = !!filter || this.#expanded.has(ws.id);
      const r = row("ws", ws.id, "ws", 1, open);
      const count = ws.tabs.reduce((n, t) => n + t.panes.length, 0);
      r.append(el("span", "caret", open ? "▾" : "▸"), el("span", "name", ws.label || ws.id), el("span", "meta", String(count)), addBtn("tab 추가"));
      rows.push(r);
      if (!open) continue;
      const single = ws.tabs.length === 1; // D5: a lone tab adds no information
      for (const t of tabs) {
        const tabOpen = single || !!filter || this.#expanded.has(t.id);
        if (!single) {
          const tr = row("tab", t.id, "tab", 2, tabOpen);
          tr.append(el("span", "caret", tabOpen ? "▾" : "▸"), el("span", "name", `tab ${t.label}`), el("span", "meta", String(t.panes.length)));
          rows.push(tr);
        }
        if (!tabOpen) continue;
        for (const p of t.panes) {
          const pr = row("pane", p.id, `pane${single ? "" : " nested"}${p.id === d.current ? " current" : ""}`, single ? 2 : 3);
          pr.dataset.ws = ws.id;
          if (p.id === d.current) pr.setAttribute("aria-current", "true");
          const dot = el("span", `dot ${p.status}`);
          dot.title = STATES[p.status] || p.status;
          const name = el("span", "name", p.title || base(p) || p.id);
          name.title = [p.title, p.cwd, p.id].filter(Boolean).join("\n");
          const badge = el("span", "badge", p.agent || "셸");
          if (p.agent !== "claude") badge.title = "채팅 미지원: 터미널로 연결";
          pr.append(dot, name, badge, addBtn("pane 분할"));
          rows.push(pr);
        }
      }
    }
    tree.replaceChildren(...rows);
    if (!rows.length) tree.append(el("div", "tree-empty", filter ? "검색 결과 없음" : "pane 없음"));
  }

  #startAdd(target) {
    this.#adding = target;
    const form = this.#root.querySelector(".add-form");
    form.hidden = !target;
    if (!target) return;
    form.reset();
    const titles = { workspace: "새 workspace", tab: "새 tab", pane: "pane 분할" };
    form.querySelector(".add-title").textContent = titles[target.kind];
    form.elements.label.hidden = target.kind === "pane";
    form.elements.direction.hidden = target.kind !== "pane";
    (target.kind === "pane" ? form.elements.direction : form.elements.label).focus();
  }

  async #submitAdd() {
    const target = this.#adding;
    if (!target) return;
    const f = this.#root.querySelector(".add-form").elements;
    const hint = this.#root.querySelector(".drawer-hint");
    const body = { ...target, cwd: f.cwd.value.trim() || undefined };
    if (target.kind === "pane") body.direction = f.direction.value;
    else body.label = f.label.value.trim() || undefined;
    if (body.cwd && !body.cwd.startsWith("/")) { hint.textContent = "폴더 경로는 /로 시작하는 절대 경로여야 합니다."; return; }
    hint.textContent = "만드는 중…";
    try {
      const res = await fetch(`${this.server}/panes/create`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      this.#startAdd(null);
      if (target.workspace) this.#expanded.add(target.workspace);
      await this.#selectPane(d.pane, { terminal: true }); // a new pane is a plain shell: show it as a terminal
    } catch (e) {
      hint.textContent = `추가 실패: ${e.message || "server_unreachable"}`;
    }
  }

  async #selectPane(pane, { terminal = false } = {}) {
    const hint = this.#root.querySelector(".drawer-hint");
    if (pane === this.#panes?.current && !terminal) { this.#openPanes(false); return; }
    hint.textContent = "연결 중…";
    try {
      const res = await fetch(`${this.server}/panes/connect`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pane }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      const info = this.#panes?.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.id === pane);
      hint.textContent = "";
      this.#openPanes(false);
      if (d.url !== this.server) this.setAttribute("server", d.url);
      this.#emit("agent-pane", { pane, server: d.url });
      if (terminal || (info && info.agent !== "claude")) this.#showTerminal(true); // D8: chat is Claude-only
    } catch (e) {
      hint.textContent = `연결 실패: ${e.message || "server_unreachable"}`;
    }
  }

  async send(text, action = "message") {
    try {
      const res = await fetch(`${this.server}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text }),
      });
      return await res.json();
    } catch {
      return { ok: false, error: "server_unreachable" };
    }
  }

  async stopPresent() {
    try {
      const res = await fetch(`${this.server}/present`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop: true, from: "viewer" }),
      });
      return await res.json();
    } catch {
      return { ok: false, error: "server_unreachable" };
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #connect() {
    this.#es?.close();
    const es = (this.#es = new EventSource(`${this.server}/events`));
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    on("hello", (d) => {
      if (!d.transcript) this.$.hint.textContent = "대화 기록 파일 없음: 메시지 표시 불가";
      if (d.pane) this.#loadHistory(d.pane, d.queue ?? [], d.tools ?? []);
    });
    on("delivered", ({ id }) => { this.#deliver(id); this.#emit("agent-queue", { phase: "delivered", id }); });
    on("unqueued", ({ id }) => { this.#unqueue(id); this.#emit("agent-queue", { phase: "unqueued", id }); });
    on("status", (s) => this.#renderStatus(s));
    on("message", (m) => {
      this.#addMessage(m);
      this.#saveMessage(m);
      if (this.#present.on && m.role === "assistant") this.#caption(m.text);
      if (this.#present.on && m.role === "browser" && m.action === "message") this.#caption(m.text, "user");
      this.#emit("agent-message", m);
    });
    on("present", (p) => this.#setPresent(p));
    on("tool_start", (t) => {
      this.#tools.set(t.id, t);
      this.#renderActivity();
      if (!this.#row(t.id)) {
        const m = { role: "tool", id: t.id, name: t.name, summary: t.summary, ts: t.ts, state: "running" };
        this.#addMessage(m);
        this.#saveMessage(m);
      }
      this.#emit("agent-tool", { phase: "start", ...t });
    });
    on("tool_end", (t) => {
      this.#tools.delete(t.id);
      this.#renderActivity();
      this.#setToolState(t.id, t.isError ? "error" : "done");
      this.#emit("agent-tool", { phase: "end", ...t });
    });
    es.onerror = () => { this.#renderStatus(null); this.#setPresent({ on: false }); };
  }

  #syncScreen() {
    const want = this.hasAttribute("screen") || this.#present.on;
    if (!want) { this.#screenEs?.close(); this.#screenEs = null; this.#setControl(false); return; }
    if (this.#screenEs) return;
    const es = (this.#screenEs = new EventSource(`${this.server}/screen`));
    es.addEventListener("meta", (e) => this.#renderScreenMeta(JSON.parse(e.data)));
    es.addEventListener("frame", (e) => {
      const f = JSON.parse(e.data);
      this.#frame = { w: f.w, h: f.h };
      this.$.img.src = `data:image/jpeg;base64,${f.data}`;
      this.$.viewport.classList.add("has");
    });
    es.onerror = () => this.#renderScreenMeta({ connected: false });
  }

  // ---------- presentation mode ----------

  #setPresent(p) {
    const on = !!p?.on;
    const was = this.#present.on;
    this.#present = p ?? { on: false };
    this.#emit("agent-present", this.#present);
    if (on === was) return;
    if (on) { this.#showTerminal(false); this.#setControl(false); }
    else { this.$.captions.replaceChildren(); this.#openAsk(false); this.#handUp = false; }
    this.#syncScreen();
    // FLIP: grow from (or shrink back to) the side panel
    const { screen, body } = this.$;
    const before = screen.getBoundingClientRect();
    body.classList.toggle("present", on);
    this.toggleAttribute("presenting", on);
    const after = screen.getBoundingClientRect();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !before.width || !after.width) return;
    const t = `translate(${before.left - after.left}px, ${before.top - after.top}px) ` +
      `scale(${before.width / after.width}, ${before.height / after.height})`;
    screen.animate([{ transformOrigin: "0 0", transform: t }, { transformOrigin: "0 0", transform: "none" }],
      { duration: on ? 420 : 360, easing: "cubic-bezier(.2, .7, .2, 1)" });
  }

  // Raise hand: open a small input over the presentation and send it as a message.
  #bindHand() {
    const { hand, ask, askBox, askHint } = this.$;
    hand.addEventListener("click", () => {
      if (ask.hidden) this.#raiseHand();
      else this.#lowerHand();
    });
    this.$.end.addEventListener("click", async () => {
      this.$.end.disabled = true;
      const res = await this.stopPresent();
      this.$.end.disabled = false;
      if (!res.ok) { this.#openAsk(true); askHint.textContent = `발표 종료 실패: ${res.error}`; }
    });
    ask.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = askBox.value.trim();
      if (!text) return;
      askHint.textContent = "보내는 중…";
      const res = await this.send(text, "message");
      if (!res.ok) { askHint.textContent = `전송 실패: ${res.error}`; return; }
      askBox.value = "";
      this.#handUp = false; // the question itself ends the raised hand
      this.#openAsk(false);
      hand.classList.add("sent");
      setTimeout(() => hand.classList.remove("sent"), 1500);
    });
    askBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask.requestSubmit(); }
      if (e.key === "Escape") { e.preventDefault(); this.#lowerHand(); hand.focus(); }
    });
  }

  // Raise: open the input and tell the agent to pause. Lower (closed without
  // asking): tell it to go on. Failures only show a hint; asking still works.
  #handUp = false;
  async #raiseHand() {
    this.#openAsk(true);
    if (this.#handUp) return;
    this.#handUp = true;
    const res = await this.send("사용자가 손을 듦: 질문 입력 중", "hand-raise");
    if (!res.ok && !this.$.ask.hidden) this.$.askHint.textContent = `손들기 알림 실패: ${res.error}`;
  }
  async #lowerHand() {
    this.#openAsk(false);
    if (!this.#handUp) return;
    this.#handUp = false;
    await this.send("사용자가 질문 없이 손을 내림", "hand-lower");
  }

  #openAsk(open) {
    const { hand, ask, askBox, askHint } = this.$;
    ask.hidden = !open;
    hand.setAttribute("aria-expanded", String(open));
    askHint.textContent = "";
    if (open) askBox.focus();
  }

  // Agent reply as a short-lived bubble over the presented screen.
  // kind "user": the viewer's own question (plain text, accent colour).
  #caption(text, kind = "agent") {
    if (!text?.trim()) return;
    const el = document.createElement("div");
    el.className = `caption ${kind}`;
    el.part = "caption";
    if (kind === "user") { el.textContent = text; el.classList.add("plain"); }
    else if (this.#md) el.innerHTML = this.#md(text);
    else { el.textContent = text; el.classList.add("plain"); }
    const box = this.$.captions;
    box.append(el);
    const leave = () => {
      if (el.classList.contains("out")) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 500);
    };
    setTimeout(leave, AgentBridge.CAPTION_MS);
    const live = [...box.children].filter((c) => !c.classList.contains("out"));
    live.slice(0, Math.max(0, live.length - AgentBridge.CAPTION_MAX)).forEach((c) => c.__leave?.());
    el.__leave = leave;
  }

  // ---------- composer resize grip (top edge) ----------

  #bindGrip() {
    const grip = this.#root.querySelector(".grip");
    const box = this.$.box;
    const MIN = 56;
    const max = () => Math.max(MIN, Math.round(this.clientHeight * 0.6));
    const setH = (h) => { box.style.height = `${Math.min(max(), Math.max(MIN, Math.round(h)))}px`; };
    let startY = 0, startH = 0;

    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = box.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("dragging");
    });
    grip.addEventListener("pointermove", (e) => {
      if (grip.hasPointerCapture(e.pointerId)) setH(startH + (startY - e.clientY));
    });
    const end = (e) => {
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      grip.classList.remove("dragging");
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => { box.style.height = ""; });
    grip.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setH(box.offsetHeight + (e.key === "ArrowUp" ? 24 : -24));
      }
    });
  }

  // ---------- user control ----------

  #setControl(on) {
    if (on && !this.#controlWs) {
      const ws = new WebSocket(`${this.server.replace(/^http/, "ws")}/input`);
      ws.onclose = () => { if (this.#controlWs === ws) this.#setControl(false); };
      this.#controlWs = ws;
    } else if (!on && this.#controlWs) {
      const ws = this.#controlWs;
      this.#controlWs = null;
      ws.close();
    }
    this.$.controlBtn.setAttribute("aria-checked", String(!!this.#controlWs));
    this.$.controlBtn.querySelector(".state-label").textContent = this.#controlWs ? "ON" : "OFF";
    this.$.viewport.classList.toggle("control", !!this.#controlWs);
    if (this.#controlWs) this.$.kbd.focus();
  }

  #cdp(method, params) {
    const ws = this.#controlWs;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }));
  }

  #point(e) {
    const r = this.$.img.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * this.#frame.w),
      y: Math.round(((e.clientY - r.top) / r.height) * this.#frame.h),
    };
  }

  #bindControl() {
    const { img, kbd, controlBtn } = this.$;
    const on = () => !!this.#controlWs && this.#frame.w > 0;
    const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const BUTTONS = ["left", "middle", "right"];

    controlBtn.addEventListener("click", () => { if (!this.#present.on) this.#setControl(!this.#controlWs); });

    img.addEventListener("mousedown", (e) => {
      if (!on()) return;
      e.preventDefault();
      kbd.focus();
      this.#cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...this.#point(e), button: BUTTONS[e.button] ?? "left",
        buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) });
    });
    img.addEventListener("mouseup", (e) => {
      if (!on()) return;
      e.preventDefault();
      this.#cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.#point(e), button: BUTTONS[e.button] ?? "left",
        buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) });
    });
    img.addEventListener("mousemove", (e) => {
      if (!on()) return;
      const first = !this.#moveQueued;
      this.#moveQueued = e;
      if (!first) return;
      requestAnimationFrame(() => {
        const ev = this.#moveQueued;
        this.#moveQueued = null;
        this.#cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...this.#point(ev),
          button: ev.buttons & 1 ? "left" : "none", buttons: ev.buttons, modifiers: mods(ev) });
      });
    });
    img.addEventListener("wheel", (e) => {
      if (!on()) return;
      e.preventDefault();
      this.#cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...this.#point(e), deltaX: e.deltaX, deltaY: e.deltaY,
        modifiers: mods(e) });
    }, { passive: false });
    img.addEventListener("contextmenu", (e) => { if (on()) e.preventDefault(); });

    // Keyboard goes through a hidden textarea so IME (Korean) composition works.
    const keyParams = (e) => ({ key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode,
                                nativeVirtualKeyCode: e.keyCode, modifiers: mods(e) });
    kbd.addEventListener("keydown", (e) => {
      if (!on() || e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return; // handled by paste
      e.preventDefault();
      if (e.key === "Escape" && e.shiftKey) return this.#setControl(false);
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
      if (printable) this.#cdp("Input.dispatchKeyEvent", { type: "keyDown", ...keyParams(e), text: e.key, unmodifiedText: e.key });
      else if (e.key === "Enter") this.#cdp("Input.dispatchKeyEvent", { type: "keyDown", ...keyParams(e), text: "\r", unmodifiedText: "\r" });
      else this.#cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyParams(e) });
    });
    kbd.addEventListener("keyup", (e) => {
      if (!on() || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      this.#cdp("Input.dispatchKeyEvent", { type: "keyUp", ...keyParams(e) });
    });
    kbd.addEventListener("compositionend", (e) => {
      if (on() && e.data) this.#cdp("Input.insertText", { text: e.data });
      kbd.value = "";
    });
    kbd.addEventListener("input", (e) => { if (!e.isComposing) kbd.value = ""; });
    kbd.addEventListener("paste", (e) => {
      if (!on()) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain");
      if (text) this.#cdp("Input.insertText", { text });
    });
  }

  #renderScreenMeta(m) {
    const { live, url, viewport } = this.$;
    if (!m.connected) {
      this.$.viewport.querySelector(".placeholder").textContent = SCREEN_REASONS[m.reason] || "열린 terminal-browser 없음";
      live.hidden = true;
      url.textContent = "";
      viewport.classList.remove("has", "agent");
      this.$.img.removeAttribute("src");
    } else {
      live.hidden = !m.agentControlled;
      live.classList.add("on");
      viewport.classList.toggle("agent", !!m.agentControlled);
      url.textContent = m.title ? `${m.title} · ${m.url}` : m.url || "";
      url.title = m.url || "";
    }
    this.#emit("agent-screen", m);
  }

  // ---------- history (localStorage, per server + pane) ----------

  async #loadHistory(pane, serverQueue = [], serverTools = []) {
    if (this.hasAttribute("no-history")) return;
    const key = `agent-bridge:${this.server}:${pane}`;
    if (key === this.#historyKey) return;
    this.#historyKey = key;
    try {
      this.#history = JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      this.#history = [];
    }
    this.#md ??= await loadMarkdown();
    if (key !== this.#historyKey) return;
    // Saved "queued" messages the server no longer has queued were delivered
    // (or dropped) while this page was closed: show them as delivered.
    for (const m of this.#history) if (m.queued && !serverQueue.includes(m.id)) m.queued = false;
    // Same for tool rows saved as running: finished while the page was closed.
    for (const m of this.#history)
      if (m.role === "tool" && m.state === "running" && !serverTools.includes(m.id)) m.state = "done";
    this.#persist();
    this.#resetLog();
    for (const m of this.#history) this.#addMessage(m);
    this.$.log.scrollTop = this.$.log.scrollHeight;
  }

  // Queued prompt reached the agent: move it from the queue area into the
  // conversation at the current position, like the terminal does.
  #deliver(id) {
    const el = this.#queued(id);
    const i = this.#history.findIndex((m) => m.id === id);
    const m = i >= 0 ? this.#history.splice(i, 1)[0] : el?.__msg;
    el?.remove();
    if (!m) return;
    m.queued = false;
    this.#addMessage(m);
    this.#history.push(m);
    this.#persist();
  }

  // (lookup by iteration: the module-level `CSS` style string shadows window.CSS)
  #queued(id) {
    return [...this.$.queue.children].find((el) => el.dataset.id === id) ?? null;
  }

  #row(id) {
    return [...this.$.inner.children].find((el) => el.dataset.id === id) ?? null;
  }

  #setToolState(id, state) {
    const el = this.#row(id);
    if (el) el.className = `msg tool-row ${state}`;
    const m = this.#history.find((x) => x.id === id);
    if (m) {
      m.state = state;
      this.#persist();
    }
  }

  #unqueue(id) {
    this.#queued(id)?.remove();
    this.#history = this.#history.filter((m) => m.id !== id);
    this.#persist();
  }

  #saveMessage(m) {
    this.#history.push(m);
    this.#persist();
  }

  #persist() {
    if (!this.#historyKey) return;
    if (this.#history.length > AgentBridge.HISTORY_LIMIT)
      this.#history = this.#history.slice(-AgentBridge.HISTORY_LIMIT);
    for (;;) {
      try {
        localStorage.setItem(this.#historyKey, JSON.stringify(this.#history));
        return;
      } catch {
        if (this.#history.length <= 1) return; // quota: drop oldest half and retry
        this.#history = this.#history.slice(Math.floor(this.#history.length / 2));
      }
    }
  }

  clearHistory() {
    if (this.#historyKey) localStorage.removeItem(this.#historyKey);
    this.#history = [];
    this.#resetLog();
  }

  #resetLog() {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "이 pane의 대화가 브라우저에 저장돼요.";
    this.$.inner.replaceChildren(empty);
    this.$.queue.replaceChildren();
  }

  #nearBottom() {
    const l = this.$.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }

  #addMessage(m) {
    this.$.inner.querySelector(".empty")?.remove();
    const stick = this.#nearBottom();
    const time = new Date(m.ts || Date.now()).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const wrap = document.createElement("div");
    const meta = document.createElement("div");
    const bubble = document.createElement("div");
    meta.className = "meta";
    bubble.className = "bubble";
    bubble.part = "bubble";

    if (m.role === "tool") {
      wrap.className = `msg tool-row ${m.state || "done"}`;
      const icon = document.createElement("span");
      icon.className = "icon";
      const name = document.createElement("b");
      name.textContent = m.name;
      const sum = document.createElement("span");
      sum.className = "sum";
      sum.textContent = m.summary || "";
      sum.title = m.summary || "";
      wrap.append(icon, name, sum);
      wrap.dataset.id = m.id;
      wrap.__msg = m;
      this.$.inner.append(wrap);
      if (stick) this.$.log.scrollTop = this.$.log.scrollHeight;
      return;
    } else if (m.role === "assistant") {
      wrap.className = "msg assistant";
      meta.textContent = `에이전트 · ${time}`;
      if (this.#md) bubble.innerHTML = this.#md(m.text);
      else { bubble.textContent = m.text; bubble.classList.add("plain"); }
    } else if (m.role === "browser") {
      wrap.className = "msg user browser";
      meta.textContent = `브라우저 · ${time}${m.queued ? " · 대기 중" : ""}`;
      if (m.action !== "message") {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = ACTIONS[m.action] || m.action;
        bubble.append(tag, m.text ? "\n" : "");
      }
      if (m.text) bubble.append(m.text);
    } else {
      wrap.className = "msg user terminal";
      meta.textContent = `터미널 · ${time}${m.queued ? " · 대기 중" : ""}`;
      bubble.textContent = m.text;
    }
    wrap.append(meta, bubble);
    wrap.__msg = m;
    if (m.id) wrap.dataset.id = m.id;
    if (m.queued) {
      wrap.classList.add("queued");
      this.$.queue.append(wrap); // pinned below the conversation until delivered
    } else {
      this.$.inner.append(wrap);
    }
    if (stick || m.role !== "assistant") this.$.log.scrollTop = this.$.log.scrollHeight;
  }

  #renderActivity() {
    const rows = [...this.#tools.values()];
    const s = this.#status;
    if (!rows.length && s?.alive && s.status === "working") rows.push({ name: "생각 중", summary: "" });
    this.$.activity.replaceChildren(
      ...rows.map((t) => {
        const row = document.createElement("div");
        row.className = "tool";
        const sp = document.createElement("span");
        sp.className = "spinner";
        const name = document.createElement("b");
        name.textContent = t.name;
        const sum = document.createElement("span");
        sum.textContent = t.summary || "";
        row.append(sp, name, sum);
        return row;
      }),
    );
  }

  #renderStatus(s) {
    this.#status = s;
    let cls, text, canSend;
    if (!s) { cls = "dead"; text = "서버 연결 끊김"; canSend = false; }
    else if (!s.alive) { cls = "dead"; text = REASONS[s.reason] || s.reason; canSend = false; }
    else { cls = s.status; canSend = s.status !== "blocked"; text = `${STATES[s.status] || s.status} · ${s.label || s.pane}`; }
    this.$.dot.className = `dot ${cls}`;
    this.$.state.textContent = text;
    this.$.state.title = s?.pane ? `pane: ${s.pane}` + (s.session ? `\nsession: ${s.session}` : "") : "";
    this.$.buttons.forEach((b) => (b.disabled = !canSend));
    if (!s || !s.alive || s.status === "idle") this.#tools.clear();
    this.#renderActivity();
    this.#emit("agent-status", s);
  }

  async #submit(action) {
    const text = this.$.box.value.trim();
    if (action === "message" && !text) return;
    this.$.buttons.forEach((b) => (b.disabled = true));
    const res = await this.send(text, action);
    if (res.ok) { this.$.box.value = ""; this.$.hint.textContent = ""; }
    else this.$.hint.textContent = `전송 실패: ${res.error}`;
    this.#renderStatus(this.#status);
    this.$.box.focus();
  }
}

if (!customElements.get("agent-bridge")) customElements.define("agent-bridge", AgentBridge);
