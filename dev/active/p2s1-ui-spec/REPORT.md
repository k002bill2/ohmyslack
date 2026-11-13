# REPORT — p2s1-ui-spec (ADR-002 1단계 1b·1c 화면 명세)

- 역할: Designer / 기준 main `d89cfe9` / 작성 2026-11-13
- 참고 출처: 일반 관념(팀 메신저의 파일 첨부·기기 세션 관리), 저장소 정본. 상용 메신저 화면·스크린샷·에셋 미참조(`CLEANROOM.md`).
- 결과: 명세 문서만 수정했습니다. 코드·목업·서버·DB·`.env*`·PRD·TRD·보안 문서는 손대지 않았습니다.

## 0. 바꾼 파일

| 파일 | 위치 | 내용 |
|---|---|---|
| `docs/07-ui-spec/UI_STATES.md` | §1 표 CMP-22·CMP-32 행(:45, :54) | CMP-22 구체화, CMP-32 신설, CMP-31 비워 둠 |
| | §2-13 (:354) | 문서 첨부: 작성기 문서 칩 9상태 + 메시지 문서 행 4상태, 말줄임·전체 이름 접근, 폭 배치 |
| | §2-14 (:392) | 로그인한 기기: 진입·정렬·13상태(Dialog busy 포함), 포커스 복귀 |
| | 기타 | §2-5 첨부 행, §2-6 칩 표 뒤 연결, §2-8 Dialog 용도 추가, §2-10 CMP-22, §7 FR 매핑 2행, §8-2 Q-H2·Q-H3 문서 부분 종결 |
| `docs/07-ui-spec/COPY_GAPS.md` | §14 (:609) G-53–G-62 | 문서 첨부 문구 10항목(재사용 3항목) |
| | §15 (:688) G-63–G-72 | 로그인한 기기 문구 10항목(재사용 1항목) |
| | §8 | G-53–G-72는 모두 ★라 결정 필요 목록 추가 없음 |
| `docs/05-design-ref/DESIGN_REFERENCE.md` | §6-5 (:376), §6-6 (:403) | 문서 행·세션 목록의 토큰·간격·포커스·44px·폭별 배치(기존 토큰만) |
| | 기타 | §3-4 아이콘 4개, §4-2 라우트, §4-3 용어 2행, §6-2 CMP-18·22·32, §10-1 SCR-08, §11-1 폭 834 추가, §16 R3.4 |

## ① ★결정 표

선택 규칙: 브리프·영환님 지시대로 묻지 않고 ★로 진행했습니다. 모두 사후에 조정할 수 있습니다.

| ID | 결정 | ★ 선택 | 사유 | 대안 |
|---|---|---|---|---|
| UI-D1 | 컴포넌트 ID | 문서 = **CMP-32** `DocumentAttachment`. CMP-31은 2단계 `ProcessingStatus` 자리로 비움. 세션은 기존 **CMP-22**를 구체화(Fable 후보 CMP-33 미채택) | grep 결과 CMP-31 이상은 사용처 0. Fable §5-1 후보 번호와 충돌 회피 | CMP-31을 문서에 쓰기 |
| UI-D2 | 첨부 버튼 | 버튼 1개 「파일 첨부」, `accept` = 이미지 3종 + 문서 확장자 | compact 작성기 줄에 44px 버튼을 늘리지 않음 | 이미지·문서 버튼 2개 |
| UI-D3 | 업로드 진행 표시 | **비결정형 진행 + 파일 크기**(퍼센트 없음), `fetch` 유지 | 현재 업로드는 `fetch` 원시 바이트(`api.ts:155`)라 업로드 진행 이벤트가 없음. XHR 전환은 데이터 계층 변경 | XHR 전환 후 퍼센트 막대 |
| UI-D4 | 업로드 시간 상한 | 원시 바이트 업로드의 **20초 상한 면제를 유지**(PR #31 C1, 55ac812). 칩에 「시간 초과」 상태 없음. 세션 목록·원격 로그아웃 요청은 20초 상한 적용 → 시간 초과 상태 있음 | 5 Mbps 회선에서 25 MiB는 약 42초(산술 추정)라 20초 상한이면 정상 업로드가 실패함 | 업로드 전용 상한(예: 120초) 신설 |
| UI-D5 | 다운로드 방식 | `<a href="/api/attachments/{id}" download>` 일반 링크. 「받는 중…」·「받기 실패」 상태 없음 | 25 MiB를 JS 메모리(blob)에 올리지 않음. B7(본문 지속 저장 금지)와 무관하게 단순. 서버 `Content-Disposition: attachment`가 저장을 결정 | Fable §5-2의 fetch + blob + 상태 표시 |
| UI-D6 | 크기 문구 | 형식별 문구: 문서 「(최대 25MB)」, 이미지 기존 「(최대 10MB)」. 표기는 기존과 같이 MB(값은 MiB) | 기존 문구 구조 재사용, compact 칩 한 줄 | 두 상한을 한 문장으로 |
| UI-D7 | 매크로 확장자 불일치 415 | 전용 문구 G-56 + 서버 오류 코드 `macro_extension_mismatch` 구분 제안(④). 코드가 없으면 일반 형식 문구 | 일반 형식 문구로는 사용자가 원인을 모름 | 구분 없음 |
| UI-D8 | 문서만 보낼 때 본문 | 「[문서]」 | 기존 「[이미지]」와 같은 형식, 파일명 중복 표시 회피 | 파일명을 본문으로 |
| UI-D9 | 봇·사람 문서 표시 | 같은 행. 구분은 작성자 옆 CMP-26 배지뿐 | 브리프 요구, 색 외 구분 원칙 | 봇 문서 카드 별도 |
| UI-D10 | 세션 화면 진입 | 사이드바 계정 카드 아이콘 버튼 「로그인한 기기」(`smartphone`, 「로그아웃」 옆, 모든 역할) → `/settings/sessions` 라우트 화면(모든 구간). `/settings` 셸은 이번에 만들지 않음 | 현재 `/settings` 라우트가 없고(`apps/web/src/app/route.ts:18-25`) 계정 기능이 사이드바 카드에 모여 있음 | `/settings` 셸 먼저 구현 |
| UI-D11 | 「다른 기기 모두 로그아웃」 | **넣지 않음**. 개별 로그아웃만 | 1인 사용·기기 2–4대 추정. 일괄 라우트를 추가하면 계약 면이 늘고, 없이 N회 호출하면 부분 실패 상태를 명세해야 함 | 일괄 라우트 `DELETE /api/sessions?scope=others` 추가 |
| UI-D12 | 이 기기 행 동작 | 「이 기기에서 로그아웃」 = 기존 사이드바 로그아웃과 같음(확인 없음, `POST /api/auth/logout`) | 같은 동작을 두 방식으로 만들지 않음 | 확인 Dialog 추가 |
| UI-D13 | 라벨 없는 세션 | 「알 수 없는 기기」, 동명 행은 접근 이름에 마지막 사용 시각 추가 | 라벨 컬럼 도입 전 세션 존재 | 「이전 로그인」 |
| UI-D14 | 화면 용어 | 「세션」·「종료」 대신 「기기」·「로그아웃」 | 사용자 친숙 용어, 기존 「로그아웃」 버튼과 같은 동사 | 「세션 종료」 |
| UI-D15 | 834px | medium 구간으로 배치. D §11-1 QA 폭 목록에 834 추가 | iPad 세로 계열 실기 폭. 추가 비용이 작음 | 목록 추가 안 함 |
| UI-D16 | 세션 정렬 | 이 기기 맨 위 → `last_seen_at` 내림차순 | 이 기기 구분이 먼저 | 생성 시각 순 |
| UI-D17 | 한글 앱 안내(ADR-002 §4-4) | 앱 안 문구 미표시. 실기 확인 항목만(⑤) | 안내가 필요한지 실기 전 근거 없음 | 한글 문서 행에 보조 안내 |
| UI-D18 | 확인 Dialog 첫 포커스 | 기존 Dialog 규칙 그대로(첫 포커스 가능 요소, `Dialog.tsx:163`) | 다른 확인 Dialog 4개와 같게(PR #31 규칙과 동일 요구). 「취소」 기본 포커스는 공용 Dialog에 초기 포커스 지정 기능이 필요해 별건 | 「취소」에 초기 포커스 |
| UI-D19 | 업로드 실패 문구 | 「업로드하지 못했습니다.」 + `ERROR_COPY` 원인(G-57), 이미지 칩에도 적용 | 브리프 「ERROR_COPY 재사용 우선」, G-70과 같은 구조 | 기존 원인 없는 한 문장 유지 |

## ② 구현 레인용 수용 기준

확인 방법: **C** = 컴포넌트 테스트(jsdom, 지정 테스트 이름은 DD 6-2 행 추가 후 확정), **R** = 실기 QA(ego-browser 또는 iPhone), **I** = 서버 통합 테스트.

### 1b 문서 첨부 (UI_STATES §2-13, CMP-32)

| ID | 기준 | 확인 |
|---|---|---|
| UI-AC-01 | 첨부 버튼 이름이 「파일 첨부」이고 `accept`가 G-54 목록과 같다 | C |
| UI-AC-02 | 허용 밖 확장자·형식별 상한+1바이트는 요청 없이 칩 실패(G-54·G-55)와 `role="alert"` 1회 | C |
| UI-AC-03 | 서버 413·415·415 `macro_extension_mismatch`가 각각 G-55·G-54·G-56으로 보이고 「다시 시도」가 없다. 네트워크·5xx만 「업로드하지 못했습니다.」 + `ERROR_COPY` 원인 + 「다시 시도」(구현 변경: 현재 `composer-upload.ts:29` `uploadErrorText`는 `failureText`를 쓰지 않음) | C |
| UI-AC-04 | 업로드 중 칩에 「업로드 중」 + 비결정 진행, 전송 버튼 비활성, 「첨부 제거」가 요청을 abort | C |
| UI-AC-05 | 업로드가 20초 상한에 걸리지 않는다(느린 응답 모의에서 20초 뒤에도 업로드 중 유지) | C |
| UI-AC-06 | 문서만 보낼 때 본문이 「[문서]」 | C |
| UI-AC-07 | 문서 행에 형식 표지 텍스트·파일명·크기·「받기」가 있고, 「받기」 접근 이름이 「{전체 파일명} 받기, {형식}, {크기}」 | C |
| UI-AC-08 | `has_macros=true`면 「매크로 포함」 텍스트가 보이고 접근 이름 끝에 「, 매크로 포함」. 그레이스케일에서 구분됨 | C + R |
| UI-AC-09 | 긴 파일명에서 확장자(`.docm` 등)가 잘리지 않는다. 390·834·1440px 가로 넘침 0 | R(ego-browser 폭 3종) |
| UI-AC-10 | `expired=true`면 「만료된 첨부입니다」, 「받기」 없음, 탭 정류장 없음 | C |
| UI-AC-11 | 봇·사람 문서 행 DOM 구조가 같다(차이는 작성자 옆 배지뿐). 「받기」가 `download` 링크이며 JS fetch를 쓰지 않는다 | C |

### 1c 로그인한 기기 (UI_STATES §2-14, CMP-22)

| ID | 기준 | 확인 |
|---|---|---|
| UI-AC-12 | 사이드바 「로그인한 기기」 버튼 → `/settings/sessions`, 진입 시 제목에 포커스 | C |
| UI-AC-13 | 로딩 `aria-busy`·Skeleton, 오류 `ERROR_COPY` + 「다시 시도」, 20초 초과 시 `ERROR_COPY.timeout` | C |
| UI-AC-14 | 이 기기 행이 맨 위에 「이 기기」 텍스트 표지로 보이고 나머지는 마지막 사용 내림차순. `--accent-text`/`--accent-bg` 쌍 대비 4.5:1 이상을 라이트·다크에서 실측(대비 린트 미대상) | C + R |
| UI-AC-15 | `device_label` null이면 「알 수 없는 기기」. 원시 UA·IP가 화면·로그에 0건 | C + I |
| UI-AC-16 | 다른 기기 「로그아웃」 → Dialog(G-69), 첫 포커스는 기존 Dialog와 같음. 요청 중 Esc·「닫기」·「취소」가 닫지 못하고 `aria-busy`(PR #31과 같은 테스트 패턴) | C |
| UI-AC-17 | 성공 시 행 제거, StatusRegion G-71, 포커스가 다음 행 → 이전 행 → 제목 순으로 이동 | C |
| UI-AC-18 | 실패 시 Dialog 안 「로그아웃하지 못했습니다.」 + 원인, busy 해제 보장 | C |
| UI-AC-19 | 원격 로그아웃 후 대상 기기가 5초 안에 401 흐름(「세션이 종료되었습니다…」)으로 가고 그 기기의 push 구독이 삭제됨. 남의 세션 ID는 404 | I + R(두 기기) |
| UI-AC-20 | 「이 기기에서 로그아웃」은 확인 없이 `/login`으로 가고 사이드바 로그아웃과 결과가 같다 | C |

## ③ 재QA에서 볼 화면

1. SCR-04 대화 본문 — 문서 행 4상태(준비·매크로 포함·만료·봇 작성) × 390·834·1440px, 라이트·다크
2. SCR-05 스레드 패널(wide 1440, 패널 폭 `clamp(320px, 32vw, 380px)`) 안 문서 행 — compact 2단 배치로 바뀌는지
3. 작성기 문서 칩 — 업로드 중·실패 4종·첨부 대기, compact 하단 고정 작성기에서 가림 0
4. SCR-08 로그인한 기기 — 기본·빈·라벨 없음·오류, 확인 Dialog(요청 중 포함)
5. 사이드바 계정 카드 — 「로그인한 기기」 버튼 추가 후 72px 접힘 상태 이름·포커스
6. 200% 확대(FR-CLIENT-07)에서 문서 「받기」·세션 「로그아웃」 조작 가능, 그레이스케일에서 「매크로 포함」·「이 기기」 구분

## ④ PRD·TRD 변경 제안 (직접 수정 안 함 — Security 레인 쓰기 경로)

| 파일:행 | 현재 | 제안 |
|---|---|---|
| `docs/02-prd/PRD.md:126` FR-OPS-09 | 「일반 파일 첨부(PDF·텍스트 등)」 P1, 「다운로드 전용」 | 범위를 ADR-002 §4(PDF·Word·Excel·PowerPoint·한글, 구형 Office 포함, 양방향, 25 MiB, 90일, 매크로 문서 받되 「매크로 포함」 표지)로 바꾸고 1단계 채택 표시. 수용 기준에 「매크로 포함」 텍스트 표지·확장자 일치 415 추가 |
| `docs/02-prd/PRD.md:61` FR-AUTH-04 | P1, 「다른 기기 세션을 원격 종료 가능」 | 1단계 채택. 수용 기준: 거친 기기 라벨만 표시(원시 UA·IP 저장 0), 원격 로그아웃 후 5초 안 대상 WS close·push 구독 삭제, 남의 세션 404 |
| `docs/03-trd/TRD.md:53` `sessions` | 기기 정보 컬럼 없음 | nullable `device_label text` 추가(로그인 시 서버가 UA에서 「{기기 종류} · {브라우저}」 거친 라벨만 만들고 원문 미저장, 길이 상한) |
| `docs/03-trd/TRD.md:87` `GET /api/sessions` | 「원격 기기 revoke는 P1」 | 응답 항목에 `device_label: string \| null` 추가. `DELETE /api/sessions/{id}` 신설: `access: account`, 본인 세션만(남의 ID·없는 ID 404), 이미 폐기된 본인 세션 204(멱등), 현재 세션 ID는 400(로그아웃 라우트 사용), CSRF·Origin 통제 동일, revoke 후 5초 안 WS close |
| `docs/03-trd/TRD.md:64` `attachments` | mime CHECK 4종, `byte_size` ≤ 10,485,760, 파일명 없음 | 문서 mime 추가, 문서 상한 26,214,400(25 MiB), `file_name text`(경로 구분자·제어 문자 제거, 길이 상한), `has_macros boolean NOT NULL DEFAULT false` |
| `docs/03-trd/TRD.md:131` 첨부 projection | `attachments[{id,mime,byte_size,duration_ms?,width?,height?,expires_at,expired}]` | `file_name`·`has_macros` 추가(만료 후에도 메타 유지 — 만료 자리표시자가 파일명을 씀) |
| `docs/03-trd/TRD.md:121` 상태 코드 | 415 = 허용목록 밖 형식 | 415 오류 코드 구분: `unsupported_media_type` / `macro_extension_mismatch`(UI G-56) |
| `docs/03-trd/TRD.md:220-221` §6-1 | 형식 4종, 10 MiB, PDF 거부 | ADR-002 §4-2 판정 표, 문서 25 MiB, 문서 다운로드는 `Content-Disposition: attachment; filename*=UTF-8''…` |
| `docs/03-trd/TRD.md:102` | 업로드 시간 상한 언급 없음 | 웹 업로드는 20초 요청 상한 면제(현 구현 55ac812)를 계약에 명시하거나, 업로드 전용 상한을 정함(UI-D4) |

## ⑤ iPhone PWA 다운로드 실기 확인 항목

홈 화면 PWA(standalone), tailnet origin, 실기 iPhone에서 확인합니다. 결과는 1b 레인 `qa/manual/`에 기록하고, 실제로 실행하기 전에는 PASS로 표시하지 않습니다.

1. 「받기」(`<a download>` + `Content-Disposition: attachment`)를 누를 때 공유 시트나 다운로드 확인이 뜨는지, 앱 화면이 다른 곳으로 이동하지 않는지
2. 「파일」 앱 → 다운로드 폴더에 저장되고, 한글 파일명(`filename*=UTF-8''`)이 깨지지 않는지
3. PDF·`.docx`·`.xlsx`·`.pptx`가 「파일」 앱에서 열리는지(미리보기는 OS 기능)
4. `.hwp`·`.hwpx`: 한컴 앱이 없을 때와 있을 때의 동작(UI-D17 안내 문구가 필요한지 판단할 근거)
5. `.docm`(매크로 포함): 저장되는지, 표지가 390px 행에 보이는지
6. 25 MiB 문서를 셀룰러에서 받을 때 중간에 실패하면 무엇이 보이는지(앱이 상태를 표시하지 않으므로 OS 표시를 기록)
7. 만료(404) 직전에 연 화면에서 「받기」를 누를 때 standalone 창이 오류 JSON 화면으로 바뀌는지. 바뀌면 UI-D5를 다시 검토
8. 받은 뒤 앱으로 돌아올 때 화면·초안이 그대로 유지되는지(bfcache·가시성 복귀)

## 검증

| 명령 | 결과 | 로그 |
|---|---|---|
| `pnpm check:cleanroom` | `CLEANROOM OK`, EXIT=0 | `logs/check-cleanroom.log` |
| `pnpm check:design-tokens` | `check:design-tokens OK`, EXIT=0 | `logs/check-design-tokens.log` |
| 표 열 수 검사(`python3 dev/active/p2s1-ui-spec/logs/tblcheck.py` + 수정한 3개 파일·REPORT.md) | 불일치 0 | `logs/table-columns.log` |
| `git diff --name-only d89cfe9..HEAD` | 10개 = `docs/05-design-ref/DESIGN_REFERENCE.md`, `docs/07-ui-spec/COPY_GAPS.md`, `docs/07-ui-spec/UI_STATES.md` + `dev/active/p2s1-ui-spec/**`(PROGRESS·REPORT·logs 5개) — 허용 범위 안. `dev/`는 gitignore라 `git add -f` | `logs/diff-names.log` |

## 서브에이전트

| 에이전트 | 범위 | 결과 |
|---|---|---|
| Explore ①(읽기 전용) | 첨부 컴포넌트·작성기·`ERROR_COPY`·토큰·검사 스크립트 | 완료. W-22 이미지 첨부와 `ATTACHMENT_COPY` 확인 → 문구 4개 재사용. 업로드가 20초 상한에서 면제되고 진행 이벤트가 없다는 사실이 UI-D3·D4의 근거 |
| Explore ②(읽기 전용) | 세션 라우트·응답 형태·Dialog busy·PRD | 완료. 기기 라벨·revoke 라우트·`/settings` 라우트가 없음 → ④ 제안, UI-D10·D11 근거 |

## 남은 일·주의

- 이 명세는 ④의 계약 변경(`device_label`, `DELETE /api/sessions/{id}`, `file_name`·`has_macros`, 415 코드 구분)을 가정합니다. 계약이 다르게 정해지면 §2-13·§2-14의 진입 조건을 맞춰야 합니다.
- DD 6-2에 FR-OPS-09·FR-AUTH-04 행이 없습니다. 지정 테스트 이름은 구현 레인이 DD에 행을 추가할 때 정합니다(UI_STATES §7에는 「—」로 둠).
- 브리프 금지사항에 따라 Codex 검증을 하지 않았습니다. 병합 전에 Codex 검토가 필요합니다.
