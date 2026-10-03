# Claude Code 연결 지점과 Codex 호환성

## 조사 결과

agello는 Claude Code SDK/API나 Claude 훅을 직접 호출하지 않는다. 실행 중인 herdr pane에 텍스트를 전달하고, 에이전트의 로컬 기록을 읽어 브라우저에 표시한다. Claude 전용 부분은 에이전트 종류 판별, 세션 ID와 기록 파일 찾기, 기록 형식 해석이다.

| 기능 / 연결 지점 | 기존 Claude Code 동작 | Codex 적용 |
|---|---|---|
| 세션 및 상태 | `herdr agent get`의 `agent=claude`, `agent_session.value`, `agent_status` | `agent=codex`도 지원. herdr가 ID를 제공하면 사용하고, 없으면 정확한 pane의 Codex 프로세스가 연 rollout/writer lock에서 ID를 찾음 |
| 세션 변경 보호 | 시작 시 ID 고정, 다른 세션으로 교체되면 전송 거부 | 동일한 보호. 작업 폴더나 최신 파일만으로 세션을 추측하지 않음 |
| 채팅 기록 | `$CLAUDE_CONFIG_DIR/projects/*/<session>.jsonl` | `$CODEX_HOME/sessions/**/rollout-*<session>.jsonl` (기본 `~/.codex`). 기록이 늦게 생성되면 재탐색 |
| 터미널 / 브라우저 입력 구분 | `[browser] action=...` 접두사로 브라우저 메시지 표시 | 동일한 접두사와 화면 이벤트 유지 |
| 진행 설명 및 최종 답변 | assistant text, 특별한 narration thinking 블록 | Responses message와 최신 `item_completed/AgentMessage`의 공개 텍스트·`commentary`·`final_answer` 처리. 중복 기록은 한 번만 표시 |
| 내부 문맥과 추론 | sidechain, 일반 thinking 제외 | developer/system 문맥, reasoning 및 주입된 환경 문맥 제외 |
| 도구 실행 표시 | `tool_use` → `tool_result` | `function_call`, `custom_tool_call`과 결과, 최신 UI 도구 항목을 시작/종료 이벤트로 변환. 중단 시 남은 도구 정리 |
| 대기 중인 입력 | `queue-operation`, `queued_command`, FIFO 중복 억제 | 브라우저 전송은 기록에 확인될 때까지 대기 표시. Codex의 Tab 대기열은 로컬 queue DB를 읽기 전용으로 조회해 표시·수정·취소·전달 반영 |
| 메시지 / 승인 / 거절 버튼 | `herdr agent prompt`로 `[browser] action=...` 텍스트 전송 | 동일. 승인/거절 버튼은 에이전트에 보내는 요청이며, 실제 보안 승인 대화상자를 자동으로 처리하는 기능이 아님 |
| 입력 대화상자 보호 | herdr 상태가 blocked이면 `/send` 거부 | 동일하게 거부. 실제 승인/질문은 터미널 화면에서 처리 |
| 이미지 | 로컬 파일에 저장하고 `[image: 경로]` 텍스트 전달 | 동일. 모델의 로컬 이미지 도구로 열 수 있어야 하며, 모델 API에 이미지 자체를 자동 첨부하는 방식은 아님 |
| 화면 공유 / 사용자 조작 | terminal-browser CDP screencast 및 Input | 에이전트 종류와 무관하게 그대로 사용 |
| 요소 주석 | CSS selector·요소 설명·위치를 텍스트로 전달 | 동일하게 Codex에 전달 |
| 터미널 보기 | herdr terminal 제어 WebSocket 및 xterm.js | 동일 |
| pane 목록 / 연결 / 생성 | herdr workspace/tab/pane 및 `agello start` | 동일. Claude/Codex pane은 채팅 가능, 다른 프로그램은 터미널 보기 |
| 발표 / 대본 / 질문 | agello player, CDP 화면 이동, assistant 메시지 자막, `[browser]` 알림 | 동일. Codex 답변도 같은 자막 이벤트를 사용 |
| TTS / 녹화 | Typecast 음성, 브라우저 재생/녹화 | agello가 담당하므로 동일. 에이전트의 별도 음성 기능은 필요 없음 |
| 임베드 / 대화 저장 | `<agent-bridge>`, SSE, 브라우저의 pane별 localStorage | 기존 인터페이스 유지 |

## Codex에서 사용하기

herdr pane에서 Codex CLI를 실행한 다음 기존 명령을 사용한다.

```sh
agello start --pane <pane-id> --open
```

자동 세션 탐색에는 macOS/Linux의 `ps`와 `lsof`를 사용한다. herdr가 세션 ID를 제공하거나 다음처럼 직접 지정하면 기록을 ID로 찾을 수 있다.

```sh
CODEX_HOME="$HOME/.codex" agello start --pane <pane-id> --session <codex-session-id> --open
```

별도 인증 키·OpenAI SDK·훅 설치는 필요 없다. 실행 중인 Codex의 인증과 권한을 그대로 사용한다. Codex를 실행한 pane과 agello가 같은 로컬 기록에 접근할 수 있어야 한다.

에이전트나 세션을 교체했을 때는 시작 시 고정한 세션 보호를 유지하므로, 기존 서버를 종료하고 다시 시작한다.

```sh
agello stop --pane <pane-id>
agello start --pane <pane-id> --open
```

## 동작 차이와 적용 범위

Codex CLI는 작업 중 Enter로 전달한 입력을 현재 작업에 반영하고, Tab으로 입력을 다음 작업에 대기시킨다. agello의 전송은 herdr의 Enter 전송과 같다. Claude의 대기열 의미를 Codex 내부에 강제로 복제하지 않고 각 에이전트의 실제 입력 전달을 표시한다. [공식 Codex 입력 안내](https://learn.chatgpt.com/docs/prompting)

공식 App Server는 메시지·도구·작업 중 입력 반영을 지원하지만, 별도 서버를 띄워 기존 CLI 세션을 재개하면 같은 pane의 에이전트 실행권과 충돌할 수 있다. 따라서 이번 변경은 기존 herdr 프롬프트 경로를 유지한다. [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)

검증 기준은 설치된 Codex CLI **0.157.1**과 현재 herdr다. rollout 형식과 `queue_1.sqlite`는 공개 API 계약이 아닌 로컬 구현 형식이다. 구형 Codex의 Responses/event 메시지도 처리하지만 모든 버전의 대기열 형식을 보장하지 않는다. 대기열 DB가 없거나 스키마가 달라져도 채팅과 터미널은 계속 동작한다. 기록을 저장하지 않는 세션은 채팅 응답 표시를 지원하지 않는다.

## 검증

- 기존 Claude 및 발표·TTS·녹화·터미널 테스트 유지.
- Claude 대기열·narration·도구 이벤트 회귀 테스트 추가.
- Codex 신구 기록 형식·중복 억제·도구 오류/중단·대기 입력 확인 테스트 추가.
- 정확한 pane 프로세스 탐색, 공유 daemon 제외, 모호한 세션 거부, 별도 CODEX_HOME 테스트 추가.
- Codex HTTP/SSE 테스트로 주석·이미지 경로·진행 설명·최종 답변·도구 상태 복원·늦게 생성되는 기록·blocked/세션 교체 거부 확인.
- 실제 현재 Codex pane의 프로세스·세션·rollout 연결을 읽기 전용으로 확인. 실제 모델 응답 품질이나 모든 기능의 실사용 결과까지 자동 테스트가 보장하지는 않는다.
- ego-browser로 실제 Codex 상태·도구·공유 화면을 확인하고, 실제 진행 메시지가 한 번만 표시되는 것을 검증. 검증용 브라우저와 서버는 종료.
- 임시 CODEX_HOME의 Codex 0.157.1 App Server로 생성한 대기 항목에서 실제 SQLite 직렬화 형식(`UserInput.content`)을 확인해 회귀 테스트에 반영.
