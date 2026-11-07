# public/fonts 출처

DESIGN_REFERENCE §3-1(Pretendard 행)·§3-2(자체 호스팅). 공식 웹 빌드를 **무수정**으로 복사했다(서브셋·포맷 변환·재압축 없음).

| 항목 | 값 |
|------|----|
| 폰트 | Pretendard (Reserved Font Name "Pretendard") |
| 릴리스 | v1.3.9 |
| 원본 | https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip |
| zip sha256 | `04be351a74d6bf7d60c480a3087e51d185485d35a52023142af1df19eb8c428a` (47,304,526 B) |
| 라이선스 | SIL Open Font License 1.1 — 같은 디렉터리 `LICENSE.txt` |

| 파일 | zip 내 경로 | sha256 | 크기 |
|------|-------------|--------|------|
| `PretendardVariable.woff2` | `web/variable/woff2/PretendardVariable.woff2` | `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4` | 2,057,688 B |
| `LICENSE.txt` | `LICENSE.txt` | `b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e` | — |

해시는 `apps/web/test/assets/fonts.test.ts`가 고정한다. 서비스 워커 precache 대상이 아니다(해시 없는 2MB 파일 — `vite.config.ts` `PUBLIC_SHELL`).
