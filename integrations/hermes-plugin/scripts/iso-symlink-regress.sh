#!/usr/bin/env bash
# P1(Codex 1차) symlink 회귀 — $ISO(.isolation) 가 다른 디렉터리를 가리키는 symlink 일 때 아무것도 지우지 않는지.
# Python·sandbox 실행 없음(셸만). 사용: bash scripts/iso-symlink-regress.sh   (무인자)
#   대상: 검증된 부모 $ROOT/dev/active/p2s1-1a-isolation/logs(symlink·worktree 밖이면 아무것도 만들지 않고 EXIT 64)
#   아래 mktemp -d 로 만든 새 디렉터리 symlink-target.XXXXXX — 기존 경로 재사용 없음.
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
[ $# -eq 0 ] || usage "usage: $0   (no arguments — the target is chosen by this script)"

# 대상은 스크립트가 정한다: 검증된 부모 아래 mktemp -d 로 만든 새 디렉터리. 검증 전에는 아무것도 만들지 않는다.
REL="dev/active/p2s1-1a-isolation/logs"
# 1) 검증: $ROOT 에서 $REL 까지 존재하는 구간은 모두 symlink 가 아닌 일반 디렉터리여야 한다.
cur="$ROOT"; missing=0
IFS=/ read -r -a parts <<< "$REL"
for seg in "${parts[@]}"; do
  cur="$cur/$seg"
  if [ -L "$cur" ]; then usage "path component is a symlink: $cur"; fi
  if [ -e "$cur" ]; then
    [ -d "$cur" ] || usage "path component is not a directory: $cur"
    [ "$missing" = 0 ] || usage "internal: existing path after a missing one: $cur"
  else
    missing=1
  fi
done
# 2) 검증 통과 후에만 없는 구간을 만든다(한 단계씩 mkdir — 방금 만든 것이므로 링크가 아님).
cur="$ROOT"
for seg in "${parts[@]}"; do
  cur="$cur/$seg"
  [ -d "$cur" ] || mkdir -- "$cur"
done
PARENT="$(cd -- "$cur" && pwd -P)"
case "$PARENT/" in "$ROOT"/*) ;; *) usage "parent resolves outside the worktree ($ROOT): $PARENT" ;; esac
case "$PARENT/" in "$ISO"/*|"$P/.venv"/*) usage "parent must not be under .isolation or .venv: $PARENT" ;; esac
TARGET_RAW="$(mktemp -d "$PARENT/symlink-target.XXXXXX")"
TARGET="$(cd -- "$TARGET_RAW" && pwd -P)"
case "$TARGET/" in "$PARENT"/*) ;; *) usage "mktemp target escaped the parent: $TARGET" ;; esac
echo "target (kept as evidence): $TARGET"

# 전제: $ISO 는 없거나 일반 디렉터리(래퍼 산출물 — 매 실행 재생성됨). symlink 면 상태를 모르므로 중단.
[ ! -L "$ISO" ] || usage "$ISO is already a symlink — inspect it by hand"
# 준비 단계는 시험 대상 함수(iso_wipe)를 쓰지 않는다 — 뮤테이션이 준비를 망치면 엉뚱한 이유로 FAIL 한다.
if [ -d "$ISO" ]; then find -P "$ISO" -delete; fi
[ ! -e "$ISO" ] && [ ! -L "$ISO" ] || usage "could not clear $ISO"

for p in "$TARGET/home" "$TARGET/sentinel" "$TARGET/run-token"; do
  { [ ! -e "$p" ] && [ ! -L "$p" ]; } || usage "unexpected pre-existing path in fresh target: $p"
done
mkdir -- "$TARGET/home"
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
