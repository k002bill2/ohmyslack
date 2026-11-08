# QA-BOOT-01 — 최초 owner 생성 운영 증거 (DEV_DESIGN 6-2 BOOT-01, 5-4 형식)

> 합성 환경 리허설 결과입니다(런북 4절). 운영 계정 생성은 이 기록의 범위가 아니며, 운영 실행은 영환님이 직접 합니다(런북 머리말·DEV_DESIGN 6-2 BOOT-01).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, 자동 실행) |
| 일시(KST) | 2026-11-08 12:03 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / Node v26.13.0 · pnpm 10.30.2 / PostgreSQL 15.15(`shared-postgres` 컨테이너) / 브라우저 해당 없음(CLI) |
| 접속 경로 | localhost(로컬 CLI, DB는 127.0.0.1:5432 `ohmyslack_test` 안 임시 스키마 `b_20261108120341_6837`) — 원격 경로 없음 |
| 절차 | `docs/runbooks/BOOTSTRAP_OWNER.md` 4절 1–5번(합성 환경). ① `assert-test-db` 통과 후 빈 임시 스키마 생성·`migrate` ② `bootstrap-owner --email qa-owner@example.test` (비밀번호 stdin 파이프, 0600 파일) ③ 다른 이메일 `qa-other@example.test` 로 재실행, 전후 `users`·`workspace_members`·`workspaces` 행 수 비교 ④ 세 명령 출력 + `pg_dump --data-only` 덤프에서 합성 비밀번호 문자열 검색 ⑤ 임시 스키마 삭제 |
| 기대 결과 | ① 빈 합성 DB에서 `bootstrap-owner` 종료 코드 0 ② 다른 이메일 재실행 종료 코드 1·`owner_exists`·행 수 무변경 ③ 출력·DB 덤프에 합성 비밀번호 0건 ④ owner를 만드는 원격 라우트 없음(통합 테스트) ⑤ 이후 초대 발급·member 수락(W-06 이후) |
| 실제 결과 | ① `MIGRATE OK applied=1 total=1` 후 `bootstrap-owner` exit 0, 행 수 1,1,1 ② exit 1, stderr `bootstrap-owner 실패(owner_exists)…변경 없음`, 행 수 전 1,1,1 = 후 1,1,1 ③ 출력 0건·덤프(3,143 B) 0건, 덤프에는 argon2id PHC 해시 1행만 ④·⑤ 깨끗한 체크아웃(74b822e) `pnpm verify` 의 `apps/server/test/auth/bootstrap.int.test.ts` 5개 테스트 통과 — 지정 테스트 "BOOT-01 … owner를 만드는 원격 라우트가 없고 이후 초대 발급과 member 수락이 된다" 포함. 임시 스키마는 실행 끝에 DROP |
| 판정 | `PASS` |
| 증거 경로 | `reports/qa/boot-01/run.txt`(명령 출력, 비밀값 없음) · 리허설 스크립트는 세션 스크래치패드(저장소 밖) · 자동 증거 `apps/server/test/auth/bootstrap.int.test.ts`(W-16 verify 로그 `✓ apps/server/test/auth/bootstrap.int.test.ts (5 tests)`) |
