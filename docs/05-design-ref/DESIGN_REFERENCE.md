# 디자인 레퍼런스 — ohmyslack (내부 코드명) v0.1

- 상태: **R1 초안** / 작성자: Claude-Fable (pubkey `2f4fc939…`) / 작성일: 2026-11-07
- 입력: `docs/00-research/BUZZ_ROUND2_DOCS.md`(0절 확정 결정), `CLEANROOM.md`, `docs/02-prd/PRD.md`(GPT-Sol R1 v1.1), `docs/03-trd/TRD.md`(GPT-Luna R1), `docs/04-dev-design/DEV_DESIGN.md`(Claude-Opus R1), `docs/00-research/buzz/Claude-Fable.md`(1차 A, T8 트레이드 드레스 조항)
- 역할: 이 문서는 **디자인 토큰·레이아웃·컴포넌트 상태·접근성 규칙의 정본**입니다. CLEANROOM.md 4-2가 "디자인 토큰은 이 문서의 오픈 출처만 쓴다"고 지정합니다. 개발설계서 W-04(Designer)는 이 문서를 화면·컴포넌트 명세로 바꿉니다.
- 범위 준수: 코드·설치·Git·DB 접속·`.env` 열람·shared-infra 수정 없음. Slack 웹앱·Slack.app·스크린샷 미참조. 외부 링크는 robots.txt 확인 후 공식 문서·공식 저장소 LICENSE 파일만 조회(15절).
- 다른 문서와 맞물리는 ID·이름은 **가정(§13)** 으로 표시하고 R3에서 맞춥니다.

---

## 1. 결론 (요약)

1. **독자 디자인이며 Slack을 참조하지 않습니다.** 금지 대상은 Slack Brand Terms가 트레이드 드레스로 명시한 "color combinations, graphics, sounds, icons, typefaces"와 룩앤필 모방입니다(1차 A T8). 이 문서는 "무엇을 안 쓰는가"를 **기계 검증 가능한 규칙**(§2-3)으로 바꿨습니다.
2. **토큰은 전부 오픈 라이선스 출처 4종으로 고정합니다.** 폰트 Pretendard·Noto Sans KR·JetBrains Mono(모두 SIL OFL 1.1), 아이콘 Lucide(ISC), 색 체계 Radix Colors(MIT) 12단계 스케일, 브레이크포인트 기준값은 Tailwind CSS 문서(MIT)의 `sm 640px`·`lg 1024px`를 차용합니다. 라이선스는 2026-11-07 저장소 LICENSE 원문으로 확인했습니다(§3).
3. **레이아웃은 3단(≥1024px) / 2단(641–1023px) / 1단(≤640px)** 입니다. 1단은 "공간 목록 → 본문 → 스레드 → 뒤로" 스택 내비게이션이고, 640px 경계는 PRD FR-CLIENT-02가 "디자인 가정"으로 넘긴 값을 이 문서가 확정 제안합니다(§5).
4. **컴포넌트 22개를 상태 매트릭스로 정의했습니다**(§6). 모든 컴포넌트는 기본·로딩·빈·오류·오프라인 5상태를 갖고, 메시지는 전송 중·저장 확인·실패·수정됨·삭제 자리표시자 5상태를 **색이 아닌 텍스트+아이콘**으로 표시합니다(FR-MSG-02·FR-CLIENT-07).
5. **접근성 목표는 WCAG 2.2 AA**(명도 대비 4.5:1, 비텍스트 3:1, 가시 포커스, 터치 목표 최소 24px·권장 44px)이고, **한글 IME는 `KeyboardEvent.isComposing` + `compositionend`** 로 Enter 전송을 막습니다(FR-MSG-08). 키보드 맵은 §7-3입니다.
6. **PWA 아이콘은 독자 제작 기하 심볼**이며 `#`·말풍선·격자 등 타사 메신저 연상 모티프를 피합니다. `any`·`maskable`·`monochrome` 3종 + `apple-touch-icon` 180px를 둡니다(§9).

영환님 결정 후보 5건은 §14에 있습니다. 가장 급한 것은 **액센트 색 계열**과 **다크 모드 MVP 포함 여부**입니다.

---

## 2. 클린룸 디자인 원칙

### 2-1. 원칙 5개

| # | 원칙 | 이유 |
|---|---|---|
| D1 | **참조 금지:** Slack(및 다른 상용 메신저)의 스크린샷·녹화·색상 추출·아이콘 트레이싱을 디자인 과정에 쓰지 않습니다. 참고는 "동작 수준의 일반 관념"(CLEANROOM 2-2)까지입니다. | T8 룩앤필·스크린샷 금지 |
| D2 | **출처 있는 토큰만:** 색·폰트·아이콘·사운드는 §3의 출처와 라이선스가 적힌 것만 씁니다. 토큰 파일의 각 항목에 `source`·`license` 필드를 둡니다. | CLEANROOM 4-2 |
| D3 | **상태는 텍스트로:** 전송·연결·오류 상태는 색만으로 구분하지 않고 텍스트 또는 아이콘+접근 가능한 이름을 함께 둡니다. | FR-CLIENT-07, WCAG 1.4.1 |
| D4 | **서버가 진실:** UI는 서버가 확정(`seq`·커밋 응답)하기 전 상태를 "성공"으로 그리지 않습니다. 낙관적 렌더는 "전송 중"으로만 표시합니다. | FR-MSG-02, PRD 원칙 2 |
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
| 문구·명칭 | "slack"이 들어간 앱 이름·manifest `name`·`short_name`·도메인 | 승인된 배포 이름(TRD 6절, 공개 전 개명 ADR) |

### 2-3. 기계 검증 (QA-FR-OPS-04 디자인 출처 검토용)

개발설계서 FR-OPS-04 행은 "디자인 출처 검토"를 수동 QA로 두었습니다. 아래를 그 체크리스트로 제안합니다.

1. `apps/web/src/ui/tokens.*`의 모든 색·폰트·아이콘 항목에 `source`·`license`가 있고 값이 §3 표의 URL과 일치한다.
2. 저장소 안 이미지·오디오 파일(`*.png|svg|ico|mp3|wav|ogg`)은 `apps/web/public/icons/`(독자 제작)와 `node_modules`(오픈 패키지) 밖에 없다.
3. 토큰에 쓰인 색상 중 **색상 280–330°, 명도 ≤ 35%, 채도 ≥ 40%** 인 값이 `surface`(면) 역할 토큰에 없다. (CLEANROOM 5절 grep은 문자열만 잡으므로 색 규칙은 토큰 린트로 보완)
4. `manifest.webmanifest`의 `name`·`short_name`에 `slack` 부분 문자열이 없다(대소문자 무시).
5. 디자인 산출물(Figma·이미지)이 저장소에 들어오면 PR 본문에 "참고 출처: 일반 관념 / <공개 문서 URL>" 한 줄이 있다(CLEANROOM 4-1).

---

## 3. 오픈 출처 디자인 토큰과 라이선스

### 3-1. 출처·라이선스 표 (2026-11-07 LICENSE 원문 직접 확인)

| 토큰 영역 | 선택 | 라이선스 | 확인한 원문 | 비고 |
|---|---|---|---|---|
| 본문 폰트(1차) | **Pretendard** | SIL OFL 1.1, Reserved Font Name "Pretendard" | `raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE` 14·20행 | 웹 임베드 허용. **이름 변경·개조 배포 금지**(RFN). 서브셋 빌드 시 파일명에 "Pretendard" 유지 |
| 본문 폰트(폴백) | **Noto Sans KR** (Noto Sans CJK) | SIL OFL 1.1 | `raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE` | Google Fonts 배포 가능. 로컬 미설치 시 시스템 폰트로 폴백 |
| 코드 폰트 | **JetBrains Mono** | SIL OFL 1.1 | `raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt` | 코드 블록·`client_message_id` 같은 식별자 표시용. 한글은 본문 폰트로 폴백 |
| 아이콘(1차) | **Lucide** | ISC | `raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE`, `lucide.dev/license` | 1,500+ 스트로크 아이콘(추정). 아래 §3-4 이름 사용 |
| 아이콘(대안) | Phosphor Icons / Tabler Icons | MIT / MIT | `phosphor-icons/core/main/LICENSE`, `tabler/tabler-icons/main/LICENSE` | Lucide에 없는 글리프가 필요할 때만. **세트 혼용은 화면당 1개 세트** |
| 색 체계 | **Radix Colors** | MIT | `raw.githubusercontent.com/radix-ui/colors/main/LICENSE` | 12단계 스케일, 라이트/다크 쌍, 단계별 용도 문서화(§3-3) |
| 색 체계(대안) | Open Color / Tailwind 색 팔레트 | MIT / MIT | `yeun/open-color/master/LICENSE`, `tailwindlabs/tailwindcss/main/LICENSE` | Radix로 부족할 때만 |
| 브레이크포인트 기준값 | Tailwind CSS 문서 `sm 40rem(640px)`·`lg 64rem(1024px)` | MIT(문서는 공개 기술 문서) | `tailwindcss.com/docs/responsive-design` | 값만 차용, 프레임워크 채택을 뜻하지 않음 |
| 이모지 | 시스템 네이티브(MVP) | — | — | v1 후보: Noto Color Emoji(OFL 1.1, `googlefonts/noto-emoji/main/LICENSE`), Fluent UI Emoji(MIT), Twemoji(그래픽 CC BY 4.0 → **표기 의무**, 비권장) |
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

- 모든 크기는 `rem`. 200% 확대(FR-CLIENT-07)에서 레이아웃이 깨지지 않도록 고정 `px` 높이 금지(아이콘·보더 제외).
- 한글 줄바꿈: 본문 `word-break: keep-all; overflow-wrap: anywhere;` — 한국어 단어 단위 줄바꿈(MDN `word-break` keep-all: CJK 텍스트에 단어 중간 줄바꿈 금지)과 긴 URL 넘침 방지를 함께 만족합니다.
- 숫자(배지·시간)는 `font-variant-numeric: tabular-nums`.
- Pretendard는 **서브셋 WOFF2를 자체 호스팅**합니다(tailnet 전용이라 외부 CDN 호출은 공인 인터넷 의존을 만듭니다). `font-display: swap`.

### 3-3. 색 토큰 — Radix Colors 12단계 역할 매핑

Radix 문서 기준 단계 용도: **1–2 앱 배경, 3–5 컴포넌트 배경(기본·hover·active), 6–8 보더, 9–10 솔리드(채움), 11–12 텍스트.** 라이트/다크는 같은 단계 번호로 자동 대응합니다.

| 역할 토큰 | 스케일·단계 | 용도 |
|---|---|---|
| `--bg-app` | neutral 1 | 본문 배경 |
| `--bg-sidebar` | neutral 2 | 사이드바·스레드 패널 배경(**유채색 금지**, §2-2) |
| `--bg-elevated` | neutral 3 | 입력창·카드·팝오버 |
| `--bg-hover` / `--bg-active` | neutral 4 / 5 | 목록 항목 hover·선택 |
| `--border-subtle` / `--border` | neutral 6 / 7 | 구분선 / 입력 테두리 |
| `--text-muted` / `--text` | neutral 11 / 12 | 메타 / 본문 |
| `--accent-solid` | accent 9 | 전송 버튼·선택 항목 표시선·링크 밑줄 |
| `--accent-text` | accent 11 | 링크·멘션 텍스트 |
| `--accent-bg` | accent 3 | 자기 멘션 하이라이트 배경 |
| `--success-text` | green 11 | "저장됨"(표시할 때만) |
| `--warning-bg` / `--warning-text` | amber 3 / 11 | 재연결 중 배너 |
| `--danger-text` / `--danger-solid` | red 11 / 9 | 전송 실패·연결 끊김·삭제 확인 |
| `--focus-ring` | accent 8 | 2px 포커스 링(WCAG 2.4.7) |

- **neutral 후보:** `slate`(권고, 차가운 중성) 또는 `sand`(따뜻한 중성). **accent 후보:** `teal`(권고)·`jade`·`indigo`. **배제:** `purple`·`plum`·`violet`을 면 배경으로 쓰는 것(§2-2). → 결정 후보 §14-1.
- 대비: Radix 문서는 step 11·12 텍스트가 step 1–2 배경에서 AA를 만족하도록 설계되었다고 설명합니다(추정: 우리 조합은 토큰 린트로 실측 — WCAG 1.4.3 4.5:1, 1.4.11 3:1).
- 다크 모드: `@media (prefers-color-scheme: dark)`로 같은 토큰 이름에 Radix dark 스케일을 매핑. MVP 포함 여부는 §14-2.

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
| 전송 중 | `clock` | ✅ |
| 저장 확인(선택적) | `check` | ✅ |
| 재연결 중 | `refresh-cw` | ✅ |
| 오프라인 | `wifi-off` | ✅ |
| 수정 / 삭제 | `pencil` / `trash` | ✅ (`trash-2`는 raw 경로 404 → `trash` 사용) |
| 더보기 | `ellipsis` | ✅ |
| 검색(P1)·설정·로그아웃·추가 | `search`·`settings`·`log-out`·`plus` | ✅ |
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

### 4-1. 개체 계층

```
워크스페이스(1개, 화면에 노출 안 함)
└─ 공간(space) ─ 채널(공개) | 1:1 DM
   └─ 메시지(원문, seq 순)
      └─ 스레드(1단 답글)
멘션: 메시지 → 나(배지 집계, 읽으면 해제)
읽음 커서: 공간별 1개 + 스레드별 1개 (서버 저장, 계정 단위)
```

### 4-2. 라우트 가정 (R3 정합 대상)

| 화면 | 경로(가정) | 비고 |
|---|---|---|
| 로그인 | `/login` | 세션 없으면 모든 경로가 여기로 |
| 초대 수락 | `/invite/:token` | 1회용·만료(FR-AUTH-01) |
| 공간 본문 | `/c/:conversationId` | 채널·DM 공통(TRD `conversation_id`) |
| 스레드 | `/c/:conversationId?thread=:messageId` | 3단에서는 패널, 1단에서는 별도 화면. **URL이 상태**라 새로고침·공유·뒤로가기가 일관 |
| 미읽음 점프 | `/c/:conversationId#m-:seq` | 새 메시지 구분선 위치 |
| 설정·세션(P1) | `/settings`, `/settings/sessions` | FR-AUTH-04 |
| 설치 안내 | `/install` | FR-CLIENT-03 "설치 안내와 일반 웹 접근 제공" |

### 4-3. 용어 (UI 문구 정본, 한국어)

| 개념 | UI 문구 | 피하는 표현 |
|---|---|---|
| space | **공간**(목록 제목), 개별은 **채널** / **DM** | "워크스페이스" 노출 |
| thread | **스레드**, 답글 수 "답글 3" | "댓글" |
| mention | **멘션**, 배지 "멘션 2" | "호출" |
| unread | **읽지 않음**, 구분선 "여기부터 새 메시지" | "미확인" |
| 전송 상태 | **전송 중** / (저장 확인 시 표시 없음) / **전송 실패 · 다시 시도** | "보냄", "성공" |
| 연결 상태 | **다시 연결 중…** / **연결이 끊겼습니다** / **최신 상태 확인 중…** | "오프라인 모드" |
| 수정·삭제 | "(수정됨)" / **삭제된 메시지입니다** | "메시지가 제거됨" |

---

## 5. 레이아웃

### 5-1. 브레이크포인트 (확정 제안)

| 이름 | 범위 | 단수 | 기준 |
|---|---|---|---|
| `compact` | **≤ 640px** | 1단 스택 | FR-CLIENT-02의 "≤ 640px 1단"을 그대로 채택. Tailwind `sm`=640px와 같은 값 |
| `medium` | 641–1023px | 2단 | iPad 세로·좁은 데스크톱 창 |
| `wide` | **≥ 1024px** | 3단 | Tailwind `lg`=1024px |
| 최소 지원 폭 | 320px | — | FR-CLIENT-02 수용 기준(320·390·640) |

CSS: `@media (max-width: 640px)` / `(min-width: 641px) and (max-width: 1023px)` / `(min-width: 1024px)`. 컴포넌트 테스트 `web/test/layout/responsive.test.tsx`(개발설계서 가정)는 이 3구간의 `matchMedia`를 검사합니다.

### 5-2. 3단 (wide ≥ 1024px)

```
┌─────────────┬──────────────────────────────┬────────────────┐
│ 사이드바     │ 본문                          │ 스레드 패널      │
│ 260px 고정   │ flex: 1 (min 480px)           │ 380px (열릴 때만)│
│ bg-sidebar  │ bg-app                        │ bg-sidebar      │
│             │ ┌ 대화 헤더 (56px) ───────────┐│ ┌ 스레드 헤더 ─┐ │
│ 공간 목록    │ │ 메시지 목록 (가상 스크롤)    ││ │ 원문          │ │
│ (채널/DM)   │ │  …                          ││ │ 답글 목록      │ │
│             │ │ 새 메시지 구분선             ││ │ 답글 작성기    │ │
│ 하단: 나/설정│ └ 작성기 (auto-grow ≤ 8줄) ──┘│ └──────────────┘ │
└─────────────┴──────────────────────────────┴────────────────┘
```

- 사이드바 폭은 `--sidebar-w: 260px`, 스레드 패널 `--thread-w: 380px`. 1280px 미만에서 스레드가 열리면 본문 최소폭 확보를 위해 사이드바를 **접힘(아이콘 72px)** 으로 전환할 수 있음(선택).
- 선택된 공간은 **왼쪽 3px 액센트 선 + bg-active**로 표시(면 전체 유채색 금지).

### 5-3. 2단 (medium 641–1023px)

- 사이드바 260px + 본문. 스레드는 **본문 위에 오버레이 시트(오른쪽에서 슬라이드, 폭 min(420px, 100%))** 로 열고, `Esc`·뒤로 버튼·바깥 클릭으로 닫습니다.
- 오버레이가 열린 동안 본문은 `inert`(포커스 트랩, WCAG 2.1.2 준수용 Esc 탈출 제공).

### 5-4. 1단 (compact ≤ 640px)

```
[공간 목록] ──탭──▶ [본문 + 작성기] ──답글──▶ [스레드 + 답글 작성기]
      ◀── 뒤로(헤더 chevron-left / 브라우저 back) ──
```

- 각 단계는 **라우트**(§4-2)라 브라우저 뒤로가기·PWA 스와이프백이 그대로 동작합니다.
- 본문 헤더: `[←] #채널명 [⋯]`. 작성기는 화면 하단 고정, `padding-bottom: env(safe-area-inset-bottom)`.
- 높이는 `100dvh`(MDN: 동적 뷰포트 단위)로 잡아 iOS Safari 툴바 변화에 대응. 가상 키보드가 올라올 때 입력창·전송 버튼이 가려지지 않아야 함(FR-CLIENT-02) — `VisualViewport` API로 `resize` 시 작성기 위치 보정. **확인 필요:** `<meta name="viewport" content="… interactive-widget=resizes-content">`는 MDN에 문서화되어 있으나 iOS Safari 지원은 이 세션에서 확인하지 않음.
- 가로 넘침 0: 모든 컨테이너 `min-width: 0`, 코드 블록은 `overflow-x: auto`.

---

## 6. 컴포넌트 목록과 상태

### 6-1. 공통 5상태 정의

| 상태 | 표시 규칙 |
|---|---|
| 기본 | 데이터 있음 |
| 로딩 | 스켈레톤(텍스트 줄 3개, `aria-busy="true"`). 스피너 단독 금지 |
| 빈 | 아이콘(Lucide, muted) + 1문장 + 가능하면 1개 행동 버튼 |
| 오류 | `circle`-류 경고 아이콘 + 원인 1문장 + **다시 시도** 버튼. `role="alert"` |
| 오프라인 | 상위 ConnectionBanner가 표시. 컴포넌트는 쓰기 동작을 **비활성화하지 않고** 시도 시 "연결이 끊겼습니다" 피드백(FR-MSG-02: 오프라인은 실패/재시도) |

### 6-2. 컴포넌트 표 (ID는 가정, 개발설계서 `apps/web/src/ui/` 기준)

| ID | 컴포넌트 | 역할 | 고유 상태 | 관련 FR |
|---|---|---|---|---|
| CMP-01 | `AppShell` | 3/2/1단 그리드, 라우트 아웃렛, 포커스 관리 | 브레이크포인트 3종 | CLIENT-01·02 |
| CMP-02 | `Sidebar` | 공간 목록 컨테이너, 하단 내 계정 | 접힘(72px)/펼침 | CLIENT-01 |
| CMP-03 | `SpaceList` / `SpaceListItem` | 채널·DM 항목. 이름, 읽지 않음 **굵게**, 멘션 수 배지 | 선택됨 / 읽지 않음 / 멘션 n / 나간 채널(muted) | SYNC-03·04·05, CONV-02 |
| CMP-04 | `UnreadBadge` | 숫자 배지(멘션 수). 99+ 상한 | 0이면 렌더 안 함. `aria-label="멘션 2개"` | MSG-07, SYNC-04 |
| CMP-05 | `ConversationHeader` | 공간 이름·멤버 수·뒤로(compact)·더보기 | compact 뒤로 버튼 노출 | CLIENT-02 |
| CMP-06 | `MessageList` | 가상 스크롤, 이전 페이지 로드, 하단 고정 | 로딩(위쪽 스켈레톤) / 빈("첫 메시지를 남겨 보세요") / 더 불러오기 오류 | MSG-04 |
| CMP-07 | `MessageItem` | 아바타(이니셜)·작성자·시간·본문·스레드 요약·액션 | **전송 중 / 저장 확인 / 실패 / 수정됨 / 삭제 자리표시자 / 자기 멘션 하이라이트** (§6-3) | MSG-02·05·06·07 |
| CMP-08 | `MessageBody` | 텍스트·줄바꿈·안전 링크·코드 블록 렌더. HTML 미실행 | 링크 `rel="noopener noreferrer"`, `javascript:` 등 위험 스킴은 **일반 텍스트로** | MSG-01 |
| CMP-09 | `NewMessagesDivider` | "여기부터 새 메시지" 선. 커서 위치에 1개 | 보이면 스크롤 앵커 | SYNC-03 |
| CMP-10 | `DateSeparator` | 날짜 구분(오늘/어제/YYYY-MM-DD) | — | — |
| CMP-11 | `Composer` | 멀티라인 입력, IME 안전 Enter, 멘션 트리거 `@`, 전송 버튼 | 비어 있음(전송 비활성) / 입력 중 / 조합 중(`isComposing`) / 전송 중(입력 유지, 재전송 금지) / 상한 초과 경고 | MSG-01·03·08 |
| CMP-12 | `MentionPicker` | `@` 입력 시 참여자 콤보박스(APG combobox 패턴) | 결과 없음 / 선택됨 → `@이름` 칩 | MSG-07 |
| CMP-13 | `ThreadPanel` | 원문 + 답글 목록 + 답글 작성기 | 원문 삭제됨(자리표시자 유지, 답글 열람 가능) / 로딩 / 빈("첫 답글") | MSG-06 |
| CMP-14 | `ThreadSummary` | 원문 아래 "답글 3 · 마지막 답글 5분 전" 버튼 | 읽지 않은 답글 있음(점 표시 + 텍스트 "새 답글") | SYNC-03 |
| CMP-15 | `ConnectionBanner` | 상단 고정 상태 띠. `role="status"` `aria-live="polite"` | **연결됨(숨김) / 다시 연결 중… / 연결이 끊겼습니다 / 최신 상태 확인 중…** (§6-4) | SYNC-07, CLIENT-04 |
| CMP-16 | `StatusRegion` | 시각적으로 숨긴 `aria-live` 영역. 전송 실패·스레드 열림 등 안내 | — | CLIENT-07 (WCAG 4.1.3) |
| CMP-17 | `EmptyState` / `ErrorState` / `Skeleton` | 공통 5상태 프리미티브 | — | — |
| CMP-18 | `Dialog` | 채널 만들기·초대 링크·삭제 확인. APG modal dialog | 열림/닫힘, 닫히면 트리거로 포커스 복귀 | CONV-01, AUTH-01, MSG-05 |
| CMP-19 | `LoginForm` / `InviteAccept` | 이메일·비밀번호, 초대 토큰 수락 | 오류(자격 증명 오류는 **구체 원인 미노출**) / 제한(시도 초과) | AUTH-01·02·06 |
| CMP-20 | `InstallHint` | PWA 설치 안내(iOS: 공유 → 홈 화면에 추가) | standalone이면 숨김(`display-mode: standalone` 미디어 쿼리) | CLIENT-03 |
| CMP-21 | `Avatar` | 이니셜 원형(이미지 업로드는 P1). 색은 neutral 5 고정(사용자별 색 해시 없음) | — | — |
| CMP-22 | `SessionList`(P1) | 기기별 세션·원격 로그아웃 | — | AUTH-04 |

### 6-3. 메시지 전송 상태 매트릭스 (FR-MSG-02 정본)

| 상태 | 트리거 | 시각 | 텍스트/접근성 | 허용 동작 |
|---|---|---|---|---|
| 전송 중 | 작성기 전송 → 서버 응답 전 | 본문 투명도 0.6, 시간 자리에 `clock` 아이콘 | "전송 중" (`aria-label`) | 없음(수정·삭제·답글 비활성). **자동 재전송 큐 없음** |
| 저장 확인 | HTTP 응답에 `seq`·`message_id` 도착 | 일반 렌더. 성공 아이콘은 **기본 비표시**(소음 방지) | StatusRegion에 안내 없음 | 모두 |
| 실패 | 응답 오류·타임아웃·오프라인 | 왼쪽 2px `danger-solid` 선, 시간 자리에 경고 아이콘 | "**전송 실패 · 다시 시도**" 버튼 + "삭제" 버튼. `role="alert"` 1회 | 다시 시도(같은 `client_message_id`), 삭제(로컬) |
| 수정됨 | `edited_at` 존재 | 본문 뒤 "(수정됨)" muted | 시간 툴팁에 수정 시각 | 모두 |
| 삭제 자리표시자 | `deleted_at` 존재 | 이탤릭 muted "삭제된 메시지입니다", 자리 유지 | 답글 수가 있으면 ThreadSummary 유지 | 스레드 열기만 |
| 자기 멘션 | `message_mentions`에 나 포함(가정) | 배경 `accent-bg`, 왼쪽 선 `accent-solid` | 멘션 텍스트 `@이름`은 `accent-text` | 모두 |

### 6-4. 연결 상태 매트릭스 (FR-SYNC-07·FR-CLIENT-04)

| 상태 | 조건 | ConnectionBanner | 작성기 |
|---|---|---|---|
| 연결됨 | WS open, 커서 일치 | 숨김 | 정상 |
| 다시 연결 중… | WS close 후 재시도 중(지수 백오프) | `warning-bg`, `refresh-cw` 회전(모션 축소 시 정지) | 입력 가능, 전송 시도 → 즉시 "실패" 상태로 |
| 연결이 끊겼습니다 | `navigator.onLine === false` 또는 재시도 n회 초과 | `danger`, `wifi-off`, "보낸 메시지는 저장되지 않았습니다" | 동일 |
| 최신 상태 확인 중… | 전경 복귀·재연결 직후 `/api/sync` 재생 중(TRD 5절) | neutral, "최신 상태 확인 중…" | **본문은 흐리게(stale) 표시**, 완료 전 새 메시지 성공 표시 보류 |

---

## 7. 접근성·키보드·한글 IME

### 7-1. 목표 기준 (WCAG 2.2 AA, 원문 확인 항목)

| SC | 요구 | 우리 규칙 |
|---|---|---|
| 1.4.3 Contrast (Minimum) | 텍스트 4.5:1 | 토큰 린트로 실측. muted 텍스트도 4.5:1 이상(step 11) |
| 1.4.11 Non-text Contrast | UI 요소·포커스 링 3:1 | 보더 step 7 이상, 포커스 링 step 8 |
| 1.4.4 Resize Text | 200% | `rem` 단위, 고정 높이 금지(§3-2) |
| 2.1.1 / 2.1.2 Keyboard, No Trap | 모든 기능 키보드 조작, 트랩 없음 | §7-3 키맵, 오버레이는 Esc 탈출 |
| 2.4.3 Focus Order | 논리 순서 | DOM 순서 = 시각 순서. 사이드바 → 헤더 → 목록 → 작성기 → 스레드 |
| 2.4.7 / 2.4.11 Focus Visible / Not Obscured | 가시 포커스, 가려지지 않음 | 2px 링 + 2px 오프셋. 고정 배너·작성기가 포커스 요소를 가리면 `scroll-margin` |
| 2.5.8 Target Size (Minimum) | **24×24 CSS px** 이상 | 모든 터치 목표 **44×44px**(Apple HIG 권장값으로 기억하나 이 세션에서 HIG 원문 미확인 → 추정). 최소 24px는 하드 룰 |
| 4.1.3 Status Messages | 상태 변화는 포커스 이동 없이 전달 | StatusRegion(`aria-live="polite"`), 실패는 `role="alert"` |

### 7-2. ARIA 구조

- `MessageList`: `role="list"`, 각 메시지 `role="listitem"`에 `aria-label="홍길동, 오후 3:12"` + 본문. **새 메시지 알림은 목록이 아니라 StatusRegion**이 "새 메시지 1개" 식으로 묶어 전달(과다 알림 방지). `role="log"`(MDN)는 대안이며 R3에서 Developer와 확정.
- `Sidebar` 공간 목록: `nav aria-label="공간"` > `ul`. 선택 항목 `aria-current="page"`.
- `ThreadPanel`(wide): `aside aria-label="스레드"`; (medium/compact): `role="dialog"` 또는 별도 라우트 페이지.
- `MentionPicker`: APG combobox(`role="combobox"` + `aria-expanded` + `listbox`).
- `Dialog`: APG modal dialog, 닫힘 시 트리거 포커스 복귀.
- `UnreadBadge`: 숫자만 보이되 `aria-label="멘션 2개"`.

### 7-3. 키보드 맵 (FR-CLIENT-01 수용 기준 정본)

| 키 | 동작 | 포커스 결과 |
|---|---|---|
| `Ctrl/⌘+K` | 공간 전환기(콤보박스) 열기 | 입력란 |
| `Alt+↑ / Alt+↓` | 이전/다음 공간 | 작성기 |
| `Alt+Shift+↑ / ↓` | 읽지 않은 공간만 이동 | 작성기 |
| `Enter` (작성기) | 전송(**조합 중이면 무시**) | 작성기 유지 |
| `Shift+Enter` | 줄바꿈 | — |
| `Esc` (작성기 비어 있음) | 스레드 패널 닫기 | **원문 메시지의 "답글" 버튼**(FR-CLIENT-07 "원래 항목에 포커스 복귀") |
| `Esc` (작성기 입력 있음) | 입력 유지, 아무 동작 없음(실수 방지) | — |
| `↑` (작성기 비어 있음) | 내 마지막 메시지 수정(P1 후보) | 인라인 편집기 |
| `Tab` / `Shift+Tab` | 영역 간 이동. 메시지 목록 안에서는 **메시지 단위**로 이동(roving tabindex) | — |
| 메시지에서 `R` / `E` / `Delete` | 답글 / 수정(내 것) / 삭제(내 것, 확인 다이얼로그) | 스레드 작성기 / 편집기 / 다이얼로그 |
| `Ctrl/⌘+/` | 키보드 단축키 안내 다이얼로그 | 다이얼로그 |

- 단축키는 **입력 중이 아닐 때만**(작성기 포커스 시 단일 글자 단축키 비활성).
- 모바일(compact)에서는 키맵 대신 보이는 버튼(뒤로·답글·더보기)으로 같은 기능 제공.

### 7-4. 한글 IME 규칙 (FR-MSG-08 정본)

1. `keydown` 핸들러에서 `event.isComposing === true`이면 **아무것도 하지 않습니다**(MDN: 조합 세션 안에서 발생한 이벤트인지 나타내는 읽기 전용 속성).
2. Safari 보강: `event.keyCode === 229`이면 조합 중으로 간주합니다. (추정: 일부 Safari 버전은 조합 확정 Enter에서 `isComposing=false`인데 `keyCode=229`를 보냅니다. jsdom 테스트는 두 경로를 모두 재현해야 합니다 — 개발설계서 `composer-ime.test.tsx`의 "isComposing·keyCode 229" 가정과 일치.)
3. `compositionend` 직후 같은 틱에 들어오는 Enter는 **전송하지 않고 1회 무시**(마지막 글자 확정용 Enter). 확정 후 두 번째 Enter만 전송. → 수용 기준 "조합 Enter 미전송·확정 후 Enter 1회 전송".
4. `Shift+Enter`는 조합 여부와 무관하게 줄바꿈.
5. 전송 후 작성기를 비울 때 `compositionstart` 중이면 **비우기를 `compositionend` 이후로 미룹니다**(조합 중 DOM 변경은 iOS에서 글자 중복을 만듭니다 — 추정, 실기기 QA-FR-MSG-08로 검증).
6. 멘션 트리거 `@`는 조합 중이 아닐 때만 콤보박스를 열고, 한글 이름 검색은 `compositionupdate` 텍스트도 포함해 매칭(초성 검색은 P1).
7. 실기기 검증 매트릭스: macOS 두벌식 + Safari/Chrome, iOS 한국어 키보드 + Safari(홈 화면 PWA 포함). 자동 테스트만으로 통과 선언하지 않습니다(개발설계서 R1 181행과 동일 입장).

### 7-5. 그 외

- `prefers-reduced-motion: reduce`에서 모든 트랜지션 0ms(§3-5).
- `prefers-color-scheme`에 따라 라이트/다크 자동. 수동 토글은 P1.
- 언어: `<html lang="ko">`. 날짜·시간은 `Intl.DateTimeFormat('ko-KR')`.
- 이미지(아바타 이니셜)는 `alt` 대신 `aria-label` 이름.

---

## 8. 반응형 보강 규칙

| 항목 | compact(≤640) | medium(641–1023) | wide(≥1024) |
|---|---|---|---|
| 사이드바 | 별도 화면(라우트 `/`) | 260px 고정 | 260px 고정(스레드 열리면 72px 접힘 선택) |
| 스레드 | 별도 화면 | 오버레이 시트 | 우측 패널 380px |
| 작성기 | 하단 고정 + safe-area | 본문 하단 | 본문 하단 |
| 메시지 액션(답글·수정·삭제) | 길게 누르기 → 액션 시트(`Dialog`) | hover/포커스 시 인라인 툴바 | 동일 |
| 헤더 | 뒤로 + 제목 + 더보기 | 제목 + 멤버 수 + 더보기 | 동일 |
| 타임스탬프 | 메시지 아래 `text-xs` | 작성자 옆 | 작성자 옆 |
| 가상 키보드 | `VisualViewport` 보정 | — | — |

- 세로 높이: `height: 100dvh` 기본, 미지원 브라우저 폴백 `100vh`(추정: iOS 15.4 이상 `dvh` 지원 — 이 세션 미확인).
- 가로 320px: 사이드바 화면에서 공간 이름 말줄임(`text-overflow: ellipsis`), 배지는 유지.

---

## 9. PWA 아이콘·manifest 디자인 원칙 (FR-CLIENT-03)

### 9-1. 심볼 원칙

1. **독자 제작 기하 심볼** 1개. 후보 모티프: "두 개의 겹친 원호(대화의 왕복)", "오프셋된 두 사각 모서리(동기화된 기기)". `#`·말풍선·격자·4색 바람개비·모노그램 S는 **배제**.
2. 단색 1 + 중성 배경 1로 구성(액센트 step 9 위에 흰 심볼, 또는 그 반전). 그라데이션·그림자 없음(maskable 원형 크롭에서 안전).
3. 심볼은 SVG 원본을 저장소 `apps/web/public/icons/source.svg`에 두고, PR 본문에 "독자 제작, 참고 출처 없음"을 기록(CLEANROOM 4-1).

### 9-2. 산출물 세트

| 파일 | 크기 | `purpose` | 비고 |
|---|---|---|---|
| `icon-192.png`, `icon-512.png` | 192·512 | `any` | 투명 배경 허용 |
| `icon-maskable-512.png` | 512 | `maskable` | 심볼을 **중앙 안전 영역** 안에(web.dev: 모든 플랫폼이 존중하는 표준 "minimum safe zone"이 있음 — 지름의 80% 원 안으로 설계하는 것이 통례, 추정). Chrome DevTools로 안전 영역 확인 |
| `icon-mono.svg` 또는 `icon-mono-512.png` | 512 | `monochrome` | 배지·고정 아이콘용 단색(MDN: 솔리드 채움 배지로 쓰일 수 있음) |
| `apple-touch-icon.png` | **180×180** | — | `<link rel="apple-touch-icon" sizes="180x180">`(Apple 문서). **불투명 배경**(추정: iOS는 투명 영역을 검게 채움) |
| `favicon.svg` + `favicon.ico`(32) | — | — | 브라우저 탭 |

### 9-3. manifest 필드 (TRD 6절과 정합 가정)

```json
{
  "name": "<승인된 배포 이름>",
  "short_name": "<12자 이내>",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "<neutral step 1 라이트 값>",
  "theme_color": "<neutral step 2 값>",
  "lang": "ko",
  "icons": [ "...§9-2..." ]
}
```

- `name`·`short_name`에 "slack" 금지(§2-3-4). 개명 전까지 내부 빌드는 임시 중립 이름을 씁니다.
- `theme_color`는 **유채색이 아닌 중성**(§2-2 색 원칙 일관). 다크 모드 대응은 `<meta name="theme-color" media="(prefers-color-scheme: dark)">` 추가.
- iOS: `<meta name="apple-mobile-web-app-capable" content="yes">`(Apple 문서), 상태 표시줄 `apple-mobile-web-app-status-bar-style`은 `default`(black-translucent는 safe-area 처리 부담).
- 스플래시: iOS는 `background_color`+아이콘으로 자동 생성하지 않을 수 있어 **MVP는 스플래시 이미지 미제공**(확인 필요).
- SW 캐시 범위는 TRD(해시된 앱 셸만, `/api/**`·WS 제외)와 개발설계서 B7을 따르며 이 문서는 아이콘·셸 외관만 다룹니다.

---

## 10. 화면 목록 (W-04 handoff 단위)

| # | 화면 | 포함 컴포넌트 | 상태 수 |
|---|---|---|---|
| SCR-01 | 로그인 | CMP-19 | 기본·오류·제한 |
| SCR-02 | 초대 수락 | CMP-19 | 유효·만료·사용됨 |
| SCR-03 | 공간 목록(compact 전용 화면 / wide 사이드바) | CMP-02·03·04 | 로딩·빈("채널이 없습니다 — 관리자만 생성")·기본 |
| SCR-04 | 대화 본문 | CMP-05~12·15·16 | 로딩·빈·기본·오프라인·재동기화 |
| SCR-05 | 스레드 | CMP-13·14·11 | 로딩·빈·원문 삭제됨 |
| SCR-06 | 채널 만들기 / 초대 링크 / 삭제 확인 | CMP-18 | 기본·오류(중복 이름) |
| SCR-07 | 설치 안내 | CMP-20 | iOS·macOS 분기, standalone 숨김 |
| SCR-08 | 설정·세션(P1) | CMP-22 | — |
| SCR-09 | 키보드 단축키 안내 | CMP-18 | — |

---

## 11. 디자인 QA 체크리스트 (단계 게이트 G1 제안)

1. 320·390·640·768·1024·1440px에서 가로 스크롤 0, 작성기·전송 버튼 가림 0.
2. 200% 확대에서 SCR-04 모든 조작 가능.
3. 키보드만으로 §7-3 전 항목 수행, Esc 후 포커스가 원문 "답글" 버튼으로 복귀.
4. 전송 실패·연결 끊김이 **색을 빼고도**(그레이스케일 필터) 구분됨.
5. 토큰 린트: 대비 4.5:1/3:1 통과, §2-3-3 색 규칙 위반 0.
6. macOS·iOS 한국어 입력 §7-4 매트릭스 통과(수동).
7. `manifest`·아이콘 세트 §9-2 완비, `short_name`에 금지어 0.
8. 저장소 내 이미지·오디오 파일이 §2-3-2 경로 밖에 0개.

---

## 12. 사실 / 추정 / 확인 필요

**사실 (2026-11-07 원문·응답 확인)**
- 라이선스: Pretendard·Inter·JetBrains Mono·Noto Sans CJK·Noto Color Emoji = SIL OFL 1.1 / Lucide = ISC / Phosphor·Tabler·Radix Colors·Open Color·Tailwind CSS·Fluent UI Emoji = MIT / Twemoji 그래픽 = CC BY 4.0 (각 저장소 LICENSE 파일 머리 확인).
- Tailwind 문서 브레이크포인트 `sm 40rem(640px)`, `md 48rem(768px)`, `lg 64rem(1024px)`.
- Radix Colors 문서: step 1–2 앱 배경, 9–10 솔리드, 11–12 텍스트.
- WCAG 2.2 SC 1.4.3·1.4.11·1.4.4·2.1.1·2.1.2·2.4.3·2.4.7·2.4.11·2.5.8·4.1.3 존재. 2.5.8 최소 24×24 CSS px, 1.4.3 최소 4.5:1.
- MDN: `KeyboardEvent.isComposing`은 조합 세션 안 이벤트인지 나타내는 읽기 전용 속성; `compositionend`는 IME가 조합을 완료·취소할 때 발생; manifest `display: standalone`; icons `purpose`에 `maskable`·`monochrome`; `env(safe-area-inset-bottom)`; `dvh`; `word-break: keep-all`.
- Apple 문서: `apple-touch-icon` PNG, `sizes="180x180"`, `apple-mobile-web-app-capable`.
- web.dev: maskable 아이콘에 모든 플랫폼이 존중하는 표준 "minimum safe zone"이 있고 Chrome DevTools로 확인 가능.
- Lucide raw 경로에서 `hash`·`lock`·`message-square`·`at-sign`·`send`·`corner-up-left`·`reply`·`x`·`chevron-left`·`wifi-off`·`refresh-cw`·`check`·`clock`·`pencil`·`trash`·`ellipsis`·`search`·`settings`·`log-out`·`plus`·`user`·`smartphone` 존재(200).

**추정**
- Pretendard의 한글 글리프 범위(README 미확인) — 서브셋 빌드 시 확인.
- Radix 11·12 단계가 1–2 배경에서 AA를 만족한다는 설계 의도 — 우리 조합은 린트로 실측.
- 44×44px 터치 목표가 Apple HIG 권장값 — HIG 페이지가 JS 렌더라 원문 미확인.
- maskable 안전 영역 = 지름 80% 원; iOS가 `apple-touch-icon` 투명 영역을 검게 채움; `dvh` iOS 지원 버전; Safari `keyCode 229` 동작; 조합 중 DOM 변경 시 iOS 글자 중복.
- "짙은 자주 사이드바"가 트레이드 드레스의 핵심 요소라는 판단 — 1차 A T8 "color combinations" 문구에 근거한 보수적 회피이며 법률 판정이 아님.

**확인 필요**
- Lucide 경고 아이콘 실제 이름(`circle-alert` 류 raw 404) — 패키지 설치 후 확인.
- `interactive-widget=resizes-content`의 iOS Safari 지원.
- iOS 홈 화면 PWA의 스플래시 생성 규칙.
- TRD의 `conversation_id`·`message_mentions`·`read.updated` 등 이름을 UI 상태에 그대로 쓸지(§13).

---

## 13. 다른 문서와의 정합 가정 (R3 대상)

| # | 가정 | 상대 문서 | 맞출 것 |
|---|---|---|---|
| A1 | 브레이크포인트 640/1024, 이름 `compact/medium/wide` | PRD FR-CLIENT-02("640px은 디자인 가정"), 개발설계서 A5·`responsive.test.tsx` | PRD 수용 기준을 "≤640 1단, 641–1023 2단, ≥1024 3단"으로 확정 |
| A2 | 컴포넌트 ID `CMP-nn`·이름(§6-2), 위치 `apps/web/src/ui/` | 개발설계서 50행·W-04·A5 | 테스트 파일명(`layout/keyboard`, `layout/responsive`, `conversation/composer-ime`, `conversation/send-state`, `a11y/labels`)을 CMP 이름과 대응 |
| A3 | 전송 상태 5종·연결 상태 4종 문구(§4-3·§6-3·§6-4) | PRD FR-MSG-02·FR-SYNC-07·FR-CLIENT-04·FR-CLIENT-07 | PRD 수용 기준의 "연결 끊김·재시도 표시" 문구를 이 표로 |
| A4 | Esc 포커스 복귀 대상 = 원문의 "답글" 버튼 | PRD FR-CLIENT-07 "원래 항목" | 문구 통일 |
| A5 | 라우트 `/c/:conversationId?thread=…` | TRD HTTP 경로·`conversation_id` 명 | TRD가 `channel_id`를 쓰면 라우트도 따라감 |
| A6 | IME 처리 = `isComposing` + `keyCode 229` + `compositionend` 후 1회 무시 | 개발설계서 FR-MSG-08 행 | 테스트 케이스 3종 반영 |
| A7 | manifest `theme_color`=중성, 아이콘 4종, `name`에 금지어 없음 | TRD 6절(192/512 독자 아이콘) | TRD에 `maskable`·`monochrome`·`apple-touch-icon` 180 추가 |
| A8 | 자기 멘션 하이라이트 데이터원 = `message_mentions`(TRD) | TRD 데이터 모델 | 이벤트에 멘션 배열 포함 여부 |
| A9 | 디자인 출처 검토 = §2-3 체크리스트 | 개발설계서 QA-FR-OPS-04 | 체크리스트 채택 |
| A10 | 사운드·이모지 이미지 미동봉 | CLEANROOM 3-2 | 유지 |

---

## 14. 영환님 결정 후보 (위험·영향 순)

1. **액센트 색 계열:** `teal`(권고) / `jade` / `indigo`. 중성은 `slate`(권고) / `sand`. 자주·포도 계열은 면 배경 배제(§2-2).
2. **다크 모드 MVP 포함:** 포함(권고 — Radix 쌍 스케일이라 토큰 비용이 작고 휴대폰 야간 사용에 유리) / P1로 미룸.
3. **본문 폰트:** Pretendard 자체 호스팅(권고) / 시스템 폰트 스택만(에셋 0, 기기별 외형 차이 감수).
4. **아이콘 세트:** Lucide 단일(권고) / Phosphor.
5. **앱 심볼 모티프와 임시 중립 이름:** §9-1 후보 2개 중 선택, 또는 개명 ADR(`docs/decisions/`)과 함께 결정. 공개 계획이 없더라도 manifest `name`은 지금 중립으로.

---

## 15. 출처 원장 (모두 2026-11-07 조회, robots.txt 허용 경로)

- 라이선스 원문: https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE · https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE · https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt · https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE · https://lucide.dev/license · https://raw.githubusercontent.com/phosphor-icons/core/main/LICENSE · https://raw.githubusercontent.com/tabler/tabler-icons/main/LICENSE · https://raw.githubusercontent.com/radix-ui/colors/main/LICENSE · https://raw.githubusercontent.com/yeun/open-color/master/LICENSE · https://raw.githubusercontent.com/tailwindlabs/tailwindcss/main/LICENSE · https://raw.githubusercontent.com/googlefonts/noto-emoji/main/LICENSE · https://raw.githubusercontent.com/jdecked/twemoji/main/LICENSE-GRAPHICS · https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/LICENSE
- OFL 설명: https://openfontlicense.org/
- 색 체계: https://www.radix-ui.com/colors · https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale · https://www.radix-ui.com/colors/docs/palette-composition/scales
- 브레이크포인트: https://tailwindcss.com/docs/responsive-design
- 접근성: https://www.w3.org/TR/WCAG22/ · https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html · https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html · https://www.w3.org/WAI/ARIA/apg/patterns/combobox/ · https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/ · https://www.w3.org/WAI/ARIA/apg/patterns/feed/ · https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role · https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live
- IME: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing · https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event
- 반응형·뷰포트: https://developer.mozilla.org/en-US/docs/Web/CSS/length (dvh) · https://developer.mozilla.org/en-US/docs/Web/CSS/env · https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport · https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport · https://developer.mozilla.org/en-US/docs/Web/CSS/word-break · https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion · https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme
- PWA: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest · https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display · https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons · https://web.dev/articles/maskable-icon · https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
- 트레이드 드레스 조항: `docs/00-research/buzz/Claude-Fable.md` T8 (https://slack.com/terms-of-service/slack-brand — 이번 세션 재조회 안 함)

---

## 16. 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| R1 초안 v0.1 | 2026-11-07 | 최초 작성. PRD v1.1·TRD R1·개발설계서 R1을 읽고 FR·테스트명·이벤트명과 정합 가정 10건 명시 |
