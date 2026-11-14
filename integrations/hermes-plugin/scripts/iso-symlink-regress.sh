#!/usr/bin/env bash
# P1(Codex 1차) symlink 회귀 — $ISO(.isolation) 가 다른 디렉터리를 가리키는 symlink 일 때 아무것도 지우지 않는지.
# Python·sandbox 실행 없음(셸만). 사용: bash scripts/iso-symlink-regress.sh <대상 디렉터리(worktree 안)>
#   (가) 래퍼 --preflight → EXIT ≠ 0, 대상 보존(앞단 검사 check_iso).
#   (나) 검사를 건너뛰고 삭제 함수(scripts/_iso_fs.sh)를 직접 호출 → ≠ 0, 대상 보존.
#        = 「검사 뒤 $ISO 가 symlink 로 바뀐」 경쟁을 결정적으로 재현한다. 정리 코드를 rm -rf 로
#        되돌리면 여기서 FAIL 한다(뮤테이션 P1).
# 끝나면 symlink 만 지운다(대상은 남김). 종료 코드: 0 PASS / 1 FAIL / 64 사용법·전제 오류.
set -euo pipefail

P="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT="$(cd -- "$P/../.." && pwd -P)"
ISO="$P/.isolation"
# shellcheck source=_iso_fs.sh
. "$P/scripts/_iso_fs.sh"

usage() { printf 'iso-symlink-regress: %s\n' "$*" >&2; exit 64; }
[ $# -eq 1 ] || usage "usage: $0 <target-dir inside the worktree>"
mkdir -p -- "$1"
TARGET="$(cd -- "$1" && pwd -P)"
case "$TARGET/" in "$ROOT"/*) ;; *) usage "target must be inside the worktree ($ROOT): $TARGET" ;; esac
case "$TARGET/" in "$ISO"/*|"$P/.venv"/*) usage "target must not be under .isolation or .venv: $TARGET" ;; esac

# 전제: $ISO 는 없거나 일반 디렉터리(래퍼 산출물 — 매 실행 재생성됨). symlink 면 상태를 모르므로 중단.
[ ! -L "$ISO" ] || usage "$ISO is already a symlink — inspect it by hand"
iso_wipe "$ISO" || usage "could not clear $ISO"

mkdir -p -- "$TARGET/home"
printf 'keep\n' > "$TARGET/sentinel"
printf 'keep\n' > "$TARGET/home/sentinel"
printf 'keep\n' > "$TARGET/run-token"
ln -s -- "$TARGET" "$ISO"
trap '[ -L "$ISO" ] && rm -- "$ISO"' EXIT     # 링크 자체만 지운다(경로 끝에 / 없음)

fail=0
check_kept() {
  local f
  for f in sentinel home/sentinel run-token; do
    if [ -f "$TARGET/$f" ]; then echo "  kept: $f"; else echo "  LOST: $f"; fail=1; fi
  done
}

echo "== (가) wrapper --preflight with $ISO -> $TARGET"
rc=0; out="$(bash "$P/scripts/isolated-pytest.sh" --preflight 2>&1)" || rc=$?
printf '%s\n' "$out" | sed 's/^/  | /'
echo "  wrapper rc=$rc"
[ "$rc" != 0 ] || { echo "  FAIL: wrapper exited 0"; fail=1; }
check_kept

echo "== (나) iso_wipe directly (check skipped — simulates a swap after the check)"
rc=0; iso_wipe "$ISO" || rc=$?
echo "  iso_wipe rc=$rc"
[ "$rc" != 0 ] || { echo "  FAIL: iso_wipe returned 0 on a symlinked ISO"; fail=1; }
check_kept

echo "== (나) iso_rm_files directly (cleanup path)"
rc=0; iso_rm_files "$ISO" run-token outside-token || rc=$?
echo "  iso_rm_files rc=$rc"
[ "$rc" != 0 ] || { echo "  FAIL: iso_rm_files returned 0 on a symlinked ISO"; fail=1; }
check_kept

[ -L "$ISO" ] || { echo "  FAIL: $ISO symlink itself disappeared"; fail=1; }
if [ "$fail" = 0 ]; then echo "SYMLINK-REGRESS PASS"; exit 0; fi
echo "SYMLINK-REGRESS FAIL"; exit 1
