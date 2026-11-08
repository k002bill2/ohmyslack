# QA-FR-CLIENT-07 — 200% 확대·그레이스케일 상태 구분·이름·포커스 (DEV_DESIGN 6-2 FR-CLIENT-07, 5-4 형식)

> 기준: PRD FR-CLIENT-07 + 디자인 §7-1·§11-3·§11-5. 수동 열: "200% 확대에서 주요 조작 가능, 그레이스케일에서 상태 구분".
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, ego-browser 자동 조작) |
| 일시(KST) | 2026-11-08 12:10–12:14 KST, 보강 12:27 KST, 재검증 14:21–14:23 KST(F-4 수정 후, 브랜치 `feat/w16-keymap-focus` 빌드) |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / ego-browser 0.6.2.9 (Chromium 156.0) |
| 접속 경로 | localhost(`http://127.0.0.1:<임의 포트>`, 커밋 74b822e 빌드) |
| 절차 | ① AX 트리(`Accessibility.getFullAXTree`)에서 이름 없는 상호작용 요소 수: wide 홈·대화·대화+스레드·`채널 찾기`·`DM 시작`·`채널 만들기` 대화상자·멤버 관리·200% 목록 ② 200% 확대 동등 조건(1280px 창 × 200% = CSS 640px, DSF 2)에서 SCR-04 조작: 채널 만들기(compact 화면)·전송·`메시지 작업`→`수정`·`삭제`(확인 대화상자)·`답글`·`채널 나가기`(확인 대화상자)·`뒤로` ③ 상태 4종을 만들고 `html{filter:grayscale(1)}` 캡처: 전송 중(응답 지연 3초, wide), 전송 실패+연결 끊김(오프라인 후 전송), 저장 여부 확인 중(CDP Fetch로 전송 요청만 ConnectionReset) ④ 포커스 표시 계산 스타일 ⑤ 스레드 닫기 후 포커스(QA-FR-CLIENT-01 로그) |
| 기대 결과 | 주요 조작 접근 가능한 이름 100%, 가시 포커스(정본 §7-1: **2px 링 + 2px 오프셋**), 200%에서 주요 조작 가능(구간이 내려가도 통과), 전송 중·저장 여부 확인 중·실패·연결 끊김이 색 없이도 텍스트로 구분, 스레드 닫으면 원래 `답글`로 포커스 |
| 실제 결과 | ① 상호작용 요소 수/이름 없음: wide 홈 7/0 · wide 대화 37/0 · wide 대화+스레드 43/0 · `채널 찾기` 1/0 · `DM 시작` 1/0 · `채널 만들기` 3/0 · 멤버 관리 8/0 · 200% 목록 8/0 ② 200% 동등(SCR-04): 채널 만들기 → 전송 2건 → 수정 후 "(수정됨)" → 삭제 확인 대화상자(`닫기·취소·삭제`) → "삭제된 메시지입니다" → 답글 전송 → 채널 나가기 확인(`닫기·취소·나가기`) → 작성기 숨김·"이 채널을 나갔습니다…"·`다시 참여` 표시, 가로 넘침 0, `뒤로`로 목록 복귀. 멘션 후보 선택(재검증): 실제 초대 흐름으로 만든 두 번째 멤버가 채널에 참여한 뒤, 같은 200% 조건(compact 640px·DPR 2)에서 `@검증` → 후보 `검증 멤버둘` → `Enter` 선택 → 전송, DB `message_mentions` 1건, 가로 넘침 0 ③ 그레이스케일에서 텍스트로 구분: "전송 중"(투명도 1, `sending-grayscale.png`) / "전송 실패" + `다시 시도`·`삭제` / 상단 배너 "연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요."(아이콘 동반) / "저장 여부 확인 중" + `다시 시도`·`목록에서 지우기` ④ 버튼 포커스 `outline: solid 2px rgb(13,155,138)`. 작성기: 1차는 1px 테두리 색 변화뿐(정본 위반, F-4) → 수정 후 재검증에서 작성기 상자 `outline: solid 2px rgb(13,155,138)`·`outline-offset: 2px`(전역 `:focus-visible`과 같은 링) ⑤ wide·medium 모두 스레드 닫기 후 포커스 원문 `답글` 버튼 |
| 판정 | `PASS` — 수동 열 두 항목(200%에서 SCR-04 주요 조작 전부: 만들기·전송·수정·삭제·답글·멘션 선택·나가기, 그레이스케일 4상태 텍스트 구분)과 FR 수용 기준(이름·가시 포커스·스레드 포커스 복귀) 충족. 1차 FAIL 원인 F-4는 수정 후 재측정으로 해소 |
| 증거 경로 | `reports/qa/client-07/a11y.json`, `reports/qa/client-07/zoom200-scr04.json`, `reports/qa/client-07/zoom200-mention-db.json`, `reports/qa/client-01-r3/composer-ring.png`·`keyboard-r2.json`(composerRing), `reports/qa/client-07/{offline-grayscale,unknown-grayscale,sending-grayscale,zoom200-thread,zoom200-delete-dialog,zoom200-left,zoom200-mention-picker,zoom200-mention-sent,after-online,composer-focus,member-admin}.png` — `reports/`는 gitignore(로컬 보관) |
