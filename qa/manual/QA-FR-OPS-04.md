# QA-FR-OPS-04 — 디자인 출처 검토 (DEV_DESIGN 6-2 FR-OPS-04, 5-4 형식)

> 기준: CLEANROOM.md, 디자인 §2(클린룸 원칙·§2-3 기계 검증 규칙)·§15(출처 원장). 금지 문자열 목록은 이 문서에 복제하지 않습니다(CLAUDE.md).
> 실행하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).

| 필드 | 값 |
|---|---|
| 실행자 | Claude(W-16 QA 레인, 문서·저장소 대조) |
| 일시(KST) | 2026-11-08 12:13 KST |
| 기기·OS·브라우저(버전) | 서버 Mac(arm64) / macOS 27.2 / 렌더 확인은 ego-browser 0.6.2.9 (Chromium 156.0) 스크린샷 |
| 접속 경로 | localhost(저장소 74b822e 정적 검사 + `http://127.0.0.1:<임의 포트>` 렌더) |
| 절차 | ① 깨끗한 체크아웃 `pnpm verify`의 `check:cleanroom`·`check:design-tokens` 결과 확인 ② `git ls-files`로 이미지·폰트·오디오 경로 전수(§2-3-2) ③ `manifest.webmanifest` `name`·`short_name`(§2-3-5) ④ 앱 심볼 `apps/web/public/icons/source.svg` 형태와 추가 커밋 본문의 출처 표기(CLEANROOM 4-1, §9-1) ⑤ 폰트 `PretendardVariable.woff2` sha256을 `fonts/SOURCES.md` 기록과 대조, `LICENSE.txt` 동봉 ⑥ 토큰 모듈 `source`·`license` 필드 수 ⑦ `docs/**`·`qa/manual/**` 이미지와 `SOURCES.md` ⑧ 렌더 화면에서 §2-2 회피 목록(사이드바 전면 유채색, 심볼 형태, 사운드) 육안 대조 |
| 기대 결과 | §2-3 1–6 전부 충족, §2-2 회피 목록 위반 0, 출처 없는 디자인 산출물 0 |
| 실제 결과 | ① W-16 verify에서 두 검사 통과(exit 0) ② 허용 경로(`public/icons/**`·`public/favicon.ico`·`public/fonts/**`) 밖 이미지·폰트 0개, 오디오 0개 ③ `name`·`short_name` = "메신저"(금지 부분 문자열 없음) ④ 심볼 = 청록(Radix teal 9) 바탕 위 엇갈린 두 원호, 파일 주석·커밋 `fb3e2f8` "W-04b app symbol + PWA icon set (self-made, no reference source)" ⑤ sha256 `9599f12f…82d900b4` = SOURCES.md 기록, 공식 v1.3.9 무수정·OFL `LICENSE.txt` 동봉 ⑥ `apps/web/src/ui/tokens.ts` `source:` 7·`license:` 7 ⑦ `docs/**`·`qa/manual/**`에 추적 이미지 0개(SOURCES.md 불필요) ⑧ 사이드바 중성 회색 면(액센트는 선택 표시·버튼 테두리만), 로고는 `#`·말풍선 형태 아님, 사운드 없음 |
| 판정 | `PASS` |
| 증거 경로 | W-16 verify 로그(세션 스크래치패드 `w16-verify.log`, `=== VERIFY PASSED`), 렌더 스크린샷 `reports/qa/client-07/offline-grayscale.png`·`reports/qa/client-02/w1280-closed.png` — `reports/`는 gitignore(로컬 보관), 위 실제 결과 칸이 대조 요약 |
