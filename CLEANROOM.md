# CLEANROOM.md — ohmyslack 클린룸 규칙

- 상태: 채택 (2026-11-07, 영환님 ★안 승인)
- 근거: `docs/00-research/buzz/Claude-Fable.md` 4절, `docs/01-synthesis/DISCUSSION_SYNTHESIS.md`
- 적용 범위: 이 저장소의 모든 코드·문서·에셋·디자인 토큰·커밋

## 1. 이 제품은 무엇이고 무엇이 아닌가

- ohmyslack은 **팀 메신저라는 일반 개념**(채널·DM·스레드·멘션·읽음)을 공개 지식으로 삼아 새로 작성한 개인 전용 웹 메신저다.
- Slack의 코드·에셋·데이터·룩앤필을 복제한 제품이 아니다. Slack과 연동하지 않는다.
- "ohmyslack"은 **내부 코드명**이다. 저장소 공개·도메인·앱 이름·외부 공유 전에 개명한다. "slack"이 들어간 도메인 등록이나 상표 출원은 하지 않는다.

## 2. 참고해도 되는 것

1. 공개 문서: 일반 메신저 개념 설명, 오픈소스 프레임워크·DB 공식 문서.
2. 동작 수준의 일반 UX 관념: "스레드는 원문 옆 패널에서 연다", "채널 unread와 스레드 unread는 분리한다" 같은 아이디어. 메모는 글로만 남긴다.
3. Electron 공식 보안 문서(P3). REA 결과와 같은 내용이라도 **출처는 Electron 문서로 적는다**.
4. 사용자가 정당하게 받은 Slack 공식 export 파일(P4 선택, 별도 승인 후).

## 3. 쓰면 안 되는 것

1. Slack 웹앱 소스(Service Worker 캐시)·데스크톱 번들(ASAR) 코드의 복사·이식·변형. REA 결과의 코드 조각도 넣지 않는다.
2. Slack 에셋: 사운드(mp3), 아이콘, 이모지 이미지, 폰트, 로고·# 심볼, 시그니처 색 조합(자주색 사이드바 계열).
3. 픽셀 단위 UI 복제, Slack 스크린샷을 제품 UI·저장소·문서에 포함.
4. 로그인된 실제 Slack 워크스페이스 데이터 조회·추출, 사용자 토큰(xoxp)으로의 수집.
5. Slack.app 대상 추가 리버스 엔지니어링(디버거·Frida·`.node` 디스어셈블·재서명·로컬 DB 열람).

## 4. 기록 규칙

1. 기능을 추가할 때 PR/커밋 본문에 "참고 출처: <공개 문서 또는 '일반 관념'>"을 한 줄 남긴다.
2. 디자인 토큰(색·폰트·아이콘 세트)은 `docs/05-design-ref/DESIGN_REFERENCE.md`의 오픈 출처만 쓴다.
3. 이름 변경은 `docs/decisions/`에 ADR로 남긴다.

## 5. 기계 검증 (CI·QA 게이트)

```bash
# 0건이어야 통과. node_modules·docs/00-research(토론 원문)·이 파일은 제외.
grep -rIinE 'tinyspeck|slack-edge|app\.slack\.com|animal_stick|been_tree|hummus|knock_brush' \
  --exclude-dir={node_modules,dist,.git,00-research,01-synthesis} --exclude=CLEANROOM.md . && exit 1 || echo CLEANROOM OK
```

- P3 Electron 패키지에는 REA `inspect_electron_fuses`·`analyze_javascript_application`(우리 산출물 대상)으로 같은 문자열 0건을 확인한다.

## 6. REA 사용 종료 선언

- Slack.app 대상 REA 분석은 2026-11-07에 종료했다. 결과는 `docs/00-research/` 안의 요약으로만 보관하고, 추출 사본(`cache/scratch/slack-asar`)은 같은 날 삭제했다.
- 이후 REA는 **우리 산출물 검증**에만 쓴다.
