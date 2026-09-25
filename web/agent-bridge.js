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
//                and an annotate toggle: hovering tints the element under the pointer, clicking
//                outlines it and opens an input; the request goes to the agent with the element's
//                CSS selector (action=annotate). The wheel still scrolls the page.
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
//   Script lines (`agello script` + `present resume`) arrive as agent messages
//   with `script: "step.line"`. While the script is not playing and the agent
//   is working (e.g. answering a question), a small loader is shown.
//
// Methods
//   el.send(text, action = 'message', extra) -> Promise<{ok, error?}>  (extra: e.g. {target} for annotate)
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
  "present-stop": "발표 종료", "hand-raise": "손들기", "hand-lower": "손 내림", annotate: "주석",
};

const CSS = `
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
.clear-btn { font-size: 11px; padding: 2px 9px; border-radius: 999px; }
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

/* annotate: hover tint, selected outline, request input next to the element */
.annot-btn { flex: none; font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.annot-btn[aria-pressed="true"] { background: var(--_accent); border-color: var(--_accent); color: #fff; }
.viewport.annot img { cursor: crosshair; }
.hl { position: absolute; z-index: 3; pointer-events: none; display: none; border-radius: 2px; }
.hl.on { display: block; }
.hl.hover { background: color-mix(in srgb, var(--_accent) 22%, transparent);
            box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--_accent) 55%, transparent); }
.hl.sel { box-shadow: 0 0 0 2px var(--_accent), 0 0 0 5px color-mix(in srgb, var(--_accent) 25%, transparent); }
.hl-label { position: absolute; z-index: 4; pointer-events: none; display: none; max-width: 60%;
  padding: 2px 7px; border-radius: 5px; font: 11px/1.5 ui-monospace, Menlo, monospace; color: #fff;
  background: rgba(20, 20, 22, .85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hl-label.on { display: block; }
.note { position: absolute; z-index: 5; width: min(340px, calc(100% - 16px)); padding: 10px; border-radius: 12px;
  background: var(--_panel); border: 1px solid var(--_line); box-shadow: 0 8px 28px rgba(0,0,0,.22);
  animation: capIn .18s ease; }
.note[hidden] { display: none; }
.note .note-target { font: 11px/1.4 ui-monospace, Menlo, monospace; color: var(--_muted); margin-bottom: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note textarea { min-height: 52px; font-size: 14px; }
.note .note-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.note .note-hint { flex: 1; font-size: 12px; color: var(--_muted); }
@media (prefers-reduced-motion: reduce) { .note { animation: none; } }

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

/* agent busy while presenting (answering, fixing the script): minimal loader */
.busy { display: none; }
.body.present .busy.on { position: absolute; left: 22px; bottom: 28px; z-index: 5; display: flex; align-items: center;
  gap: 9px; padding: 9px 14px; border-radius: 999px; font-size: 13px; color: #fff; background: rgba(20, 20, 22, .72);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); box-shadow: 0 8px 30px rgba(0,0,0,.35);
  animation: capIn .25s ease; }
.busy .spinner { border-color: rgba(255,255,255,.25); border-top-color: #fff; }

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
<header><h1 part="heading"></h1><div class="session"><button class="clear-btn" title="이 pane의 저장된 대화 삭제">기록 지우기</button><span class="dot"></span><span class="state">연결 중</span></div></header>
<div class="body"><section class="chat">
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
    <button class="annot-btn" type="button" aria-pressed="false" title="화면의 요소를 골라 에이전트에게 요청 (선택자와 함께 전달)">주석</button>
    <button class="control-btn" role="switch" aria-checked="false" title="켜면 마우스와 키보드 입력이 브라우저로 전달돼요 (끄기: Shift+Esc)">
      <span>내 조작</span><span class="track"><span class="knob"></span></span><span class="state-label">OFF</span></button></div>
  <div class="viewport"><div class="ring"></div><div class="glow"></div><div class="agent-badge">에이전트 조작 중</div><img alt="에이전트 브라우저 화면" draggable="false"><textarea class="kbd" aria-label="브라우저 키보드 입력"></textarea><div class="placeholder">열린 terminal-browser 없음</div><div class="hl hover"></div><div class="hl sel"></div><div class="hl-label"></div>
    <form class="note" part="note" hidden><div class="note-target"></div><textarea aria-label="선택한 요소에 대한 요청" placeholder="이 요소에 대한 요청 (Enter 전송, Esc 취소)"></textarea>
      <div class="note-row"><span class="note-hint"></span><button type="submit" class="primary">보내기</button></div></form><div class="captions" part="captions" aria-live="polite"></div>
    <div class="busy" part="busy" role="status"><span class="spinner"></span><span>답변 준비 중</span></div>
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
  #ws = null; // /input: control input and annotate inspect queries
  #control = false;
  #annot = false;
  #hover = null; // inspected element under the pointer (annotate)
  #hoverPt = null;
  #sel = null; // selected element (annotate)
  #inspectId = 0;
  #inspectWait = new Map();
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
      controlBtn: q(".control-btn"), kbd: q(".kbd"), clearBtn: q(".clear-btn"),
      body: q(".body"), screen: q(".screen"), captions: q(".captions"),
      busy: q(".busy"), hand: q(".hand"), end: q(".end"), ask: q(".ask"), askBox: q(".ask textarea"), askHint: q(".ask-hint"),
      annotBtn: q(".annot-btn"), hlHover: q(".hl.hover"), hlSel: q(".hl.sel"), hlLabel: q(".hl-label"),
      note: q(".note"), noteBox: q(".note textarea"), noteHint: q(".note-hint"), noteTarget: q(".note-target"),
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
    this.#bindAnnotate();
    this.#bindHand();
    this.$.clearBtn.addEventListener("click", () => this.clearHistory());
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
    this.#es?.close();
    this.#es = null;
    this.#screenEs?.close();
    this.#screenEs = null;
    this.#setControl(false);
    this.#setAnnotate(false);
  }
  attributeChangedCallback(name) {
    if (name === "heading") this.$.heading.textContent = this.getAttribute("heading") || "agello";
    if (name === "server" && this.isConnected) { this.#connect(); this.#screenEs?.close(); this.#screenEs = null; this.#syncScreen(); }
    if (name === "screen" && this.isConnected) this.#syncScreen();
  }

  async send(text, action = "message", extra = {}) {
    try {
      const res = await fetch(`${this.server}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...extra, action, text }),
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
      // script lines carry their own on-screen time (>= 10s), others use CAPTION_MS
      if (this.#present.on && m.role === "assistant") this.#caption(m.text, "agent", m.hold * 1000 || undefined);
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
    if (!want) { this.#screenEs?.close(); this.#screenEs = null; this.#setControl(false); this.#setAnnotate(false); return; }
    if (this.#screenEs) return;
    const es = (this.#screenEs = new EventSource(`${this.server}/screen`));
    es.addEventListener("meta", (e) => this.#renderScreenMeta(JSON.parse(e.data)));
    es.addEventListener("frame", (e) => {
      const f = JSON.parse(e.data);
      this.#frame = { w: f.w, h: f.h };
      this.$.img.src = `data:image/jpeg;base64,${f.data}`;
      this.$.viewport.classList.add("has");
      if (this.#annot) this.#annotFrame();
    });
    es.onerror = () => this.#renderScreenMeta({ connected: false });
  }

  // ---------- presentation mode ----------

  #setPresent(p) {
    const on = !!p?.on;
    const was = this.#present.on;
    this.#present = p ?? { on: false };
    this.#emit("agent-present", this.#present);
    this.#renderBusy();
    if (on === was) return;
    if (on) { this.#setControl(false); this.#setAnnotate(false); }
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

  #renderBusy() {
    const s = this.#status;
    const busy = this.#present.on && s?.alive && s.status === "working" && this.#present.player?.state !== "playing";
    this.$.busy.classList.toggle("on", !!busy);
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
  #caption(text, kind = "agent", ms = AgentBridge.CAPTION_MS) {
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
    setTimeout(leave, ms);
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

  // One socket for both modes; open while control or annotate is on.
  #syncWs() {
    const want = this.#control || this.#annot;
    if (want && !this.#ws) {
      const ws = new WebSocket(`${this.server.replace(/^http/, "ws")}/input`);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        this.#inspectWait.get(m.id)?.(m.result ?? null);
      };
      ws.onclose = () => {
        if (this.#ws !== ws) return;
        this.#ws = null;
        this.#setControl(false);
        this.#setAnnotate(false);
      };
      this.#ws = ws;
    } else if (!want && this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      ws.close();
    }
    if (!this.#ws) { this.#inspectWait.forEach((r) => r(null)); this.#inspectWait.clear(); }
  }

  #setControl(on) {
    this.#control = !!on && !this.#present.on;
    if (this.#control) this.#setAnnotate(false);
    this.#syncWs();
    this.$.controlBtn.setAttribute("aria-checked", String(this.#control));
    this.$.controlBtn.querySelector(".state-label").textContent = this.#control ? "ON" : "OFF";
    this.$.viewport.classList.toggle("control", this.#control);
    if (this.#control) this.$.kbd.focus();
  }

  #cdp(method, params) {
    const ws = this.#ws;
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
    const on = () => this.#control && this.#frame.w > 0;
    const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const BUTTONS = ["left", "middle", "right"];

    controlBtn.addEventListener("click", () => this.#setControl(!this.#control));

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
      if (!on() && !(this.#annot && this.#frame.w > 0)) return; // annotate: scroll to reach the element
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

  // ---------- annotate ----------

  #setAnnotate(on) {
    on = !!on && !this.#present.on;
    if (on === this.#annot) return;
    this.#annot = on;
    if (on) this.#setControl(false);
    else { this.#hover = null; this.#hoverPt = null; this.#select(null); }
    this.#syncWs();
    this.$.annotBtn.setAttribute("aria-pressed", String(on));
    this.$.viewport.classList.toggle("annot", on);
    this.#drawHl();
  }

  // Element at a frame point ({x, y}) or by selector; null if unavailable.
  #inspect(q, full = false) {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = ++this.#inspectId;
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(t); this.#inspectWait.delete(id); resolve(r); };
      const t = setTimeout(() => done(null), 3000);
      this.#inspectWait.set(id, done);
      ws.send(JSON.stringify({ id, inspect: { ...q, full } }));
    });
  }

  // Latest pointer position wins; at most one hover query in flight.
  #probing = false;
  #probeAgain = false;
  async #probeHover() {
    if (this.#probing) { this.#probeAgain = true; return; }
    this.#probing = true;
    try {
      do {
        this.#probeAgain = false;
        const p = this.#hoverPt;
        if (!p || !this.#annot) break;
        const r = await this.#inspect(p);
        if (this.#hoverPt && this.#annot) { this.#hover = r; this.#drawHl(); }
      } while (this.#probeAgain);
    } finally {
      this.#probing = false;
    }
  }

  // The page changed (scroll, layout, HMR): follow the selected element and
  // re-check what is under the pointer.
  #tracking = false;
  async #annotFrame() {
    if (this.#hoverPt) this.#probeHover();
    const sel = this.#sel;
    if (!sel || this.#tracking) { this.#drawHl(); return; }
    this.#tracking = true;
    try {
      const r = await this.#inspect({ selector: sel.selector });
      if (r && this.#sel === sel) sel.rect = r.rect; // gone from the page: keep the last box
    } finally {
      this.#tracking = false;
    }
    this.#drawHl();
  }

  #select(t) {
    const { note, noteBox, noteHint, noteTarget } = this.$;
    this.#sel = t;
    note.hidden = !t;
    noteHint.textContent = "";
    if (t) {
      noteTarget.textContent = t.selector;
      noteTarget.title = t.selector;
      noteBox.focus();
    }
    this.#drawHl();
  }

  // Frame (CSS px of the page viewport) -> position over the displayed image.
  #drawHl() {
    const { viewport, img, hlHover, hlSel, hlLabel, note } = this.$;
    const show = this.#annot && viewport.classList.contains("has") && this.#frame.w > 0;
    const vr = viewport.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const sx = ir.width / this.#frame.w, sy = ir.height / this.#frame.h;
    const box = (r) => {
      if (!show || !r) return null;
      const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0);
      const x1 = Math.min(r.x + r.w, this.#frame.w), y1 = Math.min(r.y + r.h, this.#frame.h);
      if (x1 <= x0 || y1 <= y0) return null;
      return { left: ir.left - vr.left + x0 * sx, top: ir.top - vr.top + y0 * sy, width: (x1 - x0) * sx, height: (y1 - y0) * sy };
    };
    const place = (el, b) => {
      el.classList.toggle("on", !!b);
      if (b) Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
      return b;
    };
    const hb = place(hlHover, box(this.#hover?.rect));
    const sb = place(hlSel, box(this.#sel?.rect));

    hlLabel.classList.toggle("on", !!hb);
    if (hb) {
      const r = this.#hover.rect;
      hlLabel.textContent = `${this.#hover.label}  ${Math.round(r.w)}×${Math.round(r.h)}`;
      // above the box, else below it, else inside its top edge
      const top = hb.top >= 22 ? hb.top - 22 : hb.top + hb.height + 26 <= vr.height ? hb.top + hb.height + 4 : hb.top + 4;
      Object.assign(hlLabel.style, { left: `${hb.left + (top === hb.top + 4 ? 4 : 0)}px`, top: `${top}px` });
    }

    // input below the selected element, above it if there is no room
    if (!note.hidden) {
      const W = note.offsetWidth, H = note.offsetHeight, pad = 8;
      const b = sb ?? { left: pad, top: pad, width: 0, height: 0 };
      let top = b.top + b.height + pad;
      if (top + H > vr.height - pad) top = b.top - H - pad;
      top = Math.max(pad, Math.min(top, vr.height - H - pad));
      const left = Math.max(pad, Math.min(b.left, vr.width - W - pad));
      Object.assign(note.style, { left: `${left}px`, top: `${top}px` });
    }
  }

  #bindAnnotate() {
    const { img, annotBtn, note, noteBox, noteHint } = this.$;
    annotBtn.addEventListener("click", () => this.#setAnnotate(!this.#annot));
    img.addEventListener("mousemove", (e) => {
      if (!this.#annot || !this.#frame.w) return;
      this.#hoverPt = this.#point(e);
      this.#probeHover();
    });
    img.addEventListener("mouseleave", () => {
      if (!this.#annot) return;
      this.#hoverPt = null;
      this.#hover = null;
      this.#drawHl();
    });
    img.addEventListener("click", async (e) => {
      if (!this.#annot || !this.#frame.w) return;
      e.preventDefault();
      const t = await this.#inspect(this.#point(e), true);
      if (t && this.#annot) this.#select(t);
    });
    new ResizeObserver(() => this.#drawHl()).observe(img);
    note.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = noteBox.value.trim();
      const target = this.#sel;
      if (!text || !target) return;
      noteHint.textContent = "보내는 중…";
      const res = await this.send(text, "annotate", { target });
      if (!res.ok) { noteHint.textContent = `전송 실패: ${res.error}`; return; }
      noteBox.value = "";
      if (this.#sel === target) this.#select(null);
    });
    noteBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); note.requestSubmit(); }
      if (e.key === "Escape") { e.preventDefault(); this.#select(null); }
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
    this.#drawHl();
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
      meta.textContent = `에이전트${m.script ? ` · 대본 ${m.script}` : ""} · ${time}`;
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
    this.#renderBusy();
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
