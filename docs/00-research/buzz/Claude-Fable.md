---
title: "ohmyslack — A. 가능성·위험 판정 (Claude-Fable)"
tags: [ohmyslack, feasibility, legal-risk, clean-room, rea]
status: draft
created: 2026-11-07
---

# A. 가능성·위험 판정 — Slack 약관·클린룸 경계·REA 추가 가치

> 작성: Claude-Fable (pubkey `2f4fc939…`), 2026-11-07
> 역할: 브리프 3-A. 결정은 영환님이 내립니다. 아래는 권고이며 법률 자문이 아닙니다.
> 범위 준수: 외부 사이트는 robots.txt 확인 후 허용 경로만 조회했습니다. Slack 웹앱 소스 다운로드·복원·디버거 연결·Slack.app 수정·로그인 데이터 조회는 하지 않았습니다. 로컬에서는 `/Applications/Slack.app` 번들의 서명·영수증·라이선스 파일만 읽기 전용으로 확인했습니다.

## 1. 결론

1. **클린룸 Slack형 메신저(방향 1)는 가능합니다.** Slack 약관은 "서비스 복제·경쟁 목적의 API 사용"과 "Slack 소스·영업비밀 역분석"을 금지하지만, Slack을 쓰지 않고 공개 문서·일반 UX 관념만 참고해 새로 쓰는 제품은 그 조항의 적용 대상이 아닙니다. 위험은 코드가 아니라 **이름(ohmyslack)과 트레이드 드레스(색·소리·아이콘·폰트·룩앤필 모방)** 에 있습니다.
2. **방향 2·4(공식 API로 Slack 워크스페이스에 붙는 클라이언트·브리지)는 약관상 위험이 가장 큽니다.** API Terms of Service는 "(C) access our APIs in order to replicate or compete with the Services"를 명시적으로 금지하고, Developer Policy도 "Using the Slack API to replicate or compete with core products or services offered by Slack"을 금지합니다. Slack 대체 클라이언트는 이 문구에 정면으로 닿습니다. 회사 워크스페이스라면 관리자 승인도 필요합니다.
3. **REA 추가 분석은 중단을 권합니다.** 설치된 Slack.app은 Mac App Store 빌드(`_MASReceipt/receipt` 존재, 서명 Authority `Apple Mac OS Application Signing`)이므로 Apple 표준 EULA의 "reverse-engineer, disassemble, attempt to derive the source code" 금지가 계약으로 걸립니다(법이 허용하는 범위 예외). 이미 확보한 Electron 셸 패턴은 Electron 공식 보안 문서와 겹쳐 추가 분석의 제품 기여가 작고, 계약 위험만 남습니다. 추가로 할 가치가 있는 정적 분석은 3건이지만 모두 "Slack.app이 아닌 우리 산출물"을 대상으로 합니다(5절).
4. **"ohmyslack" 이름은 내부 코드명으로만 쓰고, 공개(저장소 공개·도메인·앱 이름) 전에 바꾸는 것을 권합니다.** Slack Brand Terms는 "slack"이 들어간 도메인 등록과 변형·고의 오기(misspelling)까지 금지하고, 상표 출원도 금지합니다. 제품명 자체를 금지하는 문장은 없지만 혼동·연계 암시 금지 조항과 도메인 금지가 실질적으로 공개 사용을 막습니다.

### 방향 점수표 (1–5, A 관점: 약관·법적 위험 × 클린룸 유지 가능성)

| 방향 | 점수 | 한 줄 근거 |
|---|---|---|
| 1. 클린룸 자체 서버 | **4** | 약관 적용 대상이 아님. 남는 위험은 이름·트레이드 드레스로, 규칙(4절)으로 통제 가능. 1인 개발이라 전통적 2팀 클린룸은 불가 → 출처 기록 규칙으로 대체. |
| 2. 공식 API 커스텀 클라이언트 | **1** | API Terms (C)·Developer Policy "replicate or compete" 조항에 직접 닿음. 내부 사용이라도 조항은 예외를 두지 않음. 레이트리밋(D의 E4) 별도. |
| 3. REA 보고서만 | 2 | 위험은 "이미 한 분석의 공개 여부"에 집중. 내부 메모로 두면 낮고, 외부 공개하면 Apple EULA·Slack 약관 쟁점이 생김. 제품 가치 없음. |
| 4. 하이브리드(1 + Slack 브리지) | 2 | 실시간 브리지는 2와 같은 조항 + API 데이터 보존 제한에 닿음. **공식 워크스페이스 export 파일 가져오기(1회성)만이면 3점** — 이는 API가 아니라 Customer가 정당하게 받은 자기 데이터이므로. |

**추천: 방향 1.** 방향 4는 "export 가져오기 1회"로 축소한 변형만 P4 후보로 남길 것을 권합니다(D의 P4 ①과 일치).

## 2. 근거

### 2-1. 조회 범위·허용 확인

| ID | 내용 | 출처 |
|---|---|---|
| R1 | `slack.com/robots.txt`·`api.slack.com/robots.txt`: `/terms-of-service*`, `/acceptable-use-policy`, `/main-services-agreement`, `/brand-guidelines`, `/developer-policy` 는 Disallow 목록에 없음(Disallow는 `/messages`, `/oauth`, `/files-pri/` 등 14개 경로) | 2026-11-07 curl 직접 확인 |
| R2 | `www.salesforce.com/robots.txt`: `Disallow: /content/dam/` → Salesforce MSA·AUP **PDF는 금지 경로**라 가져오지 않음 | web-fetch 보조 확인 |
| R3 | `law.go.kr/robots.txt`: `Allow: /` 이나 법령 본문이 JS 렌더라 텍스트 미획득(혼잡 오류 페이지 1회) | web-fetch 보조 확인 |
| R4 | `apps.apple.com/robots.txt`: 앱 상세 페이지는 금지 아님. **단, 리스팅의 "License Agreement" 필드(커스텀 EULA 여부)는 이번 세션에서 확인하지 못함** | curl 직접 확인(robots만) |

### 2-2. Slack 약관 원문 (인용은 영어 원문 그대로)

| ID | 문서 · 날짜 | 인용 | URL |
|---|---|---|---|
| T1 | **API Terms of Service** (Effective: October 10, 2025) | "you will not: … (C) access our APIs in order to replicate or compete with the Services; (D) attempt to reverse engineer or otherwise derive source code, trade secrets, or know-how of our APIs or Services; or (E) attempt to use our APIs in a manner that exceeds rate limits, or constitutes excessive or abusive usage." | https://slack.com/terms-of-service/api |
| T2 | API Terms of Service | "You may not Commercially Distribute an Application that integrates with the Slack APIs unless you are authorized to do so under a separate agreement with Slack or our parent company, Salesforce. … These restrictions do not apply if your Application and any products or services connected to it were created for use only by a single third party." | 같은 페이지 |
| T3 | API Terms of Service (Data Access API 절) | "When using these APIs as a third-party Application provider, you may not create persistent copies, archives, indexes, or long-term data stores of other organizations' API Data." | 같은 페이지 |
| T4 | **Slack Application Developer Policy** (Effective Date: December 10, 2024) | 금지 항목: "Attempting to reverse engineer or otherwise derive source code, trade secrets, or know-how in the Slack API or any portion thereof" / "Using the Slack API to replicate or compete with core products or services offered by Slack" / "Circumventing Slack's intended limitations (including pricing, features and access structures)." | https://api.slack.com/developer-policy |
| T5 | **User Terms of Service** (Effective Date: February 17, 2023) | 리버스 엔지니어링·복제 금지 문장 **없음**. 대신 AUP를 참조로 편입: "you agree to comply with the most recent version of our Acceptable Use Policy, which is incorporated by reference into these User Terms." 준거법은 Customer의 Contract를 따름. | https://slack.com/terms-of-service/user |
| T6 | **Acceptable Use Policy** (Last Updated: July 8, 2025) | 본문 없음. "The AUP is available at the following Salesforce link, as Slack is a Salesforce company" → Salesforce AUP로 위임 | https://slack.com/acceptable-use-policy |
| T7 | **Main Services Agreement** (Last Updated: April 25, 2023) | 본문 없음. "The Main Services Agreement is available at the following Salesforce link" + Slack Supplemental Terms 링크 | https://slack.com/main-services-agreement |
| T8 | **Slack Brand Terms of Service** (날짜 표기 없음, 마킹 문구 "Copyright 2023") | 도메인: "Don't register a domain containing the word "slack" or any variation thereof. Deliberate misspellings and transliterations are also not permitted" / 상표: "Do not apply for a trademark that includes the word "slack," our logo, or any other words or marks similar to our own" / 룩앤필: "please do not copy or imitate the look and feel of Slack products or sites. Doing so may create user confusion or imply the endorsement of Slack." / 트레이드 드레스: "Do not use or imitate the distinctive "look and feel" of Slack … including (but not limited to) the color combinations, graphics, sounds, icons, typefaces or other stylization" / 스크린샷: "Don't include screenshots in your product user interface" / API 이용 시: "you must avoid suggesting your service or application is produced or supported by Slack." | https://slack.com/terms-of-service/slack-brand |
| T9 | Brand Guidelines 페이지(실제 제목 "Media Kit") | 제3자 제품명 규칙 없음. Brand Center(`brand.slackhq.com`)는 404 | https://slack.com/brand-guidelines |

### 2-3. 데스크톱 앱 라이선스 (로컬 번들 + Apple 문서)

| ID | 내용 | 출처 |
|---|---|---|
| L1 | `/Applications/Slack.app` 4.51.180: `Contents/_MASReceipt/receipt`(4,849 B) 존재, `codesign` Authority = `Apple Mac OS Application Signing` / TeamIdentifier `BQR82RBBHL` → **Mac App Store 배포 빌드** | 로컬 읽기 전용 확인 |
| L2 | 번들 내 `Resources/LICENSE`(4.9 MB, 96,912줄)는 **제3자 OSS 고지 모음**(MIT·Apache 등)이고 Slack 자체 EULA는 없음. `Credits.rtf`는 "Notices & Acknowledgements" 제목만. `LICENSES.chromium.html`은 Chromium 고지 | 로컬 읽기 전용 확인 |
| L3 | **Apple Licensed Application End User License Agreement(표준 EULA)**: "Your license to each App is subject to your prior acceptance of either this Licensed Application End User License Agreement ("Standard EULA"), or a custom end user license agreement between you and the Application Provider ("Custom EULA"), if one is provided." / a. Scope of License: "You may not copy (except as permitted by this license and the Usage Rules), reverse-engineer, disassemble, attempt to derive the source code of, modify, or create derivative works of the Licensed Application, any updates, or any part thereof (except as and only to the extent that any foregoing restriction is prohibited by applicable law or to the extent as may be permitted by the licensing terms governing use of any open-sourced components included with the Licensed Application)." | https://www.apple.com/legal/internet-services/itunes/dev/stdeula/ |
| L4 | 번들 `Resources/`에 알림·통화 사운드 mp3 다수(`animal_stick.mp3`, `boop.mp3`, `calls_*_v2.mp3` 등)와 `electron.icns` → 모두 Slack 저작물. 재사용 금지 대상 | 로컬 `ls` 확인 |

### 2-4. REA 기존 증거 (브리프 0번 재인용)

| ID | 내용 |
|---|---|
| E1 | `inspect_electron_fuses` (ev_d4bb9636…): RunAsNode·NODE_OPTIONS·`--inspect` disabled, ASAR 무결성·OnlyLoadAppFromAsar·CookieEncryption enabled |
| E2 | `analyze_javascript_application` on `app-arm64.asar` (ev_f49e0e82…/ev_70bb0ffb…): 첫 화면 `https://app.slack.com/ssb/first`, 창 3종, IPC 52건, 네이티브 모듈 8종, `slack://` 딥링크, contextIsolation·sandbox on |
| E3 | 웹앱 코드는 Service Worker 캐시(~493MB), `recover_javascript_sources`는 Linux x64 전용 |

## 3. 사실 / 추정 / 확인 필요

**사실 (원문·로컬 확인)**
- T1–T9, L1–L4, R1–R4, E1–E3.
- Slack의 User Terms 자체에는 리버스 엔지니어링 금지 문장이 없고, AUP·MSA 본문은 Salesforce 문서로 위임되어 있습니다(T5–T7).
- 설치된 Slack은 App Store 빌드이고, 번들에 Slack 고유 EULA 파일은 없습니다(L1·L2).

**추정 (근거 있는 판단, 검증 안 됨)**
- A1. Slack이 App Store 리스팅에 커스텀 EULA를 올리지 않았다면 Apple 표준 EULA(L3)가 적용되며, 그 경우 ASAR 파싱·번들 분석도 "disassemble / derive the source code" 문구에 걸릴 수 있습니다. 법이 허용하는 범위(아래 A3)만 예외입니다.
- A2. Salesforce MSA·AUP에는 통상 "reverse engineer the Services", "access the Services to build a competitive product", "copy any features, functions or graphics" 류의 사용 제한이 있습니다. **원문을 가져오지 못했으므로(R2) 기억 기반 추정입니다.**
- A3. 한국 저작권법은 (가) 정당한 이용자가 프로그램의 기초를 이루는 아이디어·원리를 확인하기 위해 기능을 조사·연구·시험하는 행위(제101조의3 제1항 제6호)와 (나) 호환에 필요한 정보를 얻기 위한 프로그램코드역분석(제2조 제34호 정의, 제101조의4)을 허용하되, (나)는 호환 목적 외 이용과 "유사 프로그램 개발·제작·판매"에 쓰는 것을 금지하는 것으로 기억합니다. **원문 미획득(R3), 조문 번호·문구 확인 필요.** 적용되더라도 계약(EULA)상 금지의 효력과는 별개 쟁점입니다.
- A4. 방향 1의 실질 위험은 저작권이 아니라 상표·부정경쟁(트레이드 드레스)입니다. 공개 범위가 "개인·팀 내부"라면 위험은 낮고, "외부 공개·도메인·앱 스토어"라면 T8이 직접 적용됩니다.
- A5. 이미 수행한 REA 정적 분석은 (가)에 가깝고 외부 공개·상업 이용이 없으므로 실무상 위험은 낮다고 봅니다. 다만 "낮다"는 추정이며, 결과물을 외부에 공개하는 순간 성격이 바뀝니다.

**확인 필요 (영환님 또는 변호사)**
- C1. App Store의 Slack 리스팅에 **커스텀 EULA 링크가 있는지**(없으면 Apple 표준 EULA 적용). App Store 앱에서 Slack 페이지 하단 "라이선스 계약" 확인 — 1분.
- C2. Salesforce MSA "Use Restrictions"·AUP 원문(robots.txt로 자동 조회 금지 → 브라우저로 직접 열람). 특히 "competitive product" 문구 유무.
- C3. 한국 저작권법 제2조 제34호·제101조의3·제101조의4 현행 문구(law.go.kr 직접 열람).
- C4. 영환님의 Slack이 **회사 워크스페이스인지 개인 워크스페이스인지**, Customer(계약 당사자)가 누구인지. 방향 2·4의 승인 주체가 여기서 정해집니다.
- C5. ohmyslack의 **공개 범위**(개인 로컬 / 팀 내부 / 외부 공개). 4절의 규칙 강도가 이 답에 따라 달라집니다.

## 4. 클린룸 경계 — 볼 수 있는 것 / 쓸 수 없는 것

전통적 클린룸(명세 팀·구현 팀 분리)은 1인 개발에서 불가능합니다. 대신 **출처 기록 규칙**으로 대체하는 것을 권합니다. P0에서 `CLEANROOM.md`로 고정하십시오(D의 P0와 동일 산출물).

### 4-1. 볼 수 있고 참고해도 되는 것
1. **공개 문서**: Slack Help Center·API 문서·블로그(robots 허용 경로). 개념(채널·스레드·unread·멘션)과 동작 설명은 아이디어 영역입니다.
2. **일반 사용자로서의 UX 관찰**: "스레드 패널이 오른쪽에 열린다", "unread는 채널·스레드가 분리된다" 같은 **동작 수준** 관찰. 메모는 글로 남기고 스크린샷은 참고용 개인 보관만(제품 UI·저장소·문서에 넣지 않음, T8).
3. **Electron 공개 보안 문서**: contextIsolation·sandbox·fuse 잠금은 Electron 공식 체크리스트에 있는 공개 지식입니다. REA 결과(E1·E2)와 같은 내용이면 **인용 출처를 Electron 문서로** 바꿔 적습니다.
4. **공식 데이터 export**: Customer가 정당하게 받은 자기 워크스페이스 export 파일(P4 ① 전용).

### 4-2. 보거나 쓰면 안 되는 것
1. Slack 웹앱 소스(Service Worker 캐시), ASAR 내부 코드의 **복사·이식·변형**. 이미 파싱한 REA 결과도 "구조 요약"까지만, 코드 조각은 저장소에 넣지 않습니다.
2. 번들 에셋 전부: 사운드 mp3(L4), 아이콘(`electron.icns`), 이모지 이미지, 폰트(Slack 전용 서체 포함), 로고·옥토소프(#) 심볼, 시그니처 색 조합(자주색 사이드바 계열). T8 트레이드 드레스 조항이 "color combinations, graphics, sounds, icons, typefaces"를 명시합니다.
3. **픽셀 단위 UI 복제**·Slack 스크린샷을 제품 UI에 포함(T8 "Don't include screenshots in your product user interface").
4. Slack 이름·변형을 **도메인·상표 출원·외부 제품명**에 사용(T8). 내부 코드명은 허용 범위로 봅니다(추정 A4).
5. 로그인된 실제 워크스페이스 데이터 조회·추출, 사용자 토큰(xoxp)으로의 대량 수집(브리프 4번, T3, D의 do-not-do 7번).
6. 실행 중 Slack에 디버거·Frida 연결, Slack.app 수정·재서명(브리프 4번, L3).

### 4-3. 기록 규칙 (CLEANROOM.md 최소 항목)
1. 기능별 "참고한 공개 출처 URL" 1줄 이상.
2. "Slack 번들·웹앱 코드에서 복사한 코드·에셋 없음" 선언과 검증 방법(저장소 전체에서 Slack 사운드 파일명·`tinyspeck` 문자열 grep 0건).
3. UI 디자인 토큰(색·폰트·아이콘 세트)은 **Slack과 다른 출처**(오픈 폰트·오픈 아이콘 세트)에서 가져왔음을 명시.
4. 이름 결정 기록(4-2-4).

## 5. REA — 더 얻을 수 있는 것 / 없는 것 / 추가 정적 분석 후보

### 5-1. 없는 것 (Slack.app 대상)
- **채팅 제품 동작**: UI는 원격 웹앱(E2), 코드는 SW 캐시(E3) → 복원 금지 대상이자 Linux 전용 도구. REA로 얻을 수 없고 얻어도 쓸 수 없습니다.
- **서버 프로토콜·데이터 모델**: 네트워크 관찰은 런타임 접근(E1로 차단) + 로그인 데이터 조회 금지. 공개 API 문서가 유일한 합법 출처이며, 그것조차 방향 1에서는 참고 가치가 낮습니다.
- **런타임 관찰 일체**: fuse로 Inspector 차단(E1). Frida 등은 L3·브리프 4번으로 금지.

### 5-2. 이미 얻은 것의 재사용 한도
- Electron 셸 보안 기본값·창 구성·딥링크·트레이 패턴(E1·E2) → P3에서 "체크리스트"로만 사용. **Electron 공식 문서로 출처를 대체**해 REA 의존을 끊는 것을 권합니다(4-1-3). 이로써 "REA로 분석해서 구현"이라는 서술 자체를 산출물에서 지울 수 있습니다.

### 5-3. 추가로 해볼 가치가 있는 정적 분석 (최대 3건) — 모두 **Slack.app이 아닌 우리 산출물** 대상
1. **P3 패키징 검증**: 우리 Electron 앱의 패키지에 `inspect_electron_fuses`를 돌려 E1과 같은 잠금 상태(RunAsNode off·ASAR 무결성 on 등)인지 확인. D의 P3 완료 기준과 동일.
2. **P3 번들 감사**: 우리 앱의 asar에 `analyze_javascript_application`(`detail: "summary"`)으로 IPC 채널·contextBridge 노출 면을 열거하고, 최소 권한 원칙(webviewTag off, nodeIntegration off) 위반이 없는지 확인. 또한 `search_strings`로 `tinyspeck`·`slack`·Slack 사운드 파일명이 0건인지 확인(4-3-2 클린룸 검증 자동화).
3. **(선택) Slack.app 대상 1건, 메타데이터만**: `inspect_plist`로 `Info.plist`의 URL 스킴·엔타이틀먼트·최소 OS를 읽어 P3 패키징 요구사항(샌드박스·알림 권한) 목록을 만드는 것. 코드가 아닌 선언 메타데이터라 L3 위험이 가장 낮지만, **C1 결과가 "표준 EULA 적용"이면 이것도 생략**을 권합니다. 같은 정보는 Apple 개발자 문서로 대체 가능합니다.

Slack.app을 대상으로 한 추가 코드 분석(preload 번들 관계 그래프 보완, 네이티브 모듈 `.node` 디스어셈블, 로컬 SQLite 열람)은 **권하지 않습니다**. 각각 L3 계약 위험, 제품 기여 없음, 로그인 데이터 조회 금지에 해당합니다.

## 6. 동료 파일과의 교차 코멘트 (1회)

- **D(Claude-Opus) 방향 2 점수 2 → A는 1**: D는 레이트리밋·관리자 승인을 근거로 2점을 줬습니다. A는 T1(C)·T4 "replicate or compete" 조항이 내부 사용에도 예외를 두지 않는다는 점에서 1점입니다. D의 "회사 워크스페이스 + 관리자 승인 + 내부 앱이면 성립"은 레이트리밋 조건으로는 맞지만, 약관 조항은 그 조건으로 해소되지 않습니다. **결론(방향 1 추천, 브리지는 P4 export 가져오기로 축소)은 일치**합니다.
- **D 결정 항목 3번(이름)**: A 판정은 "내부 코드명 유지 가능, 공개 전 개명 필수"(T8 도메인·상표 조항). 위험 순위는 D와 같이 방향 → 배포 범위 → 이름 순이 맞습니다.
- **B(GPT-Sol)·C(GPT-Luna)**: 범위·아키텍처는 A의 판정과 충돌 없음. B의 "제품 UI는 독자 UI로 구현"은 4-2-2·4-2-3와 같은 방향입니다. C의 Redis 제외는 A 범위 밖입니다.

## 7. 영환님 결정 후보 (위험 순)

1. **방향 확정**: 1 단독 권고. 2는 약관상 비권고. 4는 "공식 export 1회 가져오기"로 축소한 변형만 P4 후보로 남길지 결정.
2. **공개 범위**(C5): 개인 로컬 / 팀 내부 / 외부 공개. 외부 공개면 3·4번이 필수가 됩니다.
3. **이름**: "ohmyslack"을 내부 코드명으로만 쓰고 공개 전 개명 — 승인 여부. 도메인·상표 출원은 어떤 경우에도 "slack" 포함 불가(T8).
4. **REA 종료 선언**: Slack.app 대상 추가 분석 중단, 기존 결과는 내부 메모로만 보관, Electron 패턴 출처는 공식 문서로 대체 — 승인 여부. 5-3-3(Info.plist)만 예외로 할지는 C1 결과 뒤에 결정.
5. **확인 작업 배정**(C1–C3): App Store 라이선스 필드(1분), Salesforce MSA/AUP 원문(브라우저 직접, 10분), 저작권법 조문(5분)을 영환님이 직접 열람하실지, 변호사 검토로 넘기실지.
6. **CLEANROOM.md 채택**: 4-3 최소 항목을 P0 산출물로 채택할지.

## 8. 작업 로그 (검증 상태)

- 읽음: `BUZZ_BRIEF.md`, `REQUEST_BODY.txt`, `buzz/Claude-Opus.md`, `buzz/GPT-Sol.md`. (`buzz/GPT-Luna.md`는 스레드 요약만 확인.)
- 원문 확보: Slack API Terms·Developer Policy·User Terms·AUP(위임 페이지)·MSA(위임 페이지)·Brand Terms·Media Kit, Apple 표준 EULA — 전부 HTTP 200.
- 미확보: Salesforce MSA/AUP PDF(robots Disallow), 한국 저작권법 본문(JS 렌더·혼잡 오류), App Store 리스팅 EULA 필드, Slack Supplemental Terms, Slack Brand Center(404).
- 로컬 확인: `/Applications/Slack.app` 서명·영수증·`Resources/` 목록·`LICENSE` 머리 60줄만 읽음. 쓰기·실행·디버거 연결 없음.
- 하지 않은 것: Slack 웹앱 소스 접근, 워크스페이스 데이터 조회, REA 추가 실행, Git 작업, 다른 경로 쓰기.
