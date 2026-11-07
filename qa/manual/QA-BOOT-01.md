# QA-BOOT-01 — 최초 owner 생성 운영 증거 (DEV_DESIGN 6-2 BOOT-01, 5-4 형식)

> 템플릿입니다. 아직 실행하지 않았습니다. 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | (미실행 — 실행 시 이름 기입) |
| 일시(KST) | (미실행 — YYYY-MM-DD HH:MM KST) |
| 기기·OS·브라우저(버전) | (미실행 — 예: Mac mini / macOS 버전 / 브라우저 해당 없음(CLI)) |
| 접속 경로 | localhost(로컬 CLI, DB는 127.0.0.1) — 원격 경로 없음 |
| 절차 | `docs/runbooks/BOOTSTRAP_OWNER.md` 4절 1–5번(합성 환경) |
| 기대 결과 | ① 빈 합성 DB에서 `bootstrap-owner` 종료 코드 0 ② 다른 이메일 재실행 종료 코드 1·`owner_exists`·행 수 무변경 ③ 출력·DB 덤프에 합성 비밀번호 0건 ④ owner를 만드는 원격 라우트 없음(통합 테스트) ⑤ 이후 초대 발급·member 수락(W-06 이후) |
| 실제 결과 | (미실행) |
| 판정 | `미검증` |
| 증거 경로 | (미실행 — 명령 출력 저장 경로 기입. 자동 증거: `apps/server/test/auth/bootstrap.int.test.ts`) |
