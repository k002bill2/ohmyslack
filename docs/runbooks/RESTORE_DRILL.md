# 런북 — 격리 복원 드릴 (W-13, FR-OPS-02, TRD §5 백업·복원)

> 합성 데이터만 씁니다. 실제 대화 데이터·운영 DB(`ohmyslack`)·다른 프로젝트 DB에는 접근하지 않습니다(THREAT_MODEL TM-BAK-03·04).
> 이 문서는 접속 문자열·비밀번호 같은 **값을 담지 않습니다.** 운영 백업에 적용하는 것은 이 문서로 승인되지 않습니다(7절).

## 0. 승인 범위

| 항목 | 승인된 범위 | 금지 |
|---|---|---|
| 대상 DB | `ohmyslack_test` 안의 임시 스키마 `drill_src_<rand>`·`drill_orig_<rand>` (DEV_DESIGN ⚖️-4·W-13) | 운영 DB `ohmyslack`, 다른 프로젝트 DB, `drill_*` 밖 스키마 |
| 접속 계정 | `.env.test`의 `TEST_DATABASE_URL` 사용자(`ohmyslack_test` role) | 컨테이너 superuser |
| 도구 | `docker exec shared-postgres`의 `psql`·`pg_dump`·`pg_restore`(컨테이너 클라이언트 바이너리) | 컨테이너 재시작·설정·볼륨 변경, 공용 `~/Work/shared-infra/backup.sh` 수정·실행 |
| 데이터 | 스크립트가 만드는 합성 데이터 | 실제 대화 데이터 |

## 1. 실행 방법

1. Node 26 경로: `export PATH=$HOME/.nvm/versions/node/v26.13.0/bin:$PATH`
2. 저장소 루트에서 `pnpm install --frozen-lockfile`
3. 테스트 DB 접속 정보 로드(값을 출력하지 않습니다): `set -a; . ./.env.test; set +a`
4. 계획만 보기: `pnpm drill:restore --dry-run` (또는 `bash tools/restore-drill.sh --dry-run`). 실행하지 않고 명령만 출력합니다.
5. 실행: `bash tools/restore-drill.sh; echo EXIT=$?`
6. 판정: 출력 **마지막 줄**이 `DRILL OK 7/7`이고 종료 코드 0, 그 위 줄 `잔여 drill_* 스키마: 0`.

`TEST_DATABASE_URL`이 없거나 DB 이름이 `ohmyslack_test`가 아니면 `check-url` 단계에서 아무것도 만들지 않고 거부합니다.

## 2. 드릴 흐름

1. 600 권한 임시 env 파일(`mktemp -d` 아래 `pg.env`)에 접속 정보를 씁니다. 비밀번호는 argv에 넣지 않고 `docker exec --env-file`로만 전달합니다.
2. 합성 데이터 생성: 스키마 `drill_src_<rand>`에 `apps/server/migrations/*.sql`을 적용하고 채널·DM·답글·수정·삭제·멘션·읽음 커서를 넣습니다(한 트랜잭션).
3. 덤프: `pg_dump -Fc -n drill_src_<rand>` → 스크래치 디렉터리(700) 안 파일.
4. 원본 스키마 이름 변경: `drill_src_<rand>` → `drill_orig_<rand>`.
5. 복원: `pg_restore --no-owner --no-privileges --exit-on-error`로 `drill_src_<rand>` 재생성.
6. 대조: 두 스키마에서 항목별 정렬된 행을 뽑아 건수와 해시를 비교합니다(3절).
7. 정리: 두 스키마 삭제 → 잔여 `drill_*` 스키마 수 조회. 스크래치 디렉터리(덤프·env 파일 포함) 삭제. 오류·중단 시에도 `trap`이 같은 정리를 합니다.

## 3. 대조 항목

| 항목 | 내용 | 정본 |
|---|---|---|
| `messages` | 메시지 본문·작성자·채널·스레드 부모 | PRD FR-OPS-02 "메시지" |
| `edit_delete_state` | 수정 시각(`edited_at`)·삭제 시각(`deleted_at`) | "수정/삭제 상태" |
| `dm_membership` | DM 채널 멤버십 | "DM 멤버십" |
| `read_cursor` | 사용자별 읽음 커서 | "읽음 커서" |
| `seq` | 채널별 메시지 seq 연속성 | "seq 연속성" |
| `change_cursor` | change 로그 커서 | DEV_DESIGN 6-2 "change 커서" |
| `mentions` | 멘션 | 합성 데이터 범위 보강 |

각 항목 줄 형식: `<항목>: 원본 N행 / 복원 N행 / 일치 <해시 앞 12자>`. 하나라도 다르면 `불일치`로 표시하고 마지막 줄이 `DRILL FAILED <불일치 항목>`, 종료 코드 1입니다.

## 4. 결과 해석

| 마지막 줄 | 의미 | 조치 |
|---|---|---|
| `DRILL OK 7/7` | 7개 항목 모두 일치, 잔여 스키마 0 | `qa/manual/QA-FR-OPS-02.md`에 기록 |
| `DRILL FAILED <항목…>` | 대조 불일치 | 5절 |
| `DRILL FAILED 잔여 스키마 N` | 정리 후에도 `drill_*` 스키마 남음 | 5절 2번 |
| `DRILL FAILED 실행 오류(종료 코드 N)` | 덤프·복원·SQL 단계 오류 | stderr 확인 후 5절 |

## 5. 실패 시 조치

1. 출력의 항목 줄과 stderr를 기록합니다(비밀값은 출력되지 않습니다). 재실행으로 덮지 말고 먼저 원인을 적습니다.
2. 잔여 스키마 확인(조회만): `node_modules/.bin/tsx tools/bin/restore-drill.ts residue-sql`이 출력하는 SQL을 `ohmyslack_test`에서(`.env.test` 계정, 1절 3번처럼 로드) 실행해 `drill_*` 스키마 수를 봅니다. 남아 있으면 `tsx tools/bin/restore-drill.ts drop-sql <스키마…>` 출력으로 **그 스키마만** 삭제합니다. 다른 스키마는 건드리지 않습니다.
3. 스크래치 디렉터리(`$TMPDIR/restore-drill.*`)가 남았으면 삭제합니다. 안에 접속 정보 파일이 있을 수 있습니다.
4. 불일치가 재현되면 마이그레이션 변경(`apps/server/migrations/`)·`pg_dump`/`pg_restore` 버전 차이를 먼저 의심하고 결과를 QA 문서 `실제 결과`에 남깁니다. 판정은 `FAIL`.

## 6. 보안 메모

- 맥 디스크의 덤프는 실행 중에만 700 디렉터리 안에 있고 종료 시 삭제됩니다. FileVault·자동 잠금 권고(THREAT_MODEL TM-MAC-02).
- `--dry-run` 출력에 비밀값·운영 DB 이름이 없음을 자체 테스트(`tools/test/restore-drill.test.ts`)가 검사합니다.

## 7. 운영 백업에 적용할 때(이 문서로 승인되지 않음)

운영 백업(`backup.sh` 산출물) 복원 대조는 별도 승인이 필요합니다: ① 복원 대상 임시 DB 생성·삭제 권한(⚖️-4) ② 실데이터가 드릴 출력·임시 DB에 남는 범위(TM-BAK-04) ③ 덤프 파일 보존·삭제 정책(TM-BAK-01, PRD ⚖️-3) ④ 운영 DB 접근 계정. 승인 전에는 합성 데이터 드릴만 실행합니다.
