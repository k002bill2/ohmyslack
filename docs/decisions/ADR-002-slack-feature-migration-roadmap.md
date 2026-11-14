# ADR-002 — Slack 기능 추가 이전 로드맵 (관찰 창 동결 → 단계별 이전)

- 상태: **채택(Accepted) — 2026-11-10 영환님** 「앞으로 진행 스케줄대로 진행」 + 결정 D-2 「문서 전송 필요: PDF·PPT·엑셀·Word·한글 등」. 아래 ★는 영환님의 ★ 자동 진행 원칙에 따라 함께 채택.
- 작성: Jarvis (2026-11-10)
- 입력: Buzz 3차 토론 `docs/00-research/BUZZ_SLACK_PARITY_BRIEF.md`, 결과 `docs/00-research/buzz-parity/{GPT-Sol,GPT-Luna,Claude-Fable,Claude-Opus}.md`
- 정본 관계: 이 ADR은 **순서·게이트**만 정한다. FR·수용 기준은 PRD, 계약은 TRD, WBS·테스트는 DEV_DESIGN, 문구·상태는 DESIGN_REFERENCE가 정본이며, 각 단계 착수 레인이 그 문서를 고친다(ADR-001과 같은 방식).
- 참고 출처: 일반 관념(팀 메신저의 문서 첨부·검색·처리 상태), 저장소 내부 문서. 상용 메신저 코드·에셋 미참조(`CLEANROOM.md`).

## 1. 결정 요약

1. **지금(11-10–11-16)은 기능 동결.** 4명 만장일치(방향 4 = 5점). 문서·계약 초안·평가 계획만 쓴다.
2. **착수 게이트 = 전환 판정(H4, 영환님) 완료 AND G1 통과.** 11-17은 자동 전환일이 아니다.
3. 동결 해제 뒤 **하이브리드, 단계당 최대 3개 · 서버 계약 축 1개**로 이전한다(§3).
4. **문서 전송은 Slack을 끄기 전 필수(D-2, 영환님).** 범위 PDF·PowerPoint·Excel·Word·한글(§4). 1단계에 넣는다.
5. 반응·저장·고정·그룹 DM·사람 presence·예약 전송·Electron은 **사용 증거가 생길 때까지 보류**.

## 2. 0단계 — 관찰 창 2026-11-10(화)–11-16(월): 동결

### 2-1. 하지 않는다
어댑터·서버·웹·푸시 코드 변경, Hermes `config.yaml`(승인 모드·`streaming`·`cron.mirror_delivery` 포함), 마이그레이션, 배포. 순수 웹 변경도 전송·열람·알림 탭 경로에 닿으므로 면제하지 않는다(GPT-Sol). 관찰을 막는 결함이 나오면 영환님 승인 + **관찰 재시작일 기록**을 조건으로 별건 처리한다.

### 2-2. 관찰 방법 보강 (D-1 ★)
- 브리핑은 「메시지 도착」이 아니라 **「mp3 첨부 도착」**으로 기록한다(음성 포함 작업에 한함).
- 매일 게이트웨이 로그에서 `morning-ai-brief`의 ohmyslack 전달 경로를 기록한다: `via live adapter`(정상) / `falling back to standalone`(**음성 유실 위험** — 아래 사실 참조).
- standalone 낙하로 음성이 빠진 날은 ①·② **실패**로 처리한다(D-1 ★).
- 사실(코드, L1): `integrations/hermes-plugin/ohmyslack/adapter.py:582-606`의 `standalone_send`는 첨부를 쓰지 않고 `success: True`를 반환하며 `warnings`를 싣지 않는다. Hermes는 standalone 결과의 `warnings`만 오류로 올린다(`~/.hermes/hermes-agent/cron/scheduler_delivery.py:1637-1642`) → 유실이 로그에 남지 않는다. 낙하 자체는 `falling back to standalone` 경고로 남는다(`:1156,1323`). — 1a에서 해소(미배포, 브랜치 `k002bill2/p2s1-standalone-attach` `ec55851`, 2026-11-13).
- 1일째(11-10) 기록(L1, Jarvis 로그 확인): `morning-ai-brief` 08:09:48 `delivered to ohmyslack:… via live adapter` — standalone 낙하 없음. mp3 첨부 포함 여부는 이 로그로는 미확인.

### 2-3. ⑤ 승인 왕복 증거 (C-2 ★)
`qa/manual/QA-FR-BOT-06.md:16`의 11-09 `manual` 왕복 1회 PASS를 ⑤ 증거로 인정한다. Jarvis 승인 모드 `smart`에서는 승인 요청이 자연 발생하지 않을 수 있고, 관찰 창 중 설정 변경은 동결 위반이다. `QA-HERMES-CUTOVER.md` ⑤행과의 불일치는 QA 레인이 판정 시 한 줄로 정리한다.

### 2-4. 창 안에서 해도 되는 문서 작업
1. 문서 첨부 계약 초안(§4 → TRD §6-1 개정안 텍스트, 미반영).
2. 한국어 검색 합성 질의·기대 결과 설계(실행·DB 접속 없이).
3. `THREAT_MODEL.md` 개정안 초안: 문서 첨부(TM-ATT), 승인 카드(TM-APR, Claude-Fable §3), TM-BOT-06 서술 정정.
4. `DESIGN_REFERENCE.md` 추가 항목 초안(Claude-Fable §5).

## 3. 단계 계획 (게이트 통과 후)

### 1단계 — 전환 판정 + G1 통과 직후 (계약 축: 첨부 TRD §6-1)
| # | 항목 | FR | 규모(추정) | 비고 | 진행 상태(2026-11-13) |
|---|---|---|---|---|---|
| 1a | **standalone 첨부 처리** — 대체 경로에서도 첨부 업로드, 실패 시 `warnings` 반환 | (FR-BOT-05 보강) | S | 어댑터 단독, 서버 계약 변경 없음. 가장 먼저 | 구현 완료·미배포·Codex 리뷰 중(`k002bill2/p2s1-standalone-attach`) |
| 1b | **문서 첨부(§4)** — 서버 허용목록·판정·다운로드 + 어댑터 `send_document` + 웹 표시 | FR-OPS-09(P1→채택) | M–L | D-2 필수. 한글·Office 판정 때문에 L 가능 | 계약(TRD §6-1-1)·화면 명세(UI_STATES §2-13) 완료(2026-11-13), 구현 미착수 |
| 1c | **기기 세션 화면·원격 종료** | FR-AUTH-04 | S | 기존 `GET /api/sessions` 재사용. 기기 표시는 거친 라벨만(C-4 ★) | 화면 명세(UI_STATES §2-14) 완료, 계약 TRD §5-3(p2s1-canon-align), 구현 미착수 |
| 1d | **정합 수정 묶음** — 알림 제목 코드명 → manifest 이름(C-6 ★), TM-BOT-06 문서 정정 | — | S | 푸시 `Topic` HMAC(C-5 ★)은 푸시 경로라 2단계로 이동(계약 축 1개 원칙) | 미착수 |

### 2단계 — 1단계 안정 후 (계약 축: WS frame / 푸시)
- Jarvis **처리 중 표시**(FR-OPS-07 중 봇 처리만): 봇 WS 상향 ephemeral frame, DB·sync 미사용(GPT-Luna·Claude-Opus X5). 사람 presence 제외.
- 푸시 `Topic` HMAC(C-5).
- 승인 대기 알림 고정 문구(C-3 ★, 명령 문구 미포함).
- clarify 구조화(FR-BOT-12 제안, D-4 ★) — 텍스트 경로가 실제로 불편하다는 관찰 증거가 있을 때만.

### 3단계 — 사용 증거 후
- 한국어 메시지 검색(FR-OPS-06, L) — 0단계 합성 평가 먼저. 결과 강조는 오프셋 반환, `ts_headline` HTML 직접 삽입 금지(Claude-Fable §4-3).
- 채널에서 Jarvis 부르기 — `BOT_CHANNEL_SPEC` FR-BOT-08–11(D-4 ★), Q1–Q8 결정 후.
- 버튼형 승인 FR-BOT-07 — 보류(D-6 ★). 착수 시 조건: `request_id` 결속 필수, 버튼은 1회 승인·거절만(`session`·`always`는 텍스트 전용), 텍스트 `/approve` 병행(C-1 ★).

### 보류 (사용 증거 전 착수 안 함)
반응(착수 시 OS 기본 이모지만, 이모지·사운드 파일 0 — C-7 ★), 저장·고정, 예약 전송, 비공개 채널·그룹 DM·보관, 사람 presence, Electron, Slack export 가져오기.

## 4. 문서 첨부 범위 (D-2, 영환님 2026-11-10)

### 4-1. 요구
PDF, PowerPoint, Excel, Word, 한글을 Jarvis ↔ 영환님 사이에서 주고받는다. 표시는 **다운로드 전용**(인라인 미리보기 없음, PRD FR-OPS-09).

### 4-2. 허용 형식 초안 (TRD §6-1 개정 대상 — 미반영)
| 형식 | 확장자 | 서버 판정(매직 바이트 + 컨테이너 내부) |
|---|---|---|
| PDF | `.pdf` | `%PDF-` |
| Word / Excel / PowerPoint (OOXML) | `.docx` `.xlsx` `.pptx` | ZIP + `[Content_Types].xml` + `word/`·`xl/`·`ppt/` 디렉터리 |
| 한글 (HWPX) | `.hwpx` | ZIP + `mimetype` = `application/hwp+zip` |
| 한글 (HWP 5.x) | `.hwp` | OLE 복합 문서(`D0 CF 11 E0`) + `FileHeader` 스트림 서명 `HWP Document File` |
| 구형 Office (선택) | `.doc` `.xls` `.ppt` | OLE 복합 문서 + `WordDocument`·`Workbook`·`PowerPoint Document` 스트림 |

- 판정은 ZIP 중앙 디렉터리·OLE 디렉터리 **목록만** 읽고 압축 해제하지 않는다(zip bomb 회피). 선언 MIME·확장자는 신뢰하지 않는다(FR-OPS-05 ②와 같음).
- 다운로드: `Content-Disposition: attachment; filename*=UTF-8''…`(RFC 6266/5987), `no-store`·`nosniff`·`sandbox` 유지. 원 파일명 컬럼 추가 필요(현재 `attachments`에 없음 — `apps/server/migrations/0003_attachments.sql:5-21`).

### 4-3. 결정 (영환님 2026-11-10 「1 받는다 2 받는다 3 양방향 4 크기제한적용 5 90일」)
1. **매크로 포함 문서 — 받는다.** (Jarvis ★안 「거부」와 다른 결정. 해석 근거: 답변 원문 「받는다」.) 조건(보안 가드, 1b 레인 수용 기준):
   - 서버는 문서를 **실행·변환·미리보기하지 않는다**(§5-7 유지). 다운로드는 `Content-Disposition: attachment`만.
   - 업로드 시 매크로 저장소(OOXML `vbaProject.bin`, OLE `Macros`·`_VBA_PROJECT_CUR`·`VBA`)를 **목록 판정만으로** 감지해 첨부 메타 `has_macros`로 저장하고, 웹은 첨부 행에 「매크로 포함」 경고 표지를 텍스트로 표시한다(색 외 표시, FR-CLIENT-07). 문구는 COPY_GAPS에 추가 후 결정.
   - 확장자-형식 일치 강제: 매크로가 감지된 OOXML은 `.docm/.xlsm/.pptm` 확장자로만 저장·다운로드한다(매크로를 `.docx`로 위장해 받는 경로 차단). 불일치 시 415.
   - Jarvis(Hermes) 인바운드: 받은 문서는 텍스트 추출만 하고 Office 앱으로 열거나 매크로를 실행하지 않는다(어댑터 문서 캐시는 기존 이미지 캐시와 같은 경계, 보존 후 삭제).
   - 추정 위험: 매크로 문서를 연 기기(Mac Office)의 매크로 보안 설정에 의존한다 — 제품 경계 밖, 경고 표지로만 완화.
2. **구형 Office(.doc/.xls/.ppt) — 받는다.** 한글 `.hwp`와 같은 OLE 판정기 사용.
3. **방향 — 양방향.** 봇→사람(`send_document`) + 사람→봇(웹 업로드 → 어댑터 인바운드 문서 → Hermes 세션). Claude-Fable C-8(봇→사람만)은 채택하지 않음.
4. **크기 상한 — 적용.** 문서 전용 상한 **25 MiB/파일**(★안 수치, 정본 TRD §6-1에서 상수로 확정). 이미지·음성 10 MiB는 유지. 업로드 라우트 body 상한·봇 리스너 상한도 같은 값으로 맞춘다. PostgreSQL `attachment_blobs` 저장이라 백업·복원 드릴(FR-OPS-02) 시간 영향을 1b 레인에서 측정한다.
5. **보존 — 90일.** 경과 시 바이트 삭제, 메타데이터는 「만료된 첨부」 자리표시자로 유지(FR-OPS-05 ⑤와 같은 규칙). 메시지 삭제 시 즉시 바이트 삭제.
- (Q12 추가 ★, Jarvis 2026-11-13) 텍스트 계열 `.txt`·`.md`·`.csv`도 받는다 — 영환님 D-2 「등」 범위 해석, 사후 조정 가능. 위 1–5 결정은 그대로 적용하며 계약은 TRD §6-1-1 R3.6.

### 4-4. 확인 필요
- iPhone 홈 화면 PWA에서 `Content-Disposition: attachment` 응답의 저장·「파일」 앱 열기 동작(실기).
- iPhone에서 `.hwp/.hwpx` 열기는 한컴 앱 설치 여부에 좌우(제품 범위 밖, 안내 문구만).
- Hermes 쪽 `send_document`가 넘기는 `file_name`·MIME 값과 인바운드 문서 처리 경로(`~/.hermes/hermes-agent/gateway/platforms/base.py:3101`).

## 5. 하지 말 것
1. 관찰 창 중 어댑터·푸시·Hermes 설정 변경.
2. 11-17을 자동 전환일로 취급.
3. Slack Block Kit 등 Slack 고유 포맷을 봇 계약으로 들여오기, Hermes Slack 어댑터 코드 복사(읽기·비교만).
4. 버튼 승인이 텍스트 `/approve`를 대체.
5. 게이트웨이 스트리밍 켜기(편집 이벤트의 sync·unread·푸시 영향 확인 전).
6. 한 단계에 서버 계약 축 2개 이상.
7. Redis·외부 검색 엔진·브로커, 본문 지속 캐시, 문서 인라인 렌더(서버·웹 어느 쪽도 Office/HWP 파싱·변환 안 함).

## 6. 일정

| 날짜 | 무엇 | 누가 |
|---|---|---|
| 11-11–11-17 매일 10:00 | 관찰 일지: 전일 브리핑 ohmyslack 전달 경로(live/standalone), 게이트웨이 재시작, 어댑터 fatal 0 — `dev/handoff/cutover-watch/LOG.md` 누적 + 스레드 보고 | Jarvis cron(읽기 전용) |
| 관찰 창 중 | §2-4 문서 초안 | Jarvis(영환님 지시 시 레인) |
| 11-17(화) 10:30 | 7일 종합 + 전환 판정 준비물 + 1단계 레인 구성표(미실행) 보고 | Jarvis cron |
| 11-17 이후 | 전환 판정(H4) | 영환님 |
| 판정·G1 후 | 1단계 레인 dispatch(1a → 1b·1c 병렬 → 1d), §4-3 결정(11-10 확정) 적용 | Jarvis → Orca |

## 7. 근거 문서
- 만장일치 동결: GPT-Sol §1, GPT-Luna 결론, Claude-Fable §1, Claude-Opus §1.
- Jarvis 기능 텍스트 대체 경로: Claude-Opus §2-1 (`base.py:2780-2857`, `run.py:591-613`).
- 승인 FIFO 결속: Claude-Fable §1-3 (`tools/approval.py:144-190`).
- 정합 문제 3건: Claude-Fable §2-3.
