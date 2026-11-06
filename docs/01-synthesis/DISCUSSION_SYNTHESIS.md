# ohmyslack — Buzz 토론 합본

- 버전: v1.0 (2026-11-07) · 작성: Jarvis
- 입력: `docs/00-research/BUZZ_BRIEF.md`, `docs/00-research/buzz/{Claude-Fable,GPT-Sol,GPT-Luna,Claude-Opus}.md` (4/4 파일 전문 읽음)
- 영환님 결정(2026-11-07): ★안 전체 승인 + 다기기 동기화·모바일 웹(PWA)·출시 없음

## 1. 커버리지·검증

| 항목 | 상태 |
|---|---|
| 에이전트 산출물 | 4/4 파일 수신(02:17–02:26 KST) |
| 스레드 답글 중 파일 밖 내용 | 수집하지 않음. 이 합본은 파일 기준 |
| Jarvis 재검증 | ① Slack.app이 Mac App Store 빌드(`Contents/_MASReceipt/receipt` 4,849B) ② shared-infra Redis ACL(`docs/security/redis-isolation.md` 17·44행) — 둘 다 사실 확인 |
| 외부 약관 인용 | Claude-Fable 원문 인용(T1–T9, L3). Jarvis 재검증 전 — 외부 공유 전 Newton 확인 권장 |

## 2. 한 줄 결론

클린룸 자체 서버 웹 메신저(방향 1)는 가능하다. MVP는 웹·PWA 메시징 골격이며, 대화는 서버(PostgreSQL) 한 곳에 저장되어 맥·다른 맥·휴대폰에서 같은 대화와 읽음 상태를 본다. Slack과의 연동·코드·에셋은 쓰지 않는다.

## 3. 주제별 결론

| 주제 | 결론 | 상태 |
|---|---|---|
| 방향 | 1 (클린룸 자체 서버). 4는 P4 "공식 export 1회 가져오기"만 후보 | ✅ 합의 (점수 1번: 4·5·5·4) |
| Slack API 연동(방향 2·실시간 브리지) | 약관 "replicate or compete" 금지, 내부 예외 없음 → 제외 | 🔧 조정 후 합의 (D 2→1점) |
| REA | Slack.app 대상 종료. Electron 패턴 출처는 공식 문서로 대체. REA는 우리 산출물 검증에만 | ✅ 합의 |
| 이름 | ohmyslack = 내부 코드명, 공개 전 개명 | ✅ 합의 |
| MVP 범위 | B(GPT-Sol)안 + 모바일 웹(PWA) 반응형 | 🔧 영환님 추가 결정 |
| 데이터·서버 | PostgreSQL 단일 원장, 채널별 `seq`, `client_message_id`, 읽음 커서, Fastify 단일 HTTP/WS | ✅ 합의 (C안) |
| Redis | MVP 미사용(공용 ACL이 키·Pub/Sub 미허용) | 🔧 D·Jarvis 정정 후 합의 |
| 다기기 동기화 | 서버 원장 구조로 기본 제공. 접속 경로는 Tailscale(개인 tailnet) | ⚖️ 영환님 결정(2026-11-07) |
| 배포 형태 | 웹앱 + PWA, 스토어 출시 없음. 네이티브 앱·푸시는 v1 이후 | ⚖️ 영환님 결정(2026-11-07) |
| Electron | P3, 웹 MVP 검증 후 | ✅ 합의 |

## 4. 정정·충돌 기록

| # | 원래 주장 | 정정 | 근거 |
|---|---|---|---|
| 1 | Jarvis·D: "Redis 새 DB 번호로 pub/sub·presence·unread" | 불가. DB 번호는 경계가 아니고 ACL이 ohmyslack 키·채널을 막음 | C(GPT-Luna) C4, shared-infra 문서 |
| 2 | D: 방향 2 = 2점(레이트리밋·관리자 승인이면 성립) | 1점. 약관 조항은 그 조건으로 해소되지 않음 | A T1·T4 |
| 3 | Jarvis 1차 보고: REA 분석 위험 낮음 | Mac App Store 빌드 → Apple 표준 EULA 역분석 금지 적용 가능 → 추가 분석 중단 | A L1·L3, Jarvis 재검증 |
| 4 | D: P1–P3 각 1–2주 | 근거 약함 → B를 따라 달력 일정 미제시, 수용 기준 분해 후 산정 | B 확인 필요 5 |

## 5. 준수 사항

- 브리프 금지 사항 위반 보고 없음. A는 robots.txt Disallow 경로(Salesforce PDF)를 가져오지 않음.
- Slack 추출 사본(`~/.hermes/profiles/jarvis/cache/scratch/slack-asar`) 2026-11-07 삭제.

## 6. 남은 확인 필요 (영환님 또는 변호사)

1. App Store Slack 리스팅의 커스텀 EULA 여부 (A C1).
2. Salesforce MSA·AUP "Use Restrictions" 원문 (A C2).
3. 한국 저작권법 제101조의3·4 현행 문구 (A C3).
4. 계정·운영 경계: 초대 방식, 인증 제공자, 백업 책임자, 삭제 메시지 보존 의미 (B 결정 4) — P1 착수 전.

외부 공개 계획이 없으므로 1–3은 P1 착수를 막지 않는다. 외부 공개를 결정하면 필수가 된다.

## 7. 출처 원장

- 약관 원문(에이전트 조사, Jarvis 재검증 전): https://slack.com/terms-of-service/api , https://api.slack.com/developer-policy , https://slack.com/terms-of-service/slack-brand , https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
- 레이트리밋 변경: https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- PostgreSQL: https://www.postgresql.org/docs/current/textsearch.html , https://www.postgresql.org/docs/current/queries-limit.html
- REA Evidence: `ev_d4bb9636…`(fuse), `ev_f49e0e82…`/`ev_70bb0ffb…`(ASAR)
