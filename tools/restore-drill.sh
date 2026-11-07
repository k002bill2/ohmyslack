#!/usr/bin/env bash
# W-13 / FR-OPS-02 격리 복원 드릴(정본: DEV_DESIGN W-13·6-2, 런북 docs/runbooks/RESTORE_DRILL.md).
# 합성 데이터 → pg_dump -Fc → 원본 스키마 이름 변경 → pg_restore → 두 스키마 대조 → 두 스키마 삭제.
# 대상: TEST_DATABASE_URL의 ohmyslack_test 안 drill_* 스키마만. 도구: 컨테이너의 pg 클라이언트만(docker exec).
# 비밀값은 argv·출력에 넣지 않는다: 600 env 파일 → docker exec --env-file, 종료 시 삭제.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${DRILL_CONTAINER:-shared-postgres}"
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "사용법: tools/restore-drill.sh [--dry-run]" >&2; exit 2 ;;
esac

helper() { (cd "$ROOT" && "$ROOT/node_modules/.bin/tsx" tools/bin/restore-drill.ts "$@"); }

helper check-url
RAND="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
SRC="drill_src_${RAND}"
ORIG="drill_orig_${RAND}"

if [[ $DRY -eq 1 ]]; then
  cat <<PLAN
[dry-run] 실행하지 않고 명령만 출력합니다. <scratch>=mktemp -d(700), 비밀값은 <scratch>/pg.env(600)에만 기록.
1. tsx tools/bin/restore-drill.ts env-file <scratch>/pg.env
2. tsx tools/bin/restore-drill.ts seed-sql ${SRC} | docker exec -i --env-file <scratch>/pg.env ${CONTAINER} psql -X -q -v ON_ERROR_STOP=1 -1 -f -
3. docker exec -i --env-file <scratch>/pg.env ${CONTAINER} pg_dump -Fc -n ${SRC} > <scratch>/drill.dump
4. tsx tools/bin/restore-drill.ts rename-sql ${SRC} ${ORIG} | docker exec -i --env-file <scratch>/pg.env ${CONTAINER} psql -X -q -v ON_ERROR_STOP=1 -f -
5. docker exec -i --env-file <scratch>/pg.env ${CONTAINER} sh -c 'exec pg_restore --no-owner --no-privileges --exit-on-error -d "\$PGDATABASE"' < <scratch>/drill.dump
6. tsx tools/bin/restore-drill.ts snapshot-sql ${ORIG}|${SRC} | docker exec -i --env-file <scratch>/pg.env ${CONTAINER} psql -X -q -At -v ON_ERROR_STOP=1 -f - > <scratch>/{orig,restored}.json
7. tsx tools/bin/restore-drill.ts compare <scratch>/orig.json <scratch>/restored.json
8. tsx tools/bin/restore-drill.ts drop-sql ${SRC} ${ORIG} | docker exec ... psql -f -   (trap에서도 실행)
9. tsx tools/bin/restore-drill.ts residue-sql | docker exec ... psql -At -f -   (잔여 drill_* 스키마 0 기대)
10. rm -rf <scratch>   (trap)
DRILL DRY-RUN
PLAN
  exit 0
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")"
ENVF="$SCRATCH/pg.env"
dx() { docker exec -i --env-file "$ENVF" "$CONTAINER" "$@"; }
psql_run() { dx psql -X -q -v ON_ERROR_STOP=1 "$@"; }
drop_schemas() { helper drop-sql "$SRC" "$ORIG" | psql_run -f - >/dev/null; }

cleanup() {
  local rc=$?
  if [[ -f $ENVF && ${DROPPED:-0} -eq 0 ]]; then
    drop_schemas || echo "경고: 드릴 스키마 삭제 실패(${SRC}, ${ORIG}) — 런북 '실패 시 조치' 참조" >&2
  fi
  rm -rf "$SCRATCH"
  if [[ $rc -ne 0 && ${REPORTED:-0} -eq 0 ]]; then echo "DRILL FAILED 실행 오류(종료 코드 ${rc})"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

helper env-file "$ENVF"
echo "1/6 합성 데이터 생성: ${SRC}"
helper seed-sql "$SRC" | psql_run -1 -f - >/dev/null
echo "2/6 덤프: pg_dump -Fc -n ${SRC}"
dx pg_dump -Fc -n "$SRC" > "$SCRATCH/drill.dump"
echo "3/6 원본 이름 변경: ${SRC} -> ${ORIG}"
helper rename-sql "$SRC" "$ORIG" | psql_run -f - >/dev/null
echo "4/6 복원: pg_restore -> ${SRC}"
dx sh -c 'exec pg_restore --no-owner --no-privileges --exit-on-error -d "$PGDATABASE"' < "$SCRATCH/drill.dump"
echo "5/6 대조"
helper snapshot-sql "$ORIG" | psql_run -At -f - > "$SCRATCH/orig.json"
helper snapshot-sql "$SRC" | psql_run -At -f - > "$SCRATCH/restored.json"
COMPARE_RC=0
RESULT="$(helper compare "$SCRATCH/orig.json" "$SCRATCH/restored.json")" || COMPARE_RC=$?
echo "6/6 정리: 드릴 스키마 삭제"
drop_schemas
DROPPED=1
RESIDUE="$(helper residue-sql | psql_run -At -f -)"
echo "잔여 drill_* 스키마: ${RESIDUE}"
REPORTED=1
if [[ $RESIDUE != "0" ]]; then
  printf '%s\n' "$RESULT" | sed '$d'
  echo "DRILL FAILED 잔여 스키마 ${RESIDUE}"
  exit 1
fi
printf '%s\n' "$RESULT"
exit "$COMPARE_RC"
