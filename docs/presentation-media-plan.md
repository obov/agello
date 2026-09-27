# Presentation media implementation plan

## Intended behavior

Screen recording and Korean Typecast narration are independent options, both off by default.

| Recording | TTS | Behavior |
| --- | --- | --- |
| Off | Off | Existing timed captions and presentation controls |
| On | Off | Record the shared presentation screen and captions |
| Off | On | Drive sentence captions from actual browser audio playback |
| On | On | Record presentation and captions; the narration driver also includes Typecast voice |

One browser owns narration playback. Other viewers share captions without playing duplicate audio. Recording belongs to the individual viewer and does not control presentation playback. The application composites its shared presentation and captions into a canvas, so recording does not require screen selection permission. A spectator can save video-only output while TTS is enabled; only the narration driver's recording includes its TTS audio.

## Ownership and sequence

The coordinator manages requirements, integration decisions, browser verification and final review. The backend implementation agent owns `src/player.ts`, `src/server.ts`, `src/tts.ts`, backend tests and this plan. The frontend implementation agent owns the browser component, media module and frontend tests. A separate reviewer checks cancellation, credential handling and recorded output. Agents edit shared files only within assigned ownership; no template install, additional dependencies or commits are required.

1. Agree on private key configuration, single playback driver and public event contract.
2. Implement provider coordination and player cancellation in the backend; implement independent audio and recording controls in the frontend.
3. Connect HTTP/SSE, settings and existing presentation captions.
4. Run regression tests, actual provider smoke verification, browser presentation tests and saved recording inspection.

## Backend interfaces

- `GET /tts`: public `{provider,configured,enabled,voiceId,language,model,driverId?,error?}`.
- `POST /tts`: `{enabled?,apiKey?,voiceId?,useLocalKey?,clearKey?,viewerId?}`. Only successful `enabled:true` ownership acquisition returns a fresh private `driverToken`. Configuration changes pause playback. Clearing credentials disables TTS. A connected UUID viewer is required to enable narration.
- `GET /events?viewer=<UUID>`: register a viewer connection; initial public TTS status and any currently started caption are included. Driver disconnect pauses the current line.
- `POST /tts/ack`: `{viewerId,driverToken,id,phase:'started'|'ended'|'error'}`. Only the current driver/current narration can acknowledge. Repeated or stale ACKs do not advance playback.
- `GET /tts/audio/<opaque UUID>`: MP3 bytes, `Cache-Control:no-store`. Missing/expired IDs return 404. Audio is held in bounded session memory.
- Public `speech` SSE: `{phase:'ready'|'cancel'|'ended'|'error',id,driverId?,at?,text?,audioUrl?,duration?,error?}`. `ready` goes to all viewers but only the driver plays it.
- On driver `started`, the backend publishes the existing `message` event with `{script,hold,narration}`. This is the caption start clock. `ended` and `cancel` remove that narration's caption.
- Existing `/player` remains `{cmd:'resume'|'pause'|'goto',at?}`.

The player's optional `narrate(text,at,signal,started)` returns a promise that resolves after actual audio completion, or null for existing text pacing. TTS mode keeps the current line position until completion. Every pause, goto, load or stop aborts the old run; old provider responses and ACKs cannot resume it. Hand raising pauses and replays the last interrupted sentence on resume. Audio failures and preparation/start/end timeouts pause rather than silently skip a sentence. Resume retries; TTS off restores text pacing.

## Provider and credentials

Typecast's official timestamp endpoint is used with `ssfm-v30`, Korean language, preset/normal emotion, MP3 and -14 LUFS. The current API limit is 2,000 characters per request; overlong sentences pause with an error instead of truncating. Sentence synchronization does not depend on word timing. The first version generates the current sentence and reuses cached audio on replay; it does not speculatively generate later sentences.

Keys are held in server memory only. `TYPECAST_API_KEY` may come from the process environment. The optional `useLocalKey:true` reads only `TYPECAST_API_KEY` from the fixed `../yt-outlier/.env` path relative to server startup cwd. It never evaluates shell expressions or writes credentials to another file. Local key import is explicit, and later clear/stop commands supersede an outstanding read. Configuration and provider errors use fixed codes and never include provider body, exception text or keys. No credential or driver token is sent through public status, SSE, script or chat events.

Provider documentation: https://typecast.ai/docs/api-reference/text-to-speech/text-to-speech-with-timestamps

## Verification and completion criteria

Backend tests must establish actual-start caption timing, ended-driven advancement, interruption replay, goto/load/stop cancellation, duplicate/foreign/stale ACK rejection, joining viewer caption restoration, driver disconnection, timeout handling, credential redaction and local import races. HTTP/SSE tests must exercise real server routes with fake provider traffic and fake Herdr, without invoking real agents.

Browser tests must verify all four option combinations, unsupported recording formats, blocked audio activation, recording lifecycle, independent stop controls and presentation exit cleanup. A saved artifact must include presentation/captions and, when recorded by the active narration driver, its TTS audio. Spectator recordings remain video-only. Microphone and unrelated tab audio are not captured. WebM output receives a duration header correction so players and inspection tools report the saved clip's length. Inspect duration, dimensions, video/audio tracks and visible caption changes. A static slide is valid and should not fail a freeze heuristic.

Verify audio/video alignment in the saved video against the visible caption changes. TTS recordings must retain a continuous audio clock through silence before the first sentence, between sentences and after the final sentence; silent gaps must not disappear or shift later narration earlier in the exported video. Inspect a recording with multiple spoken sentences and those silent intervals rather than only testing audio playback in the browser.

A real provider smoke check uses the authorized local key without printing it or copying it into the repository. The coordinator independently reviews integration and runs the complete existing test suite before delivery.
