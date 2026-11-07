# QA-FR-OPS-02 — 격리 복원 대조 (DEV_DESIGN 6-2 FR-OPS-02, W-13, 5-4 형식)

> 실행 절차·승인 범위: `docs/runbooks/RESTORE_DRILL.md`. 합성 데이터만 씁니다(운영 DB·실데이터 접근 금지).
> 실행하지 않았거나 승인자가 확인하지 않은 항목을 `PASS`로 적지 않습니다(DEV_DESIGN 8절 8).
> 증거에 접속 문자열·비밀번호를 남기지 않습니다.

| 필드 | 값 |
|---|---|
| 실행자 | Claude(Developer 레인 p1-w13-restore-drill, 자동 실행) — 승인자 확인 시 이름 기입 |
| 일시(KST) | 2026-11-07 18:00 KST 직전 (자동 실행 1회) |
| 기기·OS·브라우저(버전) | 서버 Mac / macOS · Docker 컨테이너 `shared-postgres`(PostgreSQL 15) — 브라우저 해당 없음 |
| 접속 경로 | `docker exec shared-postgres` 컨테이너 내부 `127.0.0.1:5432`, DB `ohmyslack_test`, `.env.test` 계정(superuser 아님) |
| 절차 | 런북 1절 1–6번(`bash tools/restore-drill.sh`) |
| 기대 결과 | 7개 대조 항목(메시지·수정/삭제 상태·DM 멤버십·읽음 커서·seq·change 커서·멘션) 원본=복원, 잔여 `drill_*` 스키마 0, 마지막 줄 `DRILL OK 7/7`, 종료 코드 0 |
| 실제 결과 | 아래 "대조 결과" 표. 마지막 줄 `DRILL OK 7/7`, `잔여 drill_* 스키마: 0` |
| 판정 | `미검증` — 자동 드릴 1회 `DRILL OK` 기록됨. 승인 기록 칸을 승인자가 채운 뒤 `PASS`로 바꿉니다 |
| 증거 경로 | 이 문서 "대조 결과" 표(실행 출력 인용), 자체 테스트 `tools/test/restore-drill.test.ts` |

## 승인 기록

| 항목 | 값 |
|---|---|
| 승인 범위 | `ohmyslack_test` 안 임시 스키마 `drill_*`, 합성 데이터, 컨테이너 클라이언트 바이너리만(런북 0절) |
| 승인 근거 | W-13 BRIEF Jarvis 결정 1·2 (2026-11-07) |
| 승인자 확인 | (미기입 — 영환님/Jarvis 확인 시 이름·일시) |
| 운영 백업 적용 | 승인되지 않음(런북 7절) |

## 대조 결과 (2026-11-07 실행, 스키마 `drill_src_1fca4474`/`drill_orig_1fca4474`)

| 항목 | 원본 행 | 복원 행 | 결과(해시 앞 12자) |
|---|---|---|---|
| messages | 6 | 6 | 일치 `69194f8f90a5` |
| edit_delete_state | 6 | 6 | 일치 `f23dc8741cc6` |
| dm_membership | 3 | 3 | 일치 `36f7c044bf4c` |
| read_cursor | 4 | 4 | 일치 `fa3a20a5f069` |
| seq | 8 | 8 | 일치 `b8ea482ea1dd` |
| change_cursor | 10 | 10 | 일치 `a7682cea0111` |
| mentions | 2 | 2 | 일치 `994f65114c78` |

출력 마지막 두 줄 앞뒤 인용:

```
잔여 drill_* 스키마: 0
...
DRILL OK 7/7
```

하나라도 불일치하거나 잔여 스키마가 0이 아니면 판정 `FAIL`, 런북 5절을 따릅니다.
