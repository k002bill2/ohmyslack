# 디자인 레퍼런스 — ohmyslack (내부 코드명) v1.0

- 상태: **R3 최종안** / 작성자: Claude-Fable (pubkey `2f4fc939…`) / 작성일: 2026-11-07 / 최종 채택: 영환님
- 입력: `docs/00-research/BUZZ_ROUND3_FINAL.md`(§1–3), `docs/00-research/BUZZ_ROUND2_DOCS.md`(0절 확정 결정), `CLEANROOM.md`, `docs/02-prd/PRD.md`(GPT-Sol **R3 v1.2**), `docs/03-trd/TRD.md`(GPT-Luna **R3**), `docs/04-dev-design/DEV_DESIGN.md`(Claude-Opus **R3**), R2 리뷰 `docs/06-reviews/{GPT-Sol,GPT-Luna,Claude-Opus}.md`의 디자인 항목, `docs/00-research/buzz/Claude-Fable.md`(1차 A, T8 트레이드 드레스 조항)
- 역할: 이 문서는 **디자인 토큰·브레이크포인트·레이아웃 폭·컴포넌트명·상태 문구·키맵·IME 규칙의 정본**입니다(R3 브리프 §2). CLEANROOM.md 4-2가 "디자인 토큰은 이 문서의 오픈 출처만 쓴다"고 지정합니다. 개발설계서 W-04(Designer)·W-04b(독자 에셋)는 이 문서를 화면·컴포넌트 명세와 에셋 목록으로 바꿉니다.
- 정본 인용 규칙: FR ID·수용 기준은 PRD, 테이블·API·WS 이벤트·커서·상태 코드·수치는 TRD, 저장소 구조·테스트 파일명·게이트는 개발설계서를 인용하고 이 문서가 값을 새로 정하지 않습니다. 의견 차이는 `⚖️ 미정합`으로 §13에 남깁니다(교차 수정 없음).
- 범위 준수: 코드·설치·Git·DB 접속·`.env` 열람·shared-infra 수정 없음. Slack 웹앱·Slack.app·스크린샷 미참조. 외부 조회는 R3에서 OFL 1.1 원문 1건만 추가 확인했습니다(§15).

---

## 1. 결론 (요약)

1. **독자 디자인이며 Slack을 참조하지 않습니다.** 금지 대상은 Slack Brand Terms가 트레이드 드레스로 명시한 "color combinations, graphics, sounds, icons, typefaces"와 룩앤필 모방입니다(1차 A T8). "무엇을 안 쓰는가"를 **기계 검증 가능한 규칙**(§2-3, 개발설계서 `check:design-tokens`)으로 두었습니다.
2. **토큰은 전부 오픈 라이선스 출처로 고정합니다.** 폰트 Pretendard·Noto Sans KR·JetBrains Mono(SIL OFL 1.1), 아이콘 Lucide(ISC), 색 Radix Colors(MIT) 12단계, 브레이크포인트 기준값 640·1024px. **기본값은 neutral `slate` + accent `teal`** 이며 영환님이 §14-1에서 바꾸면 토큰 값만 바뀝니다.
3. **레이아웃 3구간은 빈틈 없이 연속입니다:** compact `width ≤ 640px` 1단 / medium `640px < width < 1024px` 2단 / wide `width ≥ 1024px` 3단. wide에서 스레드가 열리고 뷰포트가 **1120px 미만이면 사이드바 접힘(72px)이 필수**이고 스레드 폭은 `clamp(320px, 32vw, 380px)`라 1024px에서도 가로 넘침이 0입니다(§5).
4. **컴포넌트 25개를 상태 매트릭스로 정의했습니다**(§6). 메시지 전송 상태는 **전송 중 / 저장 확인 / 저장 여부 확인 중 / 실패 / 수정됨 / 삭제 자리표시자** 6종이며, 판정은 **HTTP 응답 결과로만** 합니다. WS 재연결 중이라는 이유로 실패로 그리지 않고, 연결이 끊겨도 이미 저장 확인된 메시지는 되돌리지 않습니다(FR-MSG-02 v1.2). 상태는 **투명도가 아닌 텍스트+아이콘+`--text-muted`(4.5:1 보장)** 로 표현합니다.
5. **다크 모드는 MVP에 포함하고 OS `prefers-color-scheme`을 자동 추종합니다**(수동 토글은 P1). Radix 라이트/다크 쌍 스케일을 같은 토큰 이름에 매핑하므로 토큰 비용이 작고, 대비 린트는 두 스킴을 모두 검사합니다(§3-3·§7-5).
6. **접근성 목표는 WCAG 2.2 AA**, **한글 IME는 "조합 보호 → 멘션 선택 → 줄바꿈 → 전송" 우선순위**로 처리하고 `compositionend` 직후 확정 Enter는 **다음 `keyup` 또는 100ms 중 먼저 오는 시점까지만** 무시합니다(§7-4). 그 뒤의 독립 Enter는 버리지 않습니다.
7. **초대 링크의 토큰은 URL 경로가 아니라 프래그먼트**(`/invite#t=<token>`)에 둡니다. 프래그먼트는 HTTP 요청·Referer·서버 로그에 실리지 않으며, 페이지가 읽어 `POST /api/invites/accept` 본문으로 보낸 뒤 즉시 지웁니다(§4-2, TRD §5 "토큰은 URL·로그에 두지 않음").
8. **PWA 아이콘 세트**(`any` 192/512·`maskable` 512·`monochrome`·`apple-touch-icon` 180·favicon)는 TRD §6이 이 문서 §9-2를 정본으로 인용해 정합이 끝났습니다.

영환님 결정 후보는 §14에 5건(기본값 적용 상태로 진행 가능)입니다.

---

## 2. 클린룸 디자인 원칙

### 2-1. 원칙 5개

| # | 원칙 | 이유 |
|---|---|---|
| D1 | **참조 금지:** Slack(및 다른 상용 메신저)의 스크린샷·녹화·색상 추출·아이콘 트레이싱을 디자인 과정에 쓰지 않습니다. 참고는 "동작 수준의 일반 관념"(CLEANROOM 2-2)까지입니다. | T8 룩앤필·스크린샷 금지 |
| D2 | **출처 있는 토큰만:** 색·폰트·아이콘·사운드는 §3의 출처와 라이선스가 적힌 것만 씁니다. 토큰 모듈의 각 항목에 `source`·`license` 필드를 둡니다. | CLEANROOM 4-2 |
| D3 | **상태는 텍스트로:** 전송·연결·오류 상태는 색만으로 구분하지 않고 텍스트 또는 아이콘+접근 가능한 이름을 함께 둡니다. 투명도 낮추기로 상태를 표현하지 않습니다. | FR-CLIENT-07, WCAG 1.4.1·1.4.3 |
| D4 | **서버가 진실:** UI는 서버가 확정(HTTP 응답의 `seq`·`change_id`)하기 전 상태를 "성공"으로 그리지 않습니다. 낙관적 렌더는 "전송 중"으로만 표시하고, 판정은 HTTP 결과로만 합니다. WS는 알림 경로일 뿐입니다. | FR-MSG-02, PRD 원칙 2, TRD §1 |
| D5 | **기본값은 시스템:** 이모지·스크롤바·폼 컨트롤·색 구성표(라이트/다크)·모션 축소는 OS 설정을 따릅니다. 독자 에셋을 늘리지 않아 클린룸 검증 면을 줄입니다. | 범위 통제 |

### 2-2. 쓰지 않는 것 (트레이드 드레스 회피 목록)

| 영역 | 피하는 것 | 우리 선택 |
|---|---|---|
| 색 | 짙은 자주·포도색 계열(색상 280–330°, 저명도·고채도)을 **사이드바 전면 배경**으로 쓰는 조합. 밝은 본문 + 짙은 유채색 사이드바 구조 자체 | 사이드바와 본문을 **같은 중성 스케일**의 단계 차이(Radix step 2 vs step 1)로 구분. 액센트는 면이 아니라 선·텍스트·배지에만 |
| 아이콘·로고 | `#`(옥토소프)·네모 안의 `#`·말풍선·격자·4색 바람개비 류의 심볼 로고 | 기하 심볼 독자 제작(§9-1). 채널 표시는 Lucide `hash` **아이콘을 UI 글리프**로만 쓰고 로고에는 쓰지 않음 |
| 폰트 | Slack 전용 서체 및 그와 유사한 라운드 그로테스크 조합 | Pretendard(본문)·JetBrains Mono(코드) |
| 사운드 | 모든 알림·전송·호출 사운드 파일 | **MVP 사운드 없음.** v1 이후 Web Audio로 자체 합성하거나 CC0 출처만 |
| 이모지 | 타사 이모지 이미지 세트 동봉 | 시스템 네이티브 이모지(폰트 미동봉). v1 후보: Noto Color Emoji(OFL)·Fluent UI Emoji(MIT) |
| 레이아웃 디테일 | 사이드바 섹션명·단축키 안내 문구·툴팁 문구를 특정 제품과 같은 표현으로 | 우리 용어(§4-3) |
| 문구·명칭 | "slack"이 들어간 앱 이름·manifest `name`·`short_name`·도메인 | 승인된 배포 이름(TRD §6, 공개 전 개명 ADR). 그 전까지 임시 중립 이름 |

### 2-3. 기계 검증 (개발설계서 `check:design-tokens` + QA-FR-OPS-04)

개발설계서 5-1은 `check:design-tokens`를 "토큰 모듈의 출처·라이선스 필드와 §2-3 색 금지 규칙·§7-1 대비 기준 계산"으로 정의했습니다(`DEV_DESIGN.md:193`). 아래가 그 규칙 정본입니다.

1. 토큰 모듈(`apps/web/src/ui/`, 개발설계서 2-1)의 모든 색·폰트·아이콘 항목에 `source`·`license`가 있고 값이 §3-1 표의 URL과 일치한다.
2. **에셋 경로 규칙(출처 종류별 분리):**
   - 배포 이미지(독자 제작): `apps/web/public/icons/**` 와 `apps/web/public/favicon.ico`(브라우저 기본 요청 경로 예외 1개)만.
   - 라이선스 에셋(폰트): `apps/web/public/fonts/**` 의 `*.woff2` + 같은 폴더의 `OFL.txt`/`LICENSE`(§3-1 Pretendard 행).
   - 패키지 에셋: `node_modules/**`.
   - 문서·QA 증거(스크린샷·시안): `docs/**`, `qa/manual/**` 에만 두고, 각 파일은 PR 본문 또는 같은 폴더 `SOURCES.md`에 "참고 출처: 일반 관념 / <공개 문서 URL> / 독자 제작" 한 줄을 가진다(CLEANROOM 4-1). 경로 통과가 출처 검토를 대체하지 않는다.
   - 오디오(`*.mp3|wav|ogg`)는 저장소 어디에도 없다(MVP).
   - 위 밖의 `*.png|jpg|svg|ico|webp|woff|woff2|mp3|wav|ogg`는 실패.
3. 토큰에 쓰인 색상 중 **색상 280–330°, 명도 ≤ 35%, 채도 ≥ 40%** 인 값이 `surface`(면) 역할 토큰에 없다. **라이트·다크 두 스킴 모두** 검사한다.
4. 대비: 텍스트 역할 토큰은 대응 배경에서 4.5:1 이상, 비텍스트(보더·포커스 링·아이콘)는 3:1 이상 — 두 스킴 모두(§7-1).
5. `manifest.webmanifest`의 `name`·`short_name`에 `slack` 부분 문자열이 없다(대소문자 무시).
6. 디자인 산출물(Figma·이미지)이 저장소에 들어오면 PR 본문에 출처 한 줄이 있다(2항과 동일 규칙, 수동 QA-FR-OPS-04가 확인).

---

## 3. 오픈 출처 디자인 토큰과 라이선스

### 3-1. 출처·라이선스 표 (R1 2026-11-07 LICENSE 원문 확인 + R3 OFL 1.1 원문 재확인)

| 토큰 영역 | 선택 | 라이선스 | 확인한 원문 | 비고 |
|---|---|---|---|---|
| 본문 폰트(1차) | **Pretendard** | SIL OFL 1.1, Reserved Font Name "Pretendard" | `raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE` 14·20행; OFL 1.1 전문 `openfontlicense.org/open-font-license-official-text/`(R3 재확인) | **MVP 규칙:** 프로젝트가 배포한 **웹 빌드 파일을 수정 없이** 자체 호스팅(`apps/web/public/fonts/`), 같은 폴더에 저작권 고지+OFL 전문 동봉(OFL §2), 사용한 **릴리스 버전·커밋**을 `SOURCES.md`에 기록. **자체 서브셋은 OFL 정의상 Modified Version**("deleting … in part", "changing formats")이라 §3에 따라 사용자에게 보이는 기본 폰트 이름에 "Pretendard"를 쓸 수 없음 → 자체 서브셋이 필요해지면 폰트 이름 변경(예: 내부명) 또는 저작권자 서면 허락 중 하나를 ADR로 결정. R1의 "서브셋 파일명에 Pretendard 유지" 서술은 **철회** |
| 본문 폰트(폴백) | **Noto Sans KR** (Noto Sans CJK) | SIL OFL 1.1 | `raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE` | 로컬 미설치 시 시스템 폰트로 폴백. 파일 동봉 안 함(MVP) |
| 코드 폰트 | **JetBrains Mono** | SIL OFL 1.1 | `raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt` | 코드 블록·식별자 표시용. 한글은 본문 폰트로 폴백. 동봉 시 Pretendard와 같은 규칙(수정 없는 배포 파일 + 고지) |
| 아이콘(1차) | **Lucide** | ISC | `raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE`, `lucide.dev/license` | §3-4 이름 사용. 세트 혼용은 화면당 1개 |
| 아이콘(대안) | Phosphor Icons / Tabler Icons | MIT / MIT | `phosphor-icons/core/main/LICENSE`, `tabler/tabler-icons/main/LICENSE` | Lucide에 없는 글리프가 필요할 때만 |
| 색 체계 | **Radix Colors** | MIT | `raw.githubusercontent.com/radix-ui/colors/main/LICENSE` | 12단계 스케일, 라이트/다크 쌍(§3-3) |
| 색 체계(대안) | Open Color / Tailwind 색 팔레트 | MIT / MIT | `yeun/open-color/master/LICENSE`, `tailwindlabs/tailwindcss/main/LICENSE` | Radix로 부족할 때만 |
| 브레이크포인트 기준값 | 640px·1024px (Tailwind 문서 `sm 40rem`·`lg 64rem`의 **숫자만** 차용) | 공개 기술 문서 | `tailwindcss.com/docs/responsive-design` | **의미는 다릅니다:** Tailwind `sm`은 640px **이상**에 적용되고, 이 문서의 compact는 640px **이하**입니다(§5-1). 프레임워크 채택을 뜻하지 않음 |
| 이모지 | 시스템 네이티브(MVP) | — | — | v1 후보: Noto Color Emoji(OFL 1.1), Fluent UI Emoji(MIT), Twemoji(그래픽 CC BY 4.0 → 표기 의무, 비권장) |
| 사운드 | 없음(MVP) | — | — | v1: Web Audio 합성(자체 저작) 또는 CC0 |
| 접근성 기준 | WCAG 2.2 | W3C 문서 | `w3.org/TR/WCAG22/` | AA 목표(§7) |

### 3-2. 타이포그래피 토큰

```css
:root {
  --font-sans: "Pretendard Variable", Pretendard, "Noto Sans KR",
               -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-xs: 0.75rem;   /* 12px 캡션·타임스탬프 */
  --text-sm: 0.8125rem; /* 13px 메타(작성자 옆 시간, 배지) */
  --text-md: 0.9375rem; /* 15px 메시지 본문 기본 */
  --text-lg: 1.0625rem; /* 17px 대화 제목 */
  --text-xl: 1.25rem;   /* 20px 화면 제목(로그인·설정) */
  --leading-body: 1.55; /* 한글 본문 */
  --leading-tight: 1.3;
}
```

- 모든 크기는 `rem`. 200% 확대(FR-CLIENT-07)에서 레이아웃이 깨지지 않도록 고정 `px` 높이 금지(아이콘·보더 제외). 200% 확대는 CSS px 뷰포트를 절반으로 줄이므로 **브레이크포인트가 한 단계 내려가는 것이 정상 동작**입니다(1440px 창 → 720 CSS px → medium).
- 한글 줄바꿈: 본문 `word-break: keep-all; overflow-wrap: anywhere;`
- 숫자(배지·시간)는 `font-variant-numeric: tabular-nums`.
- 폰트 파일은 `apps/web/public/fonts/`에 자체 호스팅(tailnet 전용이라 외부 CDN 호출은 공인 인터넷 의존을 만듭니다). `font-display: swap`. 파일 규칙은 §3-1 Pretendard 행.

### 3-3. 색 토큰 — Radix Colors 12단계 역할 매핑

Radix 문서 기준 단계 용도: **1–2 앱 배경, 3–5 컴포넌트 배경(기본·hover·active), 6–8 보더, 9–10 솔리드(채움), 11–12 텍스트.** 라이트/다크는 같은 단계 번호로 자동 대응합니다.

| 역할 토큰 | 스케일·단계 | 용도 |
|---|---|---|
| `--bg-app` | neutral 1 | 본문 배경 |
| `--bg-sidebar` | neutral 2 | 사이드바·스레드 패널 배경(**유채색 금지**, §2-2) |
| `--bg-elevated` | neutral 3 | 입력창·카드·팝오버 |
| `--bg-hover` / `--bg-active` | neutral 4 / 5 | 목록 항목 hover·선택 |
| `--border-subtle` / `--border` | neutral 6 / 7 | 구분선 / 입력 테두리 |
| `--text-muted` / `--text` | neutral 11 / 12 | 메타·**상태 라벨(전송 중 등)** / 본문 |
| `--accent-solid` | accent 9 | 전송 버튼·선택 항목 표시선·링크 밑줄 |
| `--accent-text` | accent 11 | 링크·멘션 텍스트 |
| `--accent-bg` | accent 3 | 자기 멘션 하이라이트 배경 |
| `--success-text` | green 11 | "저장됨"(표시할 때만) |
| `--warning-bg` / `--warning-text` | amber 3 / 11 | 재연결 중 배너 |
| `--danger-text` / `--danger-solid` | red 11 / 9 | 전송 실패·연결 끊김·삭제 확인 |
| `--focus-ring` | accent 8 | 2px 포커스 링(WCAG 2.4.7) |

- **기본값(R3 확정, 영환님 번복 가능 §14-1):** neutral = `slate`, accent = `teal`. 대안 `sand` / `jade`·`indigo`. **배제:** `purple`·`plum`·`violet`을 면 배경으로(§2-2).
- 대비: Radix 문서는 step 11·12 텍스트가 step 1–2 배경에서 AA를 만족하도록 설계되었다고 설명합니다(설계 의도). 우리 조합은 `check:design-tokens`가 두 스킴에서 실측합니다(WCAG 1.4.3 4.5:1, 1.4.11 3:1).
- **다크 모드(R3 확정):** MVP 포함. `@media (prefers-color-scheme: dark)`로 같은 토큰 이름에 Radix dark 스케일을 매핑합니다. 수동 토글·저장은 P1. QA 체크리스트(§11)는 두 스킴을 모두 돌립니다. 본문 메시지는 어느 스킴에서도 투명도 처리하지 않습니다(D3).

### 3-4. 아이콘 토큰 (Lucide, 24px 그리드, 스트로크 1.75–2)

| UI 의미 | Lucide 이름 | 확인 |
|---|---|---|
| 공개 채널 | `hash` | ✅ raw SVG 200 |
| 1:1 DM | `message-square` 또는 `user` | ✅ |
| 비공개(P1) | `lock` | ✅ |
| 멘션 | `at-sign` | ✅ |
| 전송 | `send` | ✅ |
| 스레드로 답글 | `reply` / `corner-up-left` | ✅ |
| 닫기 / 뒤로 | `x` / `chevron-left` | ✅ |
| 전송 중 / 저장 여부 확인 중 | `clock` / `help-circle` 계열 | ✅ / ⚠️ 이름 빌드 시 확정 |
| 저장 확인(선택적) | `check` | ✅ |
| 재연결 중 | `refresh-cw` | ✅ |
| 오프라인 | `wifi-off` | ✅ |
| 수정 / 삭제 | `pencil` / `trash` | ✅ (`trash-2`는 raw 경로 404 → `trash` 사용) |
| 더보기 | `ellipsis` | ✅ |
| 검색(P1)·설정·로그아웃·추가·참여·나가기 | `search`·`settings`·`log-out`·`plus`·`log-in`·`door-open` 계열 | ✅ / ⚠️ `log-in`·`door-open`은 빌드 시 확인 |
| 멤버·관리자 | `users`·`shield` 계열 | ⚠️ 빌드 시 확인 |
| 기기(세션 목록, P1) | `smartphone` | ✅ |
| 오류·경고 | **확인 필요** — `circle-alert`·`alert-circle`·`triangle-alert` 모두 raw 경로 404. 빌드 시 패키지 내 실제 이름으로 확정 | ⚠️ |

- 아이콘은 **항상 접근 가능한 이름**을 동반합니다: 텍스트 라벨이 있으면 `aria-hidden="true"`, 아이콘 단독 버튼이면 `aria-label`.
- 모든 아이콘 버튼의 히트 영역은 44×44px(§7-1).

### 3-5. 간격·반경·그림자·모션

```css
:root {
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.25rem; --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --shadow-popover: 0 4px 16px rgb(0 0 0 / 0.12);
  --motion-fast: 120ms; --motion-base: 200ms;
}
@media (prefers-reduced-motion: reduce) {
  :root { --motion-fast: 0ms; --motion-base: 0ms; }
}
```

- 모션은 패널 열림·배너 등장에만. 메시지 도착 애니메이션 없음(가독성·배터리).

---

## 4. 정보 구조 (IA)

### 4-1. 개체 계층 (PRD §7-7·TRD §2 정본 인용)

```
워크스페이스(1개, 화면에 노출 안 함)
└─ 공간(space) ─ 채널(공개) | 1:1 DM          ← TRD conversations.kind
   └─ 메시지(원문, seq 순)                      ← TRD messages, thread_root_id IS NULL
      └─ 스레드(1단 답글)                       ← thread_root_id = 원문 id
멘션: 메시지 → 나(mention_user_ids, 읽으면 해제)  ← TRD §4 mention_user_ids
읽음 커서: 대화 본문 1개 + 스레드별 1개(서버 저장, 계정 단위) ← TRD conversation_read_state / thread_read_state
스레드 unread 대상: 내가 원문·답글을 쓰거나 멘션받은 스레드만   ← PRD §7-7, TRD thread_unread_targets
```

- 본문 unread는 **원문만**, 스레드 unread는 **대상 스레드의 답글만** 세고 두 수를 합산하지 않습니다(PRD §7-7). 사이드바 표시 규칙은 §6-2 CMP-03·04, 데이터원은 `GET /api/conversations`(TRD §3:99).

### 4-2. 라우트 (R3 확정 — 클라이언트 라우트는 이 문서 정본, API 경로는 TRD §3 인용)

| 화면 | 경로 | 비고 |
|---|---|---|
| 루트 | `/` | compact: 공간 목록 화면. medium/wide: 마지막 열었던 공간으로 `replace`, 없으면 빈 본문 + 사이드바 |
| 로그인 | `/login` | 세션 없거나 401이면 모든 경로가 여기로. 원래 경로는 `?next=`에 **경로만**(프래그먼트·토큰 제외) |
| 초대 수락 | **`/invite#t=<token>`** | 토큰은 **프래그먼트**에만. 페이지 스크립트가 `location.hash`를 읽어 `POST /api/invites/accept` **본문**으로 보내고, 읽은 직후 `history.replaceState`로 해시를 지움. 토큰을 DOM·`localStorage`·로그·계측에 쓰지 않음. 초대 페이지 응답 헤더 `Referrer-Policy: no-referrer`. 프래그먼트는 HTTP 요청에 실리지 않는다는 서술은 일반 웹 지식(이 세션 MDN 재조회 안 함, §12 추정). 서버 측 토큰 규칙은 TRD §5 정본 |
| 공간 본문 | `/c/:conversationId` | 채널·DM 공통. 라우트 변수 `conversationId` ↔ API `conversation_id`는 **표기 변환 경계**(camel↔snake)만 있고 값은 같은 UUID |
| 스레드 | `/c/:conversationId?thread=:rootMessageId` | wide: 패널, medium: 오버레이, compact: 별도 화면. **URL이 상태**라 새로고침·공유·뒤로가기가 일관. 직접 열었을 때(히스토리 없음) 뒤로 버튼은 `/c/:conversationId`로 `replace` |
| 미읽음 점프 | `/c/:conversationId#m-:seq` | 새 메시지 구분선 위치 |
| 채널 찾기·참여 | `/discover` (compact 화면) / 다이얼로그 (medium·wide) | `GET /api/conversations/discover`, `POST /api/conversations/{id}/join`(TRD §3) |
| DM 시작 | `/dm/new` (compact) / 다이얼로그 | `GET /api/members` → `POST /api/dms`(TRD §3). 같은 상대는 같은 DM으로 이동(FR-CONV-03) |
| 멤버 관리(관리자) | `/settings/members` | **P0**(FR-AUTH-01·03·05): 초대 링크 발급 `POST /api/invites`, 멤버 목록 `GET /api/members`, 비활성화 `POST /api/admin/members/{user_id}/deactivate`. 비관리자에게는 메뉴 미노출 + 직접 진입 시 "권한이 없습니다" 빈 상태(서버 403이 진실) |
| 설정 | `/settings` | P0 셸(내 계정·로그아웃·단축키 안내 링크·설치 안내 링크) |
| 세션 목록 | `/settings/sessions` | P1(FR-AUTH-04) |
| 설치 안내 | `/install` | FR-CLIENT-03 "설치 안내와 일반 웹 접근 제공" |

### 4-3. 용어 (UI 문구 정본, 한국어)

| 개념 | UI 문구 | 피하는 표현 |
|---|---|---|
| space | **공간**(목록 제목), 개별은 **채널** / **DM** | "워크스페이스" 노출 |
| thread | **스레드**, 답글 수 "↳ 답글 3"("↳"는 장식, 접근 이름 제외) | "댓글" |
| mention | **멘션**, 배지 "멘션 2" | "호출" |
| unread | **읽지 않음**(굵게), 구분선 "여기부터 새 메시지", 스레드 점 "새 답글" | "미확인" |
| 전송 상태 | **전송 중** / (저장 확인 시 표시 없음) / **저장 여부 확인 중 · 다시 시도** / **전송 실패 · 다시 시도** | "보냄", "성공", "저장되지 않았습니다"(단정) |
| 연결 상태 | **다시 연결 중…** / **연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요.** / **최신 상태 확인 중…** | "오프라인 모드", "보낸 메시지는 저장되지 않았습니다" |
| 수정·삭제 | "(수정됨)" / **삭제된 메시지입니다** | "메시지가 제거됨" |
| 참여·나가기 | **참여** / **채널 나가기** / 나간 채널 행: **나간 채널 · 다시 참여** | "탈퇴", "구독 해지" |
| 초대·비활성화 | **초대 링크 만들기**(만료 시각 표시) / **멤버 비활성화**(확인 다이얼로그: "이 멤버의 모든 기기가 5초 안에 로그아웃되며 다시 로그인할 수 없습니다") | "차단", "삭제" |
| 세션 종료(본인) | **세션이 종료되었습니다. 다시 로그인해 주세요.** (401 공통, 비활성화·만료·폐기 구분 없음 — TRD §3 401 "인증 또는 비활성 계정") | 원인 노출 문구 |

---

## 5. 레이아웃

### 5-1. 브레이크포인트 (R3 확정, 연속 구간)

| 이름 | 범위 | 단수 | 기준 |
|---|---|---|---|
| `compact` | **width ≤ 640px** | 1단 스택 | PRD FR-CLIENT-02의 "≤ 640px 1단"과 일치. 경계값 640px은 compact |
| `medium` | **640px < width < 1024px** | 2단 | iPad 세로·좁은 데스크톱 창·200% 확대 데스크톱 |
| `wide` | **width ≥ 1024px** | 3단 | 경계값 1024px은 wide |
| 최소 지원 폭 | 320px | — | FR-CLIENT-02 수용 기준 |

```css
/* Media Queries Level 4 범위 문법 — 구간 사이 소수 px 공백 없음 */
@media (width <= 640px)                 { /* compact */ }
@media (640px < width < 1024px)         { /* medium  */ }
@media (width >= 1024px)                { /* wide    */ }
```

- 범위 문법 미지원 브라우저 폴백은 `(max-width: 640px)` / `(min-width: 640.02px) and (max-width: 1023.98px)` / `(min-width: 1024px)`로, 소수 경계가 어느 구간에도 빠지지 않게 둡니다(0.02px 간격은 브라우저 반올림 한계 아래 — 추정, 지원 매트릭스는 ⚖️-4 결정 후 확인).
- 구간 상수는 토큰 모듈 1곳에만 두고(개발설계서 A5), `apps/web/test/layout/responsive.test.tsx`는 그 상수로 `matchMedia`를 구성해 **640 · 640.5 · 1023.5 · 1024 · 1119 · 1120px** 과 "스레드 열림" 조합을 검사합니다(`DEV_DESIGN.md:277`).

### 5-2. 3단 (wide ≥ 1024px)

```
┌─────────────┬──────────────────────────────┬────────────────┐
│ 사이드바     │ 본문                          │ 스레드 패널      │
│ 260px 고정   │ flex: 1 (min 480px)           │ clamp(320,32vw,380)│
│ (접힘 72px)  │                               │ (열릴 때만)      │
│ bg-sidebar  │ bg-app                        │ bg-sidebar      │
│             │ ┌ 대화 헤더 (56px) ───────────┐│ ┌ 스레드 헤더 ─┐ │
│ 공간 목록    │ │ 메시지 목록 (가상 스크롤)    ││ │ 원문          │ │
│ (채널/DM)   │ │  …                          ││ │ 답글 목록      │ │
│             │ │ 새 메시지 구분선             ││ │ 답글 작성기    │ │
│ 하단: 나/설정│ └ 작성기 (auto-grow ≤ 8줄) ──┘│ └──────────────┘ │
└─────────────┴──────────────────────────────┴────────────────┘
```

- 토큰: `--sidebar-w: 260px`, `--sidebar-w-collapsed: 72px`, `--thread-w: clamp(320px, 32vw, 380px)`, `--body-min: 480px`.
- **폭 규칙(R3 확정):** 스레드가 열린 상태에서 `width < 1120px`이면 사이드바를 **접힘(72px)으로 자동 전환합니다(필수).** 1120px 이상에서는 펼침 유지, 사용자가 수동으로 접을 수도 있습니다. 검산: 1024px → 72 + 624 + 328 = 1024, 본문 ≥ 480 ✓ / 1119px → 72 + 689 + 358 ✓ / 1120px → 260 + 502 + 358 ✓ / 1280px → 260 + 640 + 380 ✓. 1024–1119px에서 스레드가 닫히면 사이드바는 다시 펼쳐집니다. 접힘 상태의 사이드바는 아이콘+배지만 보이고 이름은 툴팁·`aria-label`로 제공합니다.
- 선택된 공간은 **왼쪽 3px 액센트 선 + bg-active**로 표시(면 전체 유채색 금지).

### 5-3. 2단 (medium, 640px < width < 1024px)

- 사이드바 260px + 본문(최소 380px). 스레드는 **본문 위에 오버레이 시트(오른쪽에서 슬라이드, 폭 `min(420px, 100%)`)** 로 열고, `Esc`·뒤로 버튼·바깥 클릭으로 닫습니다. 닫아도 스레드 작성기 초안은 보존됩니다(§7-3 초안 규칙).
- 오버레이가 열린 동안 본문은 `inert`(포커스 트랩, WCAG 2.1.2 준수용 Esc 탈출 제공). 오버레이 루트는 `role="dialog" aria-modal="true" aria-label="스레드"`.

### 5-4. 1단 (compact ≤ 640px)

```
[공간 목록] ──탭──▶ [본문 + 작성기] ──답글──▶ [스레드 + 답글 작성기]
      ◀── 뒤로(헤더 chevron-left / 브라우저 back) ──
```

- 각 단계는 **라우트**(§4-2)라 브라우저 뒤로가기·PWA 스와이프백이 그대로 동작합니다. 히스토리가 없는 직접 진입은 `replace`로 상위 화면에 갑니다.
- 본문 헤더: `[←] #채널명 [⋯]`. 작성기는 화면 하단 고정, `padding-bottom: env(safe-area-inset-bottom)`.
- 높이는 `100dvh`(미지원 시 `100vh` 폴백). 가상 키보드가 올라올 때 입력창·전송 버튼이 가려지지 않아야 함(FR-CLIENT-02) — `VisualViewport` `resize`로 작성기 위치 보정. `interactive-widget=resizes-content` 뷰포트 메타의 iOS Safari 지원은 **확인 필요**(§12).
- 가로 넘침 0: 모든 컨테이너 `min-width: 0`, 코드 블록은 `overflow-x: auto`.

---

## 6. 컴포넌트 목록과 상태

### 6-1. 공통 5상태 정의

| 상태 | 표시 규칙 |
|---|---|
| 기본 | 데이터 있음 |
| 로딩 | 스켈레톤(텍스트 줄 3개, `aria-busy="true"`). 스피너 단독 금지 |
| 빈 | 아이콘(Lucide, muted) + 1문장 + 가능하면 1개 행동 버튼 |
| 오류 | 경고 아이콘 + 원인 1문장 + **다시 시도** 버튼. `role="alert"`. **다시 시도가 가능한 오류**: 네트워크 오류·타임아웃·5xx·429(대기 후). **불가능한 오류**(버튼 대신 안내만): 400(입력 수정 필요), 401(로그인 화면으로), 403/404(권한 없음·대상 없음 — 목록 새로 고침 안내), 409(같은 ID·다른 내용 충돌 — "다시 작성" 안내, 새 `client_message_id`) |
| 오프라인 | 상위 ConnectionBanner가 표시. 컴포넌트는 쓰기 동작을 **비활성화하지 않고**, `navigator.onLine === false`일 때만 전송 시도를 즉시 "실패"로 기록합니다. WS만 끊긴 "다시 연결 중"에서는 HTTP 요청을 그대로 보내고 결과로 판정합니다(§6-3·§6-4) |

### 6-2. 컴포넌트 표 (위치 `apps/web/src/ui/`·`apps/web/src/features/**`, 개발설계서 2-1)

| ID | 컴포넌트 | 역할 | 고유 상태 | 관련 FR |
|---|---|---|---|---|
| CMP-01 | `AppShell` | 3/2/1단 그리드, 라우트 아웃렛, 포커스 관리, §5-2 접힘 규칙 | 브레이크포인트 3종 × 스레드 열림 | CLIENT-01·02 |
| CMP-02 | `Sidebar` | 공간 목록 컨테이너, 상단 "채널 찾기"·"DM 시작" 버튼, 하단 내 계정·설정 | 접힘(72px)/펼침 | CLIENT-01, CONV-02·03 |
| CMP-03 | `SpaceList` / `SpaceListItem` | 채널·DM 항목. **표시 규칙(R3 확정):** ① 이름 **굵게** = `unread_count > 0`(원문 unread만) ② 숫자 배지(CMP-04) = `mention_count`(0이면 없음) ③ 이름 뒤 작은 점 = `unread_thread_count > 0`(대상 스레드의 새 답글, 숫자 미표시, `aria-label="새 답글 있는 스레드 n개"`). 세 표시는 서로 독립이며 합산하지 않음(PRD §7-7). 데이터원: `GET /api/conversations` 항목 필드(TRD §3:99) | 선택됨 / 읽지 않음 / 멘션 n / 새 답글 / **나간 채널**(muted, "나간 채널 · 다시 참여" 버튼, 목록에는 유지 — FR-CONV-02) | SYNC-03·04·05, CONV-02 |
| CMP-04 | `UnreadBadge` | 숫자 배지 = **멘션 수만**. 99+ 상한 | 0이면 렌더 안 함. `aria-label="멘션 2개"` | MSG-07, SYNC-04 |
| CMP-05 | `ConversationHeader` | 공간 이름·멤버 수·뒤로(compact)·더보기 메뉴(**멤버 보기 / 채널 나가기** / 스레드 전체 보기 P1) | compact 뒤로 버튼 노출 / 나간 채널이면 메뉴에 "다시 참여"만 | CLIENT-02, CONV-02 |
| CMP-06 | `MessageList` | 가상 스크롤, 이전 페이지 로드(`roots_only=true`, TRD §3), 하단 고정 | 로딩(위쪽 스켈레톤) / 빈("첫 메시지를 남겨 보세요") / 더 불러오기 오류 / **나간 채널**("이 채널을 나갔습니다. 다시 참여하면 이력을 볼 수 있습니다" + 참여 버튼, 작성기 숨김) | MSG-04, CONV-02 |
| CMP-07 | `MessageItem` | 아바타(이니셜)·작성자·시간·본문·스레드 요약·액션 | **전송 중 / 저장 확인 / 저장 여부 확인 중 / 실패 / 수정됨 / 삭제 자리표시자 / 자기 멘션 하이라이트**(§6-3) | MSG-02·05·06·07 |
| CMP-08 | `MessageBody` | 텍스트·줄바꿈·안전 링크·코드 블록 렌더. HTML 미실행 | 자동 링크는 **`https`·`http`만**(TRD §5), 그 외 스킴은 일반 텍스트. 링크 `rel="noopener noreferrer"` | MSG-01 |
| CMP-09 | `NewMessagesDivider` | "여기부터 새 메시지" 선. 커서 위치에 1개 | 보이면 스크롤 앵커 | SYNC-03 |
| CMP-10 | `DateSeparator` | 날짜 구분(오늘/어제/YYYY-MM-DD) | — | — |
| CMP-11 | `Composer` | 멀티라인 입력, IME 안전 Enter(§7-4), 멘션 트리거 `@`, 전송 버튼, 글자 수(TRD 4,000 code point 기준, 3,800부터 카운터 표시) | 비어 있음(전송 비활성) / 입력 중 / 조합 중 / 상한 초과(전송 비활성 + "4,000자까지 입력할 수 있습니다") / **초안 보존**(대상별, §7-3) | MSG-01·03·08 |
| CMP-12 | `MentionPicker` | `@` 입력 시 참여자 콤보박스(APG combobox). 후보원: `GET /api/conversations/{id}/members`(TRD §3) | 결과 없음 / 선택됨 → `@이름` 칩 + `mention_user_ids`에 ID 추가 | MSG-07 |
| CMP-13 | `ThreadPanel` | 원문 + 답글 목록(`GET /api/messages/{root_id}/replies`) + 답글 작성기 | 원문 삭제됨(자리표시자 유지, 답글 열람 가능) / 로딩 / 빈("첫 답글") / medium `dialog` | MSG-06 |
| CMP-14 | `ThreadSummary` | 원문 아래 "↳ 답글 3" 버튼(`root_reply_count`, TRD §4). "↳"는 장식이라 접근 가능한 이름에서 제외. 마지막 답글 시각은 계약에 없어 렌더하지 않음(W-10i). 문구 정본 COPY_GAPS G-41(결정 3) | **새 답글 점 + "새 답글" 텍스트는 이 스레드가 unread 대상이고 `unread_reply_count > 0`일 때만**(PRD §7-7; 데이터원 `unread_threads[]`, TRD §3:99). 대상이 아닌 스레드는 답글 수만 표시 | SYNC-03·04 |
| CMP-15 | `ConnectionBanner` | 상단 고정 상태 띠. `role="status"` `aria-live="polite"` | **연결됨(숨김) / 다시 연결 중… / 연결이 끊겼습니다 / 최신 상태 확인 중…**(§6-4) | SYNC-07, CLIENT-04 |
| CMP-16 | `StatusRegion` | 시각적으로 숨긴 `aria-live` 영역 | — | CLIENT-07 (WCAG 4.1.3) |
| CMP-17 | `EmptyState` / `ErrorState` / `Skeleton` | 공통 5상태 프리미티브 | — | — |
| CMP-18 | `Dialog` | APG modal dialog. 용도: 채널 만들기(관리자), 채널 찾기(medium·wide), DM 시작(medium·wide), 초대 링크 발급, **채널 나가기 확인**, **멤버 비활성화 확인**, 메시지 삭제 확인, 단축키 안내 | 열림/닫힘, 닫히면 트리거로 포커스 복귀 | CONV-01·02·03, AUTH-01·03, MSG-05 |
| CMP-19 | `LoginForm` / `InviteAccept` | 이메일·비밀번호 / 프래그먼트 토큰 수락(§4-2) | 오류(자격 증명 오류는 **구체 원인 미노출**, 동일 문구) / 제한(429: "잠시 후 다시 시도해 주세요", 수치는 TRD §5) / 초대 만료·사용됨·폐기("이 초대 링크는 더 이상 사용할 수 없습니다", 구분 없음) | AUTH-01·02·06 |
| CMP-20 | `InstallHint` | PWA 설치 안내(iOS: 공유 → 홈 화면에 추가) | standalone이면 숨김(`display-mode: standalone`) | CLIENT-03 |
| CMP-21 | `Avatar` | 이니셜 원형. 색은 neutral 5 고정(사용자별 색 해시 없음) | — | — |
| CMP-22 | `SessionList`(P1) | 기기별 세션·원격 로그아웃 | — | AUTH-04 |
| CMP-23 | `ChannelBrowser` | 아직 참여하지 않은 공개 채널 목록 + "참여" 버튼(`/discover` 또는 Dialog) | 로딩 / 빈("참여할 수 있는 채널이 없습니다") / 참여 중(버튼 비활성) / 오류 | CONV-02 |
| CMP-24 | `DmStarter` | 멤버 콤보박스(`GET /api/members`) → "DM 시작" → 기존 DM이면 그 DM으로 이동 | 빈("다른 멤버가 없습니다") / 오류 | CONV-03 |
| CMP-25 | `MemberAdmin`(관리자) | 멤버 목록·역할·상태, **초대 링크 만들기**(발급 결과: 링크 1회 표시 + 복사 버튼 + 만료 시각, 다시 볼 수 없음 안내), **비활성화**(확인 Dialog) | 비관리자 접근: "권한이 없습니다" / 비활성화 완료: 행 muted + "비활성" 라벨 / 오류 | AUTH-01·03·05 |
| CMP-26 | `BotBadge` | 작성자 이름 옆 봇 표시(ADR-001 §3-a·§3-c). 판정은 서버 projection `author_kind = 'bot'`만 따름. 색만으로 구분하지 않고 텍스트를 포함 | 표시 / 숨김(사람 작성자). 문구·모양은 결정 필요(Q-H1, UI_STATES §8-2) | BOT-03 |
| CMP-27 | `AttachmentList` | 메시지 본문 아래 첨부 묶음(`role="list"`). 첨부별로 CMP-28·29를 렌더 | 첨부 있음 / 만료 자리표시자(문구 결정 필요, Q-H3) | OPS-05 |
| CMP-28 | `AudioAttachment` | 오디오(mp3) 플레이어: 재생·일시정지·탐색·길이 표시 | 준비 / 재생 중 / 재생 실패("다시 시도") / 만료. 버튼 이름·실패 문구 결정 필요(Q-H3) | OPS-05 |
| CMP-29 | `ImageAttachment` | 이미지(png·jpeg·webp) 썸네일(가로 넘침 0) + 탭 시 CMP-18 Dialog 확대 | 썸네일 / 확대 / 만료. 대체 텍스트 결정 필요(Q-H3) | OPS-05 |
| CMP-30 | `PushSettings` | 설정(`/settings`)의 이 기기 알림 구독 카드. iOS 미설치 시 CMP-20 연결 | 미지원 / 홈 화면 미설치(iOS) / 권한 미결정 / 거부됨 / 구독됨 / 등록 실패. 문구·위치 결정 필요(Q-H4·Q-H5) | CLIENT-05 |

### 6-3. 메시지 전송 상태 매트릭스 (FR-MSG-02·03 정본, HTTP 결과 기준)

| 상태 | 트리거 | 시각(투명도 사용 금지) | 텍스트/접근성 | 허용 동작 |
|---|---|---|---|---|
| 전송 중 | 작성기 전송 → `POST /api/conversations/{id}/messages` 응답 전 | 본문은 **정상 대비**로 렌더. 시간 자리에 `clock` 아이콘 + `--text-muted` 라벨 "전송 중" | `aria-label="전송 중"` | 없음(수정·삭제·답글 비활성). **자동 재전송 큐 없음** |
| 저장 확인 | HTTP 2xx에 `id`·`seq`·`change_id` 도착(TRD §3) | 일반 렌더. 성공 아이콘 **기본 비표시** | StatusRegion 안내 없음 | 모두 |
| **저장 여부 확인 중** | 요청을 보냈으나 **응답 없이** 네트워크 오류·타임아웃·페이지 복귀(ACK 유실 가능) | 시간 자리에 물음표 계열 아이콘 + muted 라벨 "저장 여부 확인 중" | "**저장 여부 확인 중 · 다시 시도**" 버튼. `role="status"`(alert 아님 — 실패 단정 금지) | 다시 시도(**같은 `client_message_id`·같은 본문** → 서버가 이미 저장했으면 원래 결과 반환, 아니면 새로 저장 — TRD §2 멱등 규칙) → 2xx면 저장 확인, 4xx/5xx면 실패. 삭제(로컬) |
| 실패 | HTTP 오류 응답 확정(4xx/5xx) 또는 전송 시점 `navigator.onLine === false` | 왼쪽 2px `danger-solid` 선, 시간 자리에 경고 아이콘 | "**전송 실패 · 다시 시도**" + "삭제" 버튼. `role="alert"` 1회. 400 상한/빈 본문·409 충돌은 다시 시도 대신 "다시 작성" 안내(§6-1 오류 규칙) | 다시 시도(같은 ID), 삭제(로컬) |
| 수정됨 | `edited_at` 존재 | 본문 뒤 "(수정됨)" muted | 시간 툴팁에 수정 시각 | 모두 |
| 삭제 자리표시자 | `deleted_at` 존재(body 없음) | 이탤릭 muted "삭제된 메시지입니다", 자리 유지 | 답글 수가 있으면 ThreadSummary 유지 | 스레드 열기만 |
| 자기 멘션 | 응답·이벤트의 `mention_user_ids`에 내 ID 포함(TRD §4:122) | 배경 `accent-bg`, 왼쪽 선 `accent-solid` | 멘션 텍스트 `@이름`은 `accent-text` | 모두 |

전이 규칙(R3 확정):

1. **이미 "저장 확인"된 메시지는 연결 단절·WS 종료·재연결로 다른 상태로 되돌리지 않습니다.**
2. "다시 연결 중"(WS만 끊김)에서는 HTTP 전송을 그대로 보냅니다. 상태는 HTTP 결과로만 정해집니다.
3. 전송 직후 작성기는 **즉시 비워지고** 본문은 전송 중 항목으로 옮겨집니다(초안이 ACK 시점에 지워지는 일이 없음). 늦게 온 ACK는 작성기를 건드리지 않습니다.
4. "저장 여부 확인 중" 항목은 사용자가 다시 시도하기 전까지 유지됩니다. 서버 응답·이벤트에 `client_message_id`가 있으면 자동으로 "저장 확인"으로 접을 수 있으나, TRD R3의 `message.created` 필드 목록에는 `client_message_id`가 없어 **자동 접기는 선택 사항**이고 기본 경로는 수동 다시 시도입니다(⚖️-D1, §13).

### 6-4. 연결 상태 매트릭스 (FR-SYNC-07·FR-CLIENT-04 정본)

| 상태 | 조건 | ConnectionBanner | 작성기·본문 |
|---|---|---|---|
| 연결됨 | WS open, 마지막 catch-up 완료 | 숨김 | 정상 |
| 다시 연결 중… | WS close 후 재시도 중(지수 백오프). `navigator.onLine`은 true | `warning-bg`, `refresh-cw` 회전(모션 축소 시 정지), "다시 연결 중…" | **입력·전송 정상.** HTTP 결과로 전송 상태 판정(§6-3) |
| 연결이 끊겼습니다 | `navigator.onLine === false`, 또는 HTTP 요청이 네트워크 오류·게이트웨이 응답(502/503/504)으로 연속 2회 실패(제안값) | `danger`, `wifi-off`, "연결이 끊겼습니다. 지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요." | 입력 가능. `onLine === false`면 전송 시도는 즉시 "실패"(HTTP 미호출). 네트워크 오류 경우는 응답 없음 → "저장 여부 확인 중". **이미 저장 확인된 메시지는 변하지 않음** |
| 최신 상태 확인 중… | 전경 복귀·재연결 직후 `GET /api/sync` 페이지 catch-up → `GET /api/conversations` 읽음 snapshot → 구독(TRD §4:124) 진행 중 | neutral, "최신 상태 확인 중…", 목록 `aria-busy="true"` | 본문은 **흐리게 하지 않음**(D3). 새 전송은 HTTP 결과로 정상 판정. **unread 배지·"여기부터 새 메시지" 구분선·사이드바 굵게는 catch-up 완료 전까지 갱신을 보류**하고 완료 후 한 번에 적용(NFR-07 "stale UI를 최신으로 표시하지 않음") |

- 410(커서 만료) 시 TRD §3 snapshot 절차 동안도 "최신 상태 확인 중…"을 유지합니다.
- 401 수신 시 모든 화면 데이터를 메모리에서 비우고 `/login`으로 이동, 문구는 §4-3 "세션이 종료되었습니다"(FR-CLIENT-04 로그아웃 후 뒤로가기 재노출 금지와 함께 `Cache-Control: no-store` 등 구현은 TRD §5–6 정본).

---

## 7. 접근성·키보드·한글 IME

### 7-1. 목표 기준 (WCAG 2.2 AA)

| SC | 요구 | 우리 규칙 |
|---|---|---|
| 1.4.3 Contrast (Minimum) | 텍스트 4.5:1 | 토큰 린트로 두 스킴 실측. muted 텍스트(step 11)도 4.5:1 이상. **전송 중·stale 상태를 투명도로 표현하지 않음**(M-D2) |
| 1.4.11 Non-text Contrast | UI 요소·포커스 링 3:1 | 보더 step 7 이상, 포커스 링 step 8 |
| 1.4.4 Resize Text | 200% | `rem` 단위, 고정 높이 금지(§3-2). 200%에서 구간이 한 단계 내려가는 것은 정상 |
| 2.1.1 / 2.1.2 Keyboard, No Trap | 모든 기능 키보드 조작, 트랩 없음 | §7-3 키맵, 오버레이·다이얼로그는 항상 Esc 탈출(초안 보존) |
| 2.4.3 Focus Order | 논리 순서 | DOM 순서 = 시각 순서. 사이드바 → 헤더 → 목록 → 작성기 → 스레드 |
| 2.4.7 / 2.4.11 Focus Visible / Not Obscured | 가시 포커스, 가려지지 않음 | 2px 링 + 2px 오프셋. 고정 배너·작성기가 포커스 요소를 가리면 `scroll-margin` |
| 2.5.8 Target Size (Minimum) | **24×24 CSS px** 이상 | 모든 터치 목표 **44×44px**(Apple HIG 권장값으로 기억, 원문 미확인 → 추정). 최소 24px는 하드 룰 |
| 4.1.3 Status Messages | 상태 변화는 포커스 이동 없이 전달 | StatusRegion(`aria-live="polite"`), 실패는 `role="alert"`, 저장 여부 확인 중은 `role="status"` |

### 7-2. ARIA 구조

- `MessageList`: `role="list"`, 각 메시지 `role="listitem"`에 `aria-label="홍길동, 오후 3:12"` + 본문. 새 메시지 알림은 목록이 아니라 StatusRegion이 "새 메시지 1개" 식으로 묶어 전달(과다 알림 방지). `role="log"`는 대안이며 Developer와 구현 시 확정.
- `Sidebar` 공간 목록: `nav aria-label="공간"` > `ul`. 선택 항목 `aria-current="page"`. 접힘 상태는 각 항목 `aria-label`에 이름+상태 포함.
- `ThreadPanel`(wide): `aside aria-label="스레드"`; (medium): `role="dialog" aria-modal="true"`; (compact): 별도 라우트 페이지.
- `MentionPicker`: APG combobox(`role="combobox"` + `aria-expanded` + `listbox`).
- `Dialog`: APG modal dialog, 닫힘 시 트리거 포커스 복귀.
- `UnreadBadge`: 숫자만 보이되 `aria-label="멘션 2개"`. 새 답글 점: `aria-label="새 답글 있는 스레드 n개"`.

### 7-3. 키보드 맵 (FR-CLIENT-01 수용 기준 정본)

| 키 | 동작 | 포커스 결과 |
|---|---|---|
| `Ctrl/⌘+K` | 공간 전환기(콤보박스) 열기 — **기본 전환 수단** | 입력란 |
| `Ctrl+Alt+↑ / Ctrl+Alt+↓` (mac `⌃⌥↑/↓`) | 이전/다음 공간 | 작성기 |
| `Ctrl+Alt+Shift+↑ / ↓` | 읽지 않은 공간만 이동 | 작성기 |
| `Enter` (작성기) | 전송(§7-4 우선순위 적용) | 작성기 유지 |
| `Shift+Enter` | 줄바꿈(조합 중이 아닐 때) | — |
| `Esc` — 다이얼로그·멘션 후보·medium 스레드 오버레이·compact 스레드 화면 안 | **항상 닫기**(WCAG 2.1.2). 작성기 초안은 대상별로 보존되어 다시 열면 복원 | 트리거(원문의 "답글" 버튼 또는 연 버튼) |
| `Esc` — wide 스레드 패널 작성기, **비어 있음** | 스레드 패널 닫기 | **원문 메시지의 "답글" 버튼**(FR-CLIENT-07 "원래 항목에 포커스 복귀") |
| `Esc` — wide 스레드 패널 작성기, **입력 있음** | 1회: 아무 동작 없음 + StatusRegion "닫으려면 Esc를 한 번 더 누르세요"(초안은 보존됨) / 1.5초 안에 2회: 닫기 | 원문 "답글" 버튼 |
| `↑` (작성기 비어 있음) | 내 마지막 메시지 수정(P1 후보) | 인라인 편집기 |
| `Tab` / `Shift+Tab` | 영역 간 이동. 메시지 목록 안에서는 **메시지 단위**(roving tabindex) | — |
| 메시지에서 `R` / `E` / `Delete` | 답글 / 수정(내 것) / 삭제(내 것, 확인 다이얼로그) | 스레드 작성기 / 편집기 / 다이얼로그 |
| `Ctrl/⌘+/` | 키보드 단축키 안내 다이얼로그 | 다이얼로그 |

- 단축키는 **입력 중이 아닐 때만**(작성기 포커스 시 단일 글자 단축키 비활성). `Alt+↑/↓` 단독은 macOS 텍스트 입력의 Option+화살표(문단 이동)와 겹쳐 **쓰지 않습니다**(R1에서 변경). `⌃⌥` 조합이 브라우저·OS 기본 동작과 겹치지 않는다는 판단은 추정이며 QA-FR-CLIENT-01에서 macOS Safari·Chrome으로 확인합니다.
- **초안 규칙:** 작성기 초안은 대상(대화 또는 스레드 root)별 메모리 맵에 보존하고, 화면 전환·오버레이 닫기·탭 전환에 유지됩니다. 로그아웃·401·페이지 종료 시 폐기(지속 저장 없음 — FR-CLIENT-04).
- 모바일(compact)에서는 키맵 대신 보이는 버튼(뒤로·답글·더보기)으로 같은 기능 제공.

### 7-4. 한글 IME 규칙 (FR-MSG-08 정본; 개발설계서 6-4 사례의 기대값)

**입력 처리 우선순위(위가 이김):**

| 순위 | 조건 | 동작 |
|---|---|---|
| 1 | **조합 보호:** `event.isComposing === true`, 또는 `event.keyCode === 229`, 또는 `event.key === 'Process'` | 앱은 **아무 키도 처리하지 않습니다**(전송·줄바꿈·멘션·단축키 전부). Shift+Enter도 IME에 맡깁니다 |
| 2 | **확정 Enter 창:** `compositionend` 이후 **다음 `keyup` 또는 100ms 중 먼저 오는 시점**까지 플래그 `justComposed=true`. 이 창 안의 `Enter`(`isComposing=false`) | 전송하지 않고 플래그만 내립니다(마지막 글자 확정용 Enter). 창이 닫힌 뒤의 Enter는 **독립 Enter**로 보고 버리지 않습니다. 마우스·블러로 조합이 끝난 경우 100ms 후 자동 해제되어 다음 Enter는 전송됩니다 |
| 3 | **멘션 후보 열림**(CMP-12 `aria-expanded=true`) | `Enter`/`Tab` = 후보 선택(전송 아님), `Esc` = 후보 닫기(작성기 유지), `↑/↓` = 후보 이동 |
| 4 | `Shift+Enter` | 줄바꿈 |
| 5 | `Enter` (본문 비어 있지 않고 상한 이내) | 전송 1회. 전송 직후 작성기를 비우고 포커스 유지 |
| 6 | 그 외 | 기본 편집 동작 |

**보조 규칙:**

1. 100ms·`keyup` 해제 조건은 **제안값**입니다. Safari가 조합 확정 Enter를 `isComposing=false`·`keyCode=229`로 보낸다는 서술도 추정이며(§12), 두 경로를 모두 jsdom으로 재현하고(개발설계서 6-4 사례 1–3) **실기기 매트릭스**로 값을 조정합니다.
2. 전송 직후 작성기를 비울 때 `compositionstart` 중이면 비우기를 `compositionend` 이후로 미룹니다(조합 중 DOM 변경은 iOS에서 글자 중복 — 추정). 우선순위 1 때문에 조합 중 전송은 일어나지 않으므로 이 규칙은 외부 전송 버튼 클릭 경로에만 해당합니다.
3. 전송 응답 대기 중 새 조합을 시작해도 영향 없음: 작성기는 전송 시점에 이미 비워졌고 ACK는 작성기를 건드리지 않습니다(§6-3 전이 3).
4. 멘션 트리거 `@`는 조합 중이 아닐 때만 콤보박스를 열고, 한글 이름 검색은 `compositionupdate` 텍스트도 포함해 매칭(초성 검색은 P1).
5. **실기기 검증 매트릭스(QA-FR-MSG-08):** macOS 두벌식 + Safari / Chrome, iOS 한국어 키보드 + Safari / 홈 화면 PWA. 각 환경에서 ① 조합 중 Enter 미전송 ② 확정 Enter 미전송 ③ 확정 후 독립 Enter 1회 전송 ④ 마우스 확정 후 Enter 전송 ⑤ 조합 중 Shift+Enter 입력 훼손 없음 ⑥ 멘션 후보 열림 상태 Enter = 선택 ⑦ 연속 빠른 입력 훼손 없음. 자동 테스트만으로 통과 선언하지 않습니다(개발설계서 `DEV_DESIGN.md:268`과 동일 입장).

### 7-5. 그 외

- `prefers-reduced-motion: reduce`에서 모든 트랜지션 0ms(§3-5).
- **`prefers-color-scheme`에 따라 라이트/다크 자동(MVP 확정, §3-3). 수동 토글은 P1.**
- 언어: `<html lang="ko">`. 날짜·시간은 `Intl.DateTimeFormat('ko-KR')`.
- 이미지(아바타 이니셜)는 `alt` 대신 `aria-label` 이름.

---

## 8. 반응형 보강 규칙

| 항목 | compact(≤640) | medium(640<w<1024) | wide(≥1024) |
|---|---|---|---|
| 사이드바 | 별도 화면(라우트 `/`) | 260px 고정 | 260px; **스레드 열림 + w<1120이면 72px 접힘(필수)** |
| 스레드 | 별도 화면 | 오버레이 시트 `min(420px,100%)` | 우측 패널 `clamp(320px,32vw,380px)` |
| 작성기 | 하단 고정 + safe-area | 본문 하단 | 본문 하단 |
| 메시지 액션(답글·수정·삭제) | 길게 누르기 → 액션 시트(`Dialog`) | hover/포커스 시 인라인 툴바 | 동일 |
| 헤더 | 뒤로 + 제목 + 더보기 | 제목 + 멤버 수 + 더보기 | 동일 |
| 채널 찾기 / DM 시작 / 멤버 관리 | 라우트 화면 | Dialog / Dialog / 라우트 | 동일 |
| 타임스탬프 | 메시지 아래 `text-xs` | 작성자 옆 | 작성자 옆 |
| 가상 키보드 | `VisualViewport` 보정 | — | — |

- 세로 높이: `height: 100dvh` 기본, 미지원 브라우저 폴백 `100vh`(iOS 지원 버전은 ⚖️-4 기기 결정 후 확인).
- 가로 320px: 사이드바 화면에서 공간 이름 말줄임(`text-overflow: ellipsis`), 배지·점은 유지.

---

## 9. PWA 아이콘·manifest 디자인 원칙 (FR-CLIENT-03; TRD §6이 이 절을 정본으로 인용)

### 9-1. 심볼 원칙

1. **독자 제작 기하 심볼** 1개. 후보 모티프: "두 개의 겹친 원호(대화의 왕복)", "오프셋된 두 사각 모서리(동기화된 기기)". `#`·말풍선·격자·4색 바람개비·모노그램 S는 **배제**.
2. 단색 1 + 중성 배경 1로 구성(액센트 step 9 위에 흰 심볼, 또는 그 반전). 그라데이션·그림자 없음(maskable 원형 크롭에서 안전).
3. 심볼은 SVG 원본을 저장소 `apps/web/public/icons/source.svg`에 두고, PR 본문에 "독자 제작, 참고 출처 없음"을 기록(CLEANROOM 4-1, 개발설계서 W-04b).

### 9-2. 산출물 세트 (TRD §6 정본 인용 대상)

| 파일 (`apps/web/public/icons/` 기준) | 크기 | `purpose` | 비고 |
|---|---|---|---|
| `icon-192.png`, `icon-512.png` | 192·512 | `any` | 투명 배경 허용 |
| `icon-maskable-512.png` | 512 | `maskable` | 심볼을 **중앙 안전 영역** 안에(web.dev "minimum safe zone"; 지름 80% 원 안이 통례 — 추정). Chrome DevTools로 확인 |
| `icon-mono.svg` 또는 `icon-mono-512.png` | 512 | `monochrome` | 배지·고정 아이콘용 단색 |
| `apple-touch-icon.png` | **180×180** | — | `<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">`. **불투명 배경**(추정: iOS는 투명 영역을 검게 채움) |
| `favicon.svg` | — | — | `<link rel="icon" type="image/svg+xml" href="/icons/favicon.svg">` |
| `apps/web/public/favicon.ico` | 32 | — | **경로 예외 1개**(§2-3-2): 브라우저가 `/favicon.ico`를 기본 요청하므로 루트에 둠 |

### 9-3. manifest 필드

```json
{
  "name": "<승인된 배포 이름 — 그 전까지 임시 중립 이름>",
  "short_name": "<12자 이내>",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "<neutral step 1 라이트 값>",
  "theme_color": "<neutral step 2 라이트 값>",
  "lang": "ko",
  "icons": [ "...§9-2..." ]
}
```

- `name`·`short_name`에 "slack" 금지(§2-3-5). 개명 전까지 내부 빌드는 임시 중립 이름을 씁니다(§14-5).
- `theme_color`는 **유채색이 아닌 중성**. 다크 모드 대응은 `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="<neutral step 2 다크 값>">` 추가(§3-3 다크 모드 MVP 포함과 일관).
- iOS: `<meta name="apple-mobile-web-app-capable" content="yes">`, 상태 표시줄 `apple-mobile-web-app-status-bar-style`은 `default`.
- 스플래시: iOS는 자동 생성하지 않을 수 있어 **MVP는 스플래시 이미지 미제공**(확인 필요).
- `start_url`·`scope`·`display`는 TRD §6과 동일 값. SW 캐시 범위(해시된 앱 셸만, `/api/**`·WS 제외)는 TRD §6 정본이며 이 문서는 아이콘·셸 외관만 다룹니다.

---

## 10. 화면 목록과 핵심 흐름 (W-04 handoff 단위)

### 10-1. 화면

| # | 화면 | 포함 컴포넌트 | 상태 수 |
|---|---|---|---|
| SCR-01 | 로그인 | CMP-19 | 기본·오류·제한 |
| SCR-02 | 초대 수락(`/invite#t=`) | CMP-19 | 유효·사용 불가(만료/사용됨/폐기 공통)·네트워크 오류 |
| SCR-03 | 공간 목록(compact 화면 / wide 사이드바) | CMP-02·03·04 | 로딩·빈("채널이 없습니다 — 관리자만 생성", 비관리자) / 빈("첫 채널을 만들어 보세요", 관리자)·기본·나간 채널 |
| SCR-04 | 대화 본문 | CMP-05~12·15·16 | 로딩·빈·기본·오프라인·재동기화·나간 채널 |
| SCR-05 | 스레드 | CMP-13·14·11 | 로딩·빈·원문 삭제됨 |
| SCR-06 | 채널 만들기(관리자) / 초대 링크 / 삭제 확인 / 나가기 확인 / 비활성화 확인 | CMP-18 | 기본·오류(중복 이름 409 등) |
| SCR-07 | 설치 안내 | CMP-20 | iOS·macOS 분기, standalone 숨김 |
| SCR-08 | 설정 / 세션(P1) | CMP-22 | — |
| SCR-09 | 키보드 단축키 안내 | CMP-18 | — |
| SCR-10 | 채널 찾기·참여 | CMP-23 | 로딩·빈·기본·오류 |
| SCR-11 | DM 시작 | CMP-24 | 빈·기본·오류 |
| SCR-12 | 멤버 관리(관리자, P0) | CMP-25 | 기본·권한 없음·오류 |

### 10-2. 시나리오 UI 흐름 (PRD S1·S3·FR-CONV-02를 화면에서 끝까지)

**S1 — 초대·참여·비활성화 (FR-AUTH-01·03·05)**

1. 관리자 A: SCR-12 → "초대 링크 만들기" → Dialog에 링크(`https://<host>/invite#t=…`)·만료 시각·복사 버튼이 **1회만** 표시("이 창을 닫으면 다시 볼 수 없습니다"). 발급 API `POST /api/invites`(TRD §3). 링크 문자열은 계측·로그에 기록하지 않음(PRD §10).
2. 멤버 B(합성): 링크 열기 → SCR-02가 해시를 읽고 즉시 지움 → 이메일·비밀번호 입력 → `POST /api/invites/accept` → 성공 시 `/`로 이동. 만료·사용됨·폐기는 같은 문구로 거부.
3. B: SCR-03에서 채널 없음 → SCR-10 "채널 찾기"로 공개 채널 참여(FR-CONV-02) → SCR-04에서 메시지 전송.
4. A: SCR-12 → B 행 "비활성화" → 확인 Dialog(문구 §4-3) → `POST /api/admin/members/{user_id}/deactivate`.
5. B의 열린 화면: WS 종료·다음 HTTP 401 → 메모리 비움 → SCR-01 "세션이 종료되었습니다. 다시 로그인해 주세요." 재로그인 시도는 자격 증명 오류와 같은 문구(계정 존재 비노출, TRD §5).
6. 비관리자 B가 SCR-12에 직접 진입: "권한이 없습니다" 빈 상태, 버튼 없음(FR-AUTH-05; 서버 403이 진실).

**S3 — DM 격리 (FR-CONV-03·04)**

1. A: Sidebar "DM 시작" → SCR-11 콤보박스에서 B 선택 → `POST /api/dms` → 기존 DM이 있으면 같은 `/c/:id`로 이동(FR-CONV-03).
2. 비참여자 C가 그 `/c/:id` URL을 직접 열면: 서버 404(존재 은폐, TRD §3) → SCR-04는 **"대화를 찾을 수 없습니다"** 빈 상태 하나만 표시(403과 구분하지 않음, 멤버 수·이름 미노출) + "공간 목록으로" 버튼.
3. C의 사이드바·`GET /api/conversations`·WS 구독에는 해당 DM이 없음(FR-CONV-04). UI는 서버 목록만 그리고 로컬에서 ID를 추측·보관하지 않음.

**FR-CONV-02 — 채널 참여·나가기**

1. 참여: SCR-10 → "참여" → `POST /api/conversations/{id}/join` → 목록 갱신 → `/c/:id`로 이동. 읽음 커서는 서버가 `joined_seq`로 초기화하므로(TRD §2) 이전 이력이 unread로 뜨지 않음 — UI는 "여기부터 새 메시지" 구분선을 그리지 않음.
2. 나가기: SCR-04 더보기 → "채널 나가기" → 확인 Dialog → `DELETE /api/conversations/{id}/membership`. 성공 시 **목록에는 유지**(CMP-03 나간 채널 상태), 본문은 CMP-06 "나간 채널" 빈 상태, 작성기 숨김, WS 구독 해제(서버가 5초 내 중단).
3. 다시 참여: 나간 채널 행 또는 본문 빈 상태의 "다시 참여" → 1번과 동일.

---

## 11. 디자인 QA 체크리스트 (G1 게이트 QA-FR-CLIENT-01/02/07·QA-FR-MSG-08·QA-FR-OPS-04 입력)

1. **폭:** 320·390·640·640.5·768·1023.5·1024·1119·1120·1280·1440px에서, 스레드 닫힘/열림 각각, 가로 스크롤 0, 작성기·전송 버튼 가림 0. 640은 compact, 640.5–1023.5는 medium, 1024는 wide로 렌더.
2. **1024–1119px + 스레드 열림:** 사이드바 자동 접힘, 본문 ≥ 480px 유지. 스레드 닫으면 펼침 복귀.
3. **200% 확대**에서 SCR-04 모든 조작 가능(구간이 한 단계 내려가도 통과).
4. **키보드:** §7-3 전 항목 수행. wide 스레드 Esc 후 포커스가 원문 "답글" 버튼으로 복귀. 입력 있는 상태의 Esc 1회는 닫히지 않고 초안 보존.
5. **상태 구분:** 전송 중·저장 여부 확인 중·실패·연결 끊김이 **그레이스케일 필터에서도** 구분됨. 본문에 투명도 적용 0건.
6. **토큰 린트(`check:design-tokens`):** 두 스킴 모두 대비 4.5:1/3:1 통과, §2-3-3 색 규칙 위반 0, 모든 토큰에 `source`·`license`.
7. **다크 모드:** `prefers-color-scheme: dark`에서 SCR-01~05 렌더, `theme-color` 다크 메타 적용.
8. **IME:** §7-4 매트릭스 7항목 × 4환경 통과(수동).
9. **PWA:** `manifest`·§9-2 아이콘 전부 존재, `short_name` 금지어 0, favicon 2종 경로 일치.
10. **에셋 경로:** §2-3-2 허용 경로 밖 이미지·폰트·오디오 0개, `docs/**`·`qa/manual/**` 이미지에 출처 한 줄.
11. **S1·S3 흐름(§10-2):** 합성 A/B/C로 화면 단위 끝까지 재현, 비참여자 404 화면에 멤버·이름 노출 0.

---

## 12. 사실 / 추정 / 확인 필요

**사실 (원문·응답 확인)**
- R1(2026-11-07): 라이선스 파일 머리 — Pretendard·JetBrains Mono·Noto Sans CJK·Noto Color Emoji = SIL OFL 1.1 / Lucide = ISC / Phosphor·Tabler·Radix Colors·Open Color·Tailwind CSS·Fluent UI Emoji = MIT / Twemoji 그래픽 = CC BY 4.0. Tailwind 문서 `sm 40rem(640px)`·`lg 64rem(1024px)`. Radix step 용도. WCAG 2.2 SC 목록·수치. MDN `isComposing`·`compositionend`·manifest·`env()`·`dvh`·`word-break`. Apple `apple-touch-icon` 180. web.dev maskable safe zone. Lucide raw 경로 아이콘 존재 목록.
- **R3(2026-11-07) OFL 1.1 전문 재확인**(`openfontlicense.org/open-font-license-official-text/`): "Modified Version"은 "adding to, deleting, or substituting – in part or in whole – … by changing formats or by porting"으로 정의됨(서브셋·포맷 변환 포함). §2: 원본·수정본 사본마다 저작권 고지와 이 라이선스 동봉. §3: Modified Version은 Reserved Font Name을 "사용자에게 보이는 기본 폰트 이름"으로 쓸 수 없음(서면 허락 예외). §5: 폰트는 OFL로만 재배포.
- PRD v1.2·TRD R3·개발설계서 R3 전문을 읽고 §4·§6·§9·§13의 인용 줄을 대조했습니다.

**추정**
- URL 프래그먼트가 HTTP 요청·Referer에 실리지 않는다는 서술(일반 웹 지식, MDN 재조회 안 함).
- `⌃⌥↑/↓`가 macOS·브라우저 기본 동작과 겹치지 않음. 100ms/`keyup` 확정 Enter 창. Safari `keyCode 229` 동작. 조합 중 DOM 변경 시 iOS 글자 중복. 0.02px 폴백 미디어 쿼리 간격. 연결 끊김 판정의 "네트워크 오류 연속 2회".
- 44×44px 터치 목표 = Apple HIG 권장값. maskable 안전 영역 = 지름 80%. iOS `apple-touch-icon` 투명 영역 처리. Radix 11·12 단계 AA 설계 의도.
- "짙은 자주 사이드바"가 트레이드 드레스 핵심 요소라는 판단 — 1차 A T8 "color combinations" 문구에 근거한 보수적 회피이며 법률 판정이 아님.

**확인 필요**
- Lucide 경고·물음표·참여·나가기·멤버 아이콘의 실제 이름(패키지 설치 후).
- `interactive-widget=resizes-content`·`dvh`·Media Queries 범위 문법의 iOS Safari 지원 버전(⚖️-4 지원 기기 결정 후).
- iOS 홈 화면 PWA 스플래시 생성 규칙.
- Pretendard 배포 웹 빌드의 정확한 릴리스 버전·파일 목록(W-04b 시점에 `SOURCES.md`에 기록).

---

## 13. 다른 문서와의 정합 결과 (R1 가정 A1–A10의 R3 처리)

| # | R1 가정 | R3 결과 | 근거 |
|---|---|---|---|
| A1 | 브레이크포인트 640/1024, `compact/medium/wide` | **정합 완료.** PRD FR-CLIENT-01/02가 "디자인 정본 구간"을 인용(`PRD.md:101–102`), 개발설계서 테스트가 토큰 상수를 읽음(`DEV_DESIGN.md:277`). 이 문서 §5-1이 연속 구간·경계값·접힘 규칙을 확정 | PRD v1.2, DEV R3 |
| A2 | 컴포넌트 ID·테스트 파일명 | **정합 완료.** 테스트 파일명은 개발설계서 정본: `apps/web/test/conversation/send-status.test.tsx`(R1의 `send-state` 표기 **철회**), `composer-ime.test.tsx`, `layout/keyboard.test.tsx`, `layout/responsive.test.tsx`, `a11y/labels.test.tsx`(`DEV_DESIGN.md:262–280`). 경로 접두어 `apps/web/test/` | DEV R3 |
| A3 | 전송 5종·연결 4종 문구 | **정합 완료.** PRD FR-MSG-02·SYNC-07이 "상태 문구는 디자인 §6 정본"을 인용(`PRD.md:76`, `:95`). 전송 상태는 R3에서 6종으로 확장(저장 여부 확인 중 추가), PRD의 "연결 단절·ACK 유실만으로 미저장 단정 금지"와 일치 | PRD v1.2 |
| A4 | Esc 포커스 복귀 = 원문 "답글" 버튼 | **정합 완료.** 개발설계서 FR-CLIENT-07 테스트 문구가 "원래 답글 버튼"으로 구체화(`DEV_DESIGN.md:280`) | DEV R3 |
| A5 | 라우트 `/c/:conversationId?thread=` | **정합 완료.** TRD는 `conversation_id`·`root_message_id` 명을 쓰고 클라이언트 라우트는 이 문서 정본. 표기 변환 경계만 명시(§4-2). 초대 라우트는 프래그먼트로 변경 | TRD R3 §3·§5 |
| A6 | IME = `isComposing`+229+`compositionend` 후 1회 무시 | **정합 완료, 규칙 정밀화.** 개발설계서 6-4 사례 1–6의 기대값을 §7-4 우선순위 표로 제공. "1회 무시"를 "다음 keyup 또는 100ms 창"으로 바꿈 | DEV R3 6-4 |
| A7 | manifest·아이콘 4종 | **정합 완료.** TRD §6이 "아이콘 세트·크기·purpose·apple touch icon은 디자인 §9-2 정본"으로 인용(`TRD.md:160`) | TRD R3 |
| A8 | 자기 멘션 데이터원 | **정합 완료.** TRD가 응답·이벤트에 `mention_user_ids: uuid[]` 제공(`TRD.md:115–116`, `:122`). DB 테이블 직접 참조 서술 삭제 | TRD R3 |
| A9 | 디자인 출처 검토 체크리스트 | **정합 완료.** 개발설계서 `check:design-tokens`(`DEV_DESIGN.md:193`)·QA-FR-OPS-04(`:284`)·W-04b(`:143`)가 §2-3을 규칙 정본으로 참조 | DEV R3 |
| A10 | 사운드·이모지 미동봉 | 유지 | CLEANROOM 3-2 |

**⚖️ 미정합 (Jarvis 정리 대상, 교차 수정 없음)**

| ID | 내용 | 상대 문서 | 이 문서의 입장 |
|---|---|---|---|
| ⚖️-D1 | `message.created`·전송 응답·이력 응답에 `client_message_id`가 없어 "저장 여부 확인 중" 항목을 **자동으로** 저장 확인으로 접을 수 없음 | `docs/03-trd/TRD.md:115`(`message{id,seq,author_id,thread_root_id,body,created_at,mention_user_ids,root_reply_count?}`), `:91` | 필수 아님. 기본 경로는 수동 "다시 시도"(멱등 규칙으로 충분). 자기 메시지 projection에 `client_message_id`가 추가되면 UI가 자동 접기를 켬. TRD 저자 판단에 맡김 |
| ⚖️-D2 | 연결 끊김 판정 "HTTP 네트워크 오류 연속 2회"와 WS heartbeat(25초, 2회 미응답)의 관계 | `docs/03-trd/TRD.md:177` | UI 배너 조건은 이 문서, dead connection 정리는 TRD. 두 값의 체감 정합은 QA-FR-SYNC-07에서 확인 |

문서 간 **직접 모순은 0건**입니다. PRD ⚖️-5(Jarvis 통합 대조)와 개발설계서 A5(디자인 R3 확정값 대조)는 이 문서 R3로 입력이 갖춰졌습니다.

---

## 14. 영환님 결정 후보 (기본값 적용 상태로 진행 가능)

1. **액센트·중성 색 계열:** 기본값 `slate` + `teal`(§3-3). 대안 `sand` / `jade`·`indigo`. 자주·포도 계열 면 배경은 배제(§2-2). 바꾸면 토큰 값 2개만 변경.
2. **다크 모드:** R3에서 **MVP 포함·OS 자동 추종**으로 확정했습니다(§3-3). P1로 미루려면 §3-3·§7-5·§11-7을 함께 되돌립니다.
3. **본문 폰트:** 기본값 Pretendard 공식 웹 빌드 **무수정 자체 호스팅**(§3-1). 대안 시스템 폰트 스택만(에셋 0). 자체 서브셋은 RFN 때문에 별도 ADR 필요.
4. **아이콘 세트:** 기본값 Lucide 단일. 대안 Phosphor.
5. **앱 심볼 모티프와 임시 중립 이름:** §9-1 후보 2개 중 선택, 또는 개명 ADR(`docs/decisions/`)과 함께. manifest `name`은 지금 중립 이름으로.

---

## 15. 출처 원장

- R1 조회(2026-11-07, robots.txt 허용 경로): 라이선스 원문 https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE · https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE · https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt · https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE · https://lucide.dev/license · https://raw.githubusercontent.com/phosphor-icons/core/main/LICENSE · https://raw.githubusercontent.com/tabler/tabler-icons/main/LICENSE · https://raw.githubusercontent.com/radix-ui/colors/main/LICENSE · https://raw.githubusercontent.com/yeun/open-color/master/LICENSE · https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/LICENSE · https://raw.githubusercontent.com/googlefonts/noto-emoji/main/LICENSE · https://raw.githubusercontent.com/jdecked/twemoji/main/LICENSE-GRAPHICS · https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/LICENSE
- **R3 조회(2026-11-07):** OFL 1.1 전문 https://openfontlicense.org/open-font-license-official-text/ (정의 "Modified Version", 조건 §2·§3·§5)
- 색 체계: https://www.radix-ui.com/colors · https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale · https://www.radix-ui.com/colors/docs/palette-composition/scales
- 브레이크포인트: https://tailwindcss.com/docs/responsive-design
- 접근성: https://www.w3.org/TR/WCAG22/ · https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html · https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html · https://www.w3.org/WAI/ARIA/apg/patterns/combobox/ · https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ · https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role · https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live
- IME: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing · https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event
- 반응형·뷰포트: https://developer.mozilla.org/en-US/docs/Web/CSS/length (dvh) · https://developer.mozilla.org/en-US/docs/Web/CSS/env · https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport · https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport · https://developer.mozilla.org/en-US/docs/Web/CSS/word-break · https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion · https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme · (미조회, 확인 필요) https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Using_media_queries#syntax_improvements_in_level_4
- PWA: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest · https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display · https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons · https://web.dev/articles/maskable-icon · https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
- 트레이드 드레스 조항: `docs/00-research/buzz/Claude-Fable.md` T8 (https://slack.com/terms-of-service/slack-brand — R3 재조회 안 함)

---

## 16. 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| R1 초안 v0.1 | 2026-11-07 | 최초 작성. PRD v1.1·TRD R1·개발설계서 R1 기준 정합 가정 10건 |
| **R3 최종안 v1.0** | 2026-11-07 | Must-fix 9건 반영(거절 0), Should-fix 12건 반영, 자기 예고 수정 4건 반영. 전송 상태 6종·HTTP 결과 기준·투명도 금지, 연속 브레이크포인트·1120px 접힘 규칙, IME 우선순위 표, 초대 토큰 프래그먼트, 다크 모드 MVP 확정, S1/S3/CONV-02 화면 흐름·CMP-23~25, OFL 재확인에 따른 폰트 규칙 정정, PRD v1.2·TRD R3·개발설계서 R3 인용으로 정합 가정 A1–A10 종결 |

---

### R3.1 Jarvis 정합 (2026-11-07)
- ⚖️-D1 해소: TRD R3.1이 전송 응답과 `message.created` projection에 `client_message_id`를 추가했습니다. §6-3 전이 4의 "자동 접기"는 기본 경로입니다(상세: `docs/07-ui-spec/UI_STATES.md` §2-5). 본문의 "TRD R3에 없음" 서술은 이 항목으로 대체합니다.
- §14 기본값(slate+teal, 다크 모드 MVP·OS 추종, Pretendard 무수정, Lucide) 영환님 채택(2026-11-07 "★로 P1 착수"). 앱 심볼(§14-5)은 미결정.

### R3.2 Hermes 연동 컴포넌트 (2026-11-08, ADR-001 채택)
- §6-2에 CMP-26 `BotBadge`·CMP-27 `AttachmentList`·CMP-28 `AudioAttachment`·CMP-29 `ImageAttachment`·CMP-30 `PushSettings`를 추가했습니다(ADR-001 D-1–D-7 ★ 영환님 채택). 상태별 진입·탈출은 `docs/07-ui-spec/UI_STATES.md`가 펼치며, 문구·모양은 UI_STATES §8-2 Q-H1–Q-H6 결정 전까지 정하지 않습니다.

### R3.3 결정 3 시안 문구 (2026-11-08, 영환님 채택)
- §4-3 thread 용어와 §6-2 CMP-14 예시를 "↳ 답글 3"으로 바꿨습니다("↳"는 장식, 접근 이름 제외). 마지막 답글 시각은 계약에 없어 렌더하지 않습니다(W-10i). 작성기 placeholder·도움말, 멘션 팝오버 머리말·도움말, 신규 등재 문구는 `docs/07-ui-spec/COPY_GAPS.md` G-28·G-39–G-42와 UI_STATES §9-1이 정본입니다.

## 리뷰 반영 기록
처리 합계: **Must-fix 9건 — 반영 9 · 거절 0 · 부분 0.** Should-fix 12건 반영. 자기 예고(`docs/06-reviews/Claude-Fable.md` §5) 4건 반영. R2 리뷰 원문은 수정하지 않았습니다. 아래 `file:line`은 이 문서(`docs/05-design-ref/DESIGN_REFERENCE.md`) R3 저장본 기준이며 저장 후 `grep -n`으로 대조했습니다.

| 리뷰어 | 항목 ID | 처리 | 변경 위치 file:line 또는 거절 근거 |
|---|---|---|---|
| GPT-Sol | SOL-D1 (연결 끊김 "저장되지 않았습니다" 모순) | 반영 | §4-3 전송·연결 문구 `:219–220`; §6-3 "저장 여부 확인 중" 행 `:336`, 전이 규칙 1·4 `:344`, `:347`; §6-4 연결 끊김 행 `:355` |
| GPT-Sol | SOL-D2 (1024px 폭 합계 1120 초과, 경계 공백) | 반영 | §5-1 연속 구간·범위 문법·폴백·경계 테스트 값 `:234–247`; §5-2 접힘 필수·`clamp` 스레드 폭·검산 `:266`; §11-1·2 `:545–546` |
| GPT-Sol | SOL-D3 (compositionend 후 Enter 무시 범위, Shift+Enter 충돌) | 반영 | §7-4 우선순위 표(조합 보호 → 확정 Enter 창 → 멘션 → 줄바꿈 → 전송) `:410–419`, 보조 규칙·실기기 매트릭스 `:423–427` |
| GPT-Sol | SOL-D4 (DM 시작·참여/나가기·비활성화 진입점 부재) | 반영 | §4-2 `/discover`·`/dm/new`·`/settings/members` `:204–206`; §4-3 용어 `:222–224`; §6-2 CMP-02·03·05·06 `:305–309`, CMP-18·19 `:321–322`, CMP-23~25 `:326–328`; §10-1 SCR-10~12 `:514–516`; §10-2 S1/S3/CONV-02 흐름 `:518–540` |
| GPT-Luna | 디자인 Must-fix 1 (다크 모드 MVP 범위 단일화) | 반영 | §1-5 `:17`; §3-3 다크 모드 확정 `:132`; §7-5 `:432`; §9-3 theme-color 다크 `:492`; §11-7 `:551`; §14-2 `:609` |
| GPT-Luna | 디자인 Must-fix 2 (PWA 아이콘 세트 TRD 불일치) | 반영 | TRD R3 §6(`docs/03-trd/TRD.md:160`)이 이 문서 §9-2를 정본으로 인용해 해소. §9-2 favicon·apple-touch 경로 명시 `:468–473`; §13 A7 `:590` |
| Claude-Opus 5.5 | M-D1 (WS 재연결 중 전송 즉시 실패) | 반영 | §2-1 D4 `:35`; §6-1 오프라인 행 `:298`; §6-3 트리거 `:334–337`, 전이 규칙 2 `:345`; §6-4 다시 연결 중 행 `:354` |
| Claude-Opus 5.5 | M-D2 (투명도 0.6·stale 흐림이 4.5:1 위반) | 반영 | §2-1 D3 `:34`; §3-3 `--text-muted` 용도 `:121`; §6-3 전송 중 시각 `:334`; §6-4 최신 상태 확인 중 행 `:356`; §7-1 1.4.3 `:369`; §11-5 `:549` |
| Claude-Opus 5.5 | M-D3 (초대 토큰 URL 경로 노출) | 반영 | §1-7 `:19`; §4-2 `/invite#t=`·처리 절차·`Referrer-Policy` `:200`; §6-2 CMP-19 `:322`; §10-2 S1 1–2 `:522–523`; §12 추정(프래그먼트 서술) `:567` |
| GPT-Sol | Should-fix 1 (OFL·RFN·서브셋 단정) | 반영 | §3-1 Pretendard 행 — OFL 원문 재확인 후 "무수정 배포 파일 + 고지 동봉 + 버전 기록, 자체 서브셋은 Modified Version → 개명 또는 허락"으로 정정, R1 서술 철회 `:75`; §12 사실 `:563`; §15 R3 조회 `:619` |
| GPT-Sol | Should-fix 2 (이미지 경로 전면 제한과 산출물 충돌) | 반영 | §2-3-2 출처 종류별 경로 분리·`SOURCES.md`·경로≠출처 검토 `:55–61` |
| GPT-Sol | Should-fix 3 (딥링크 뒤로·Esc·입력 보존 조율) | 반영 | §4-2 스레드 행 `replace` 폴백 `:202`; §5-4 `:281`; §7-3 Esc 3행 `:396–398`, 초안 규칙 `:405` |
| GPT-Sol | Should-fix 4 (전송 중 입력 유지 vs 비우기, 다크 모드 문구) | 반영 | §6-3 전이 규칙 3 `:346`; §7-4 보조 규칙 3 `:425`; 다크 모드는 Luna Must-fix 1과 동일 변경 |
| GPT-Luna | Should-fix 1 (CMP-03/04 배지 의미) | 반영 | §4-1 `:189–192`; §6-2 CMP-03 표시 규칙 ①②③·CMP-04 "멘션 수만" `:306–307`, CMP-14 `:317` |
| GPT-Luna | Should-fix 2 (IME 추정의 QA 연결) | 반영 | §7-4 보조 규칙 1·5 `:423`, `:427`; §12 추정 `:568` |
| GPT-Luna | Should-fix 3 (재시도 가능한 오류 범위) | 반영 | §6-1 오류 행 `:297`; §6-3 실패 행 `:337` |
| Claude-Opus 5.5 | Should-fix 1 (연결 끊김 문구 범위) | 반영 | §4-3 `:220`; §6-4 `:355` — "지금 보내는 메시지는 저장되지 않습니다. 연결되면 다시 시도하세요." |
| Claude-Opus 5.5 | Should-fix 2 (`Alt+↑/↓` macOS 충돌) | 반영 | §7-3 `Ctrl+Alt+↑/↓`로 변경 `:392–393`, 추정 표기·QA 연결 `:404` |
| Claude-Opus 5.5 | Should-fix 3 (Tailwind `sm` 의미 반대) | 반영 | §3-1 브레이크포인트 행 `:82`; §5-1 경계값 소속 명시 `:234–236` |
| Claude-Opus 5.5 | Should-fix 4 (favicon 경로 미정) | 반영 | §2-3-2 `favicon.ico` 예외 `:56`; §9-2 favicon 2행 `:472–473` |
| Claude-Opus 5.5 | Should-fix 5 (테스트 파일명 `send-state`) | 반영 | 개발설계서 정본 `send-status.test.tsx`로 이 문서가 맞춤 — §13 A2 `:585`. Opus 기록용 항목이며 양쪽 모두 `send-status` |
| Claude-Fable(자기 예고) | §5-1 `send-state`→`send-status` | 반영 | §13 A2 `:585` |
| Claude-Fable(자기 예고) | §5-2 폰트 파일 허용 경로 | 반영 | §2-3-2 `apps/web/public/fonts/` `:57`; §3-2 `:108` |
| Claude-Fable(자기 예고) | §5-3 "최신 상태 확인 중" 조건을 전역 커서 결론에 맞춤 | 반영 | §6-4 행 조건 = `GET /api/sync` → `GET /api/conversations` → 구독 `:356`; 410 snapshot `:358` |
| Claude-Fable(자기 예고) | §5-4 CMP-04/14에 스레드 unread 대상 결론 반영 | 반영 | §4-1 `:189–192`; §6-2 CMP-03·04 `:306–307`, CMP-14 `:317` |
