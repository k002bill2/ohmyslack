# 앱 심볼·PWA 아이콘 에셋 (W-04b)

> 정본: DESIGN_REFERENCE §9-1(심볼 원칙)·§9-2(산출물 세트)·§2-2/§2-3(금지·경로 규칙)·§3-3(색 토큰), CLEANROOM 4-1.
> manifest·HTML `<link>` 연결은 W-11 범위이며 이 문서는 파일 자체만 다룬다.

## 1. 제작 방식

- **참고 출처: 독자 제작, 참고 출처 없음.** 다른 메신저 앱의 로고·아이콘을 보거나 참고하지 않았다.
- SVG는 `path`(원호 `A` 명령·직선)와 `rect`만으로 직접 작성했다. 외부 아이콘 세트·폰트 글리프·트레이싱은 쓰지 않았다.
- 배제 모티프(§9-1): `#`·말풍선·격자·4색 바람개비·모노그램 S — 모두 해당 없음.
- PNG·ICO는 macOS `sips`로 SVG에서 래스터화했다(npm 의존성 없음).
  - `sips -s format png <svg> --resampleHeightWidth N N --out <png>`
  - favicon.ico: 32px PNG → `sips -s format ico` (실제 ICO 컨테이너, `file` 결과 "MS Windows icon resource - 1 icon, 32x32, 32 bits/pixel").

## 2. 사용 색 토큰

| 용도 | 토큰 | 값 | 출처 |
|---|---|---|---|
| 배경 | accent `teal` step 9 (라이트) | `#12a594` | Radix Colors `src/light.ts` `teal9` (MIT, https://raw.githubusercontent.com/radix-ui/colors/main/LICENSE) |
| 심볼 | 흰색 | `#ffffff` | — (§9-1-2 "액센트 step 9 위에 흰 심볼") |
| mono 심볼 | 검정(알파만 의미) | `#000000` | — (monochrome 아이콘은 알파 채널만 사용) |

- 그라데이션·그림자·투명도 효과 없음(§9-1-2).
- 참고: 흰색 대 `#12a594` 대비 3.07:1(WCAG 상대 휘도 계산, 비텍스트 기준 3:1 충족). 아이콘 심볼은 텍스트가 아니라 장식 그래픽이므로 §7-1 텍스트 기준 대상이 아니다.

## 3. 파일 목록

| 파일 (`apps/web/public/` 기준) | 크기(px) | 바이트 | `purpose` / 용도 | sha256 |
|---|---|---|---|---|
| `icons/source.svg` | viewBox 512 | 515 | 1안 심볼 원본(둥근 사각 배경 rx 112) | `5d7e7740e364ec691ac56c561a0959506d3019bbddb6fe20100c147bf83757f1` |
| `icons/maskable-source.svg` | viewBox 512 | 575 | maskable·apple-touch 원본(전면 배경, 심볼 0.85배) | `49dec01d0a154c1fbf5b4099a66e9c8bb10069a0957873c10a8bfc24374aef41` |
| `icons/alt-source.svg` | viewBox 512 | 468 | 2안 비교용(**manifest 미사용**) | `9d6bfd9832bde24cae083805d1736e4d73edfe76807e6711ad446322448f0685` |
| `icons/icon-192.png` | 192×192 | 7150 | `any` (모서리 투명) | `e0101391767f94654f9d984b14893f431605bbd455580502deaae701b78e5ca2` |
| `icons/icon-512.png` | 512×512 | 23914 | `any` (모서리 투명) | `8afdb346cb05d7d384ace31dfaece572a4df6e2c4c14a4b5237655dfe101fec0` |
| `icons/icon-maskable-512.png` | 512×512 | 17539 | `maskable` (전면 불투명) | `d7e359f92dd4088aa4ff206888fa14b9a763aff9a51c9d913a26bea9876af81d` |
| `icons/icon-mono.svg` | viewBox 512 | 394 | `monochrome` (투명 배경 단색) | `ca2765e6e1d8fe012155d2ec05cc2af3bcf598bd1ef8c06a63aef9eb3ba09f08` |
| `icons/apple-touch-icon.png` | 180×180 | 4673 | apple-touch (불투명, 최소 알파 255 실측) | `41a1cb478ecfad473c42152053bd09d7883ace141468d9be8d28d2e82fccc500` |
| `icons/favicon.svg` | viewBox 512 | 515 | `<link rel="icon" type="image/svg+xml">` (source.svg와 동일 내용) | `5d7e7740e364ec691ac56c561a0959506d3019bbddb6fe20100c147bf83757f1` |
| `favicon.ico` | 32×32 | 4414 | 브라우저 기본 요청 경로(§2-3-2 예외 1개) | `10a092bad5dc96dcbdcb8498213f13d96916eea0c38491bd91f6df7af1b25bde` |

크기 증명: `sips -g pixelWidth -g pixelHeight apps/web/public/icons/*.png apps/web/public/favicon.ico` → 180/192/512/512/32 (2026-11-07 실행).

## 4. 심볼 기하 (1안)

- 모티프: §9-1 1안 "두 개의 겹친 원호(대화의 왕복)". 반지름 104인 원호 두 개, 획 40, 둥근 캡.
  - 위 원호: 중심 (232, 236), 각도 170°→370°(y-down 좌표, 위쪽 반원보다 10°씩 길게).
  - 아래 원호: 중심 (280, 276), 각도 −10°→190°.
  - 두 중심은 (256, 256)에 대해 대칭이라 심볼 전체가 캔버스 중앙에 놓인다.
- "겹친"의 해석: 두 원호는 획이 교차하지 않고, 양 끝이 서로 엇갈려 지나가며 x 범위가 겹친다. 즉 "서로 엇갈려 지나가는 왕복"으로 해석했다.
- 기각한 배치(작업 중 렌더 비교):
  - 마주 보는 두 C자가 위·아래에서 맞물리는 배치는 유명 패션 브랜드의 맞물린 이니셜 로고처럼 읽혀 상표 위험이 있어 버렸다.
  - 대각으로 맞물린 270° 원호 두 개는 interlock·S자 형태로 읽혀 모노그램 S 금지(§9-1)에 걸릴 위험이 있어 버렸다.

## 5. 1안 vs 2안 비교 렌더

비교 렌더는 `sips`로 `source.svg`·`alt-source.svg`를 각각 512px PNG로 만들어 나란히 놓고 눈으로 확인했다(시트는 작업 폴더에만 두고 커밋하지 않음).

| 항목 | 1안 `source.svg` (두 원호) | 2안 `alt-source.svg` (오프셋 두 사각 모서리) |
|---|---|---|
| 의미 | 대화의 왕복 | 동기화된 두 기기 |
| 형태 | 곡선 2개, 중앙 원형 | ㄱ·ㄴ 모서리 2개(획 40, 둥근 캡·조인) |
| 원형 크롭(maskable) 적합성 | 원형 실루엣이라 원형 마스크와 잘 맞음 | 사각 실루엣이라 원형 마스크에서 모서리 여백이 불균형 |
| 32px 가독성 | 두 원호 사이 틈이 구분됨(미리보기 확인) | 구분됨 |
| 혼동 위험 | 일반적인 "새로고침/동기화" 글리프와 닮을 수 있음(화살촉 없음으로 구분) | 자르기(crop) 도구 글리프와 닮을 수 있음 |

결론: 1안을 기본으로 manifest 세트에 쓰고, 2안은 비교용으로만 둔다(영환님 번복 가능).

## 6. maskable 안전 영역 확인 (계산 근거)

기준: 심볼 경계 박스가 중심 (256, 256) 기준 반지름 0.4 × 512 = **204.8** 원 안(지름 80% 원).
경계 박스의 네 꼭짓점이 원 안이면 박스 안의 모든 점도 원 안이다.

1. **해석 계산** — 원호 중심선을 2000점 샘플링하고 각 점 주위에 반지름 20(획 절반, 둥근 캡 포함) 원을 둘러 경계를 구했다.
   - 축소 전(배율 1.0, `any` 아이콘): 박스 x[108.0, 404.0] y[112.0, 400.0] → 꼭짓점 거리 √(148² + 144²) ≈ **206.5 > 204.8 (불통과)**.
   - 그래서 `maskable-source.svg`에만 중심 기준 축소 `translate(256 256) scale(0.85) translate(-256 -256)`를 적용했다.
   - 축소 후(배율 0.85): 박스 x[130.2, 381.8] y[133.6, 378.4] → 꼭짓점 거리 √(125.8² + 122.4²) ≈ **175.5 < 204.8 (통과, 여유 29.3)**.
2. **픽셀 실측** — `icon-maskable-512.png`를 디코드해 흰 픽셀(R,G,B,A > 200)을 셌다.
   - 흰 픽셀 박스 x[130, 381] y[134, 377] → 꼭짓점 거리 √(126² + 122²) ≈ 175.4 < 204.8.
   - 흰 픽셀의 중심 거리 최대값 131.7 (실제 획까지의 거리).
   - 최소 알파 255(전면 불투명) — `apple-touch-icon.png`도 최소 알파 255.
3. 수동 확인(권장, W-11 이후): manifest 연결 뒤 Chrome DevTools → Application → Manifest → "Show only the minimum safe area for maskable icons".

## 7. 재생성 방법

SVG를 바꾸면 아래 순서로 다시 만들고 §3의 sha256을 갱신한다.

```bash
cd apps/web/public/icons
for s in 192 512; do sips -s format png source.svg --resampleHeightWidth $s $s --out icon-$s.png; done
sips -s format png maskable-source.svg --resampleHeightWidth 512 512 --out icon-maskable-512.png
sips -s format png maskable-source.svg --resampleHeightWidth 180 180 --out apple-touch-icon.png
sips -s format png source.svg --resampleHeightWidth 32 32 --out /tmp/fav32.png
sips -s format ico /tmp/fav32.png --out ../favicon.ico
shasum -a 256 * ../favicon.ico
```
