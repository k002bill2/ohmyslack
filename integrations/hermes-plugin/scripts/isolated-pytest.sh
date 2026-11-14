#!/usr/bin/env bash
# 격리 pytest 래퍼 — env -i 허용목록 + sandbox-exec(사용자 정의 프로필) + conftest 가드.
# 설계 r4 §Q5 ★구성 1–6, §4 단계 1. sandbox-exec 를 쓸 수 없으면 실행하지 않는다(조용한 폴백 없음).
#
# 모드
#   --preflight      sandbox 안 tests_isolation 실행 + `tests`·`tests_isolation` 수집 부정 검사(outside 노드 0건).
#                    PYTHONPATH 비움 → Hermes import 0.
#   --probe-guard    sandbox 안, 래퍼 표지·격리 env(OHMYSLACK_ISOLATED_RUN·HERMES_HOME·HOME·TMPDIR·
#                    PYTHONPYCACHEPREFIX·PYTHONPATH)만 뺀 `pytest tests --collect-only`. 가드 표지 + rc 3 이면 EXIT 3(PASS).
#   --run --confirm=G3-CLEARED-BY-HUMAN [pytest 인자]
#                    P/tests 실행(사람 전용, G3 = (나) 0–5 확인 뒤). TTY 필수.
#   --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN
#                    tests_outside 실행(사람 전용). TTY·확인 인자·/dev/tty 난수 왕복 입력 3중 장치.
#                    이 장치의 효과는 「우발 실행 방지」뿐이다(I-2) — 의도적 우회(pty 래핑 등)는 막지 못하며,
#                    그 경우는 BRIEF 금지와 에이전트 권한 deny 에 의존한다.
#
# 종료 코드: 0 PASS / 1 검사 실패 / 2 경로 검증 실패(I-1, 아무것도 지우지 않음) / 3 probe-guard PASS /
#           5 사람 전용 모드 거부 / 6 sandbox-exec 없음·사용 불가 / 64 사용법 오류
set -euo pipefail

SANDBOX_EXEC=/usr/bin/sandbox-exec
REALPATH=/bin/realpath
# 운영 포트 거부 목록 — 프로필의 거부 줄은 이 한 목록에서만 생성한다(#3). 사람 실행 --prove-outside 때만 임의 포트 X 추가.
DENY_PORTS=(8787 8788)
# M3: P/.venv/bin/python 링크 대상(BRIEF 기재). 다르면 실행하지 않는다.
PY_HOME=/Users/younghwankang/.hermes/hermes-agent/.hermes-runtime/python/generation-1786174606-20196-ad14ee99/cpython-3.11-macos-aarch64-none
PY_EXE="$PY_HOME/bin/python3.11"
HERMES_SRC="${PY_HOME%%/.hermes-runtime/*}"
ISO_SUBDIRS=(home hermes-home tmp pycache canary-deny)
ISO_FILES=(run-token outside-token profile.sb)

die() { local code=$1; shift; printf 'isolated-pytest: %s\n' "$*" >&2; exit "$code"; }

# ---- P 위치 확인: 논리 경로 = 물리 경로(경로 어디에도 symlink 없음)
P_LOGICAL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -L)"
[ -L "$P_LOGICAL" ] && die 2 "P is a symlink: $P_LOGICAL"
P="$($REALPATH "$P_LOGICAL")"
[ "$P" = "$P_LOGICAL" ] || die 2 "P path has symlink components: $P_LOGICAL -> $P"
case "$P" in */integrations/hermes-plugin) ;; *) die 2 "unexpected P: $P" ;; esac
[ -f "$P/pytest.ini" ] && [ -f "$P/scripts/pytest.sb" ] || die 2 "P layout mismatch: $P"
ISO="$P/.isolation"
VENV_PY="$P/.venv/bin/python"
case "$PY_HOME$HERMES_SRC$P" in *'"'*|*'|'*|*$'\n'*) die 2 "path contains a forbidden character" ;; esac

# ---- I-1: $ISO 와 각 하위가 symlink 가 아니고 realpath 가 기대값인지 (require=1 이면 존재도 요구)
check_node() {
  local path=$1 require=$2
  if [ -L "$path" ]; then die 2 "symlink refused: $path"; fi
  if [ -e "$path" ]; then
    local real; real="$($REALPATH "$path")"
    [ "$real" = "$path" ] || die 2 "realpath mismatch: $path -> $real"
  elif [ "$require" = 1 ]; then
    die 2 "missing after recreate: $path"
  fi
}
check_iso() {
  local require=$1 name
  check_node "$ISO" "$require"
  if [ -e "$ISO" ] && [ ! -d "$ISO" ]; then die 2 "not a directory: $ISO"; fi
  for name in "${ISO_SUBDIRS[@]}"; do check_node "$ISO/$name" "$require"; done
  for name in "${ISO_FILES[@]}"; do check_node "$ISO/$name" 0; done
}
recreate_iso() {
  check_iso 0                       # 확인 먼저 — 어긋나면 아무것도 지우지 않고 EXIT 2
  case "$ISO" in */integrations/hermes-plugin/.isolation) ;; *) die 2 "unexpected ISO: $ISO" ;; esac
  mkdir -p -- "$ISO"
  local name
  for name in "${ISO_SUBDIRS[@]}"; do rm -rf -- "${ISO:?}/$name"; mkdir -- "$ISO/$name"; done
  for name in "${ISO_FILES[@]}"; do rm -f -- "${ISO:?}/$name"; done
  check_iso 1                       # 재생성 뒤 다시 확인
}
# noclobber 로 새 파일만 만든다(미리 심은 symlink 로 밖에 쓰는 것 방지).
write_new() { local path=$1 content=$2; check_node "$path" 0; ( set -C; printf '%s\n' "$content" > "$path" ); check_node "$path" 1; }
new_token() { od -An -tx1 -N16 /dev/urandom | tr -d ' \n'; }
cleanup() { rm -f -- "$ISO/run-token" "$ISO/outside-token"; }

require_sandbox() {
  [ -x "$SANDBOX_EXEC" ] || die 6 "sandbox-exec not found at $SANDBOX_EXEC — refusing to run without sandbox"
  [ -x "$VENV_PY" ] || die 6 "venv interpreter missing: $VENV_PY"
  local link; link="$(readlink "$VENV_PY")"
  [ "$link" = "$PY_EXE" ] || die 6 "M3 mismatch: $VENV_PY -> $link (expected $PY_EXE)"
  # N-13b: cpython-3.11-… 은 cpython-3.11.15-… 로 가는 symlink(L1). Seatbelt 경로 규칙은 실경로에
  # 걸리므로 프로필은 실경로로 렌더링하고, 실경로가 같은 generation 밖이면 실행하지 않는다.
  PY_EXE_REAL="$($REALPATH "$PY_EXE")"
  PY_HOME_REAL="$(dirname -- "$(dirname -- "$PY_EXE_REAL")")"
  case "$PY_HOME_REAL" in "${PY_HOME%/*}"/*) ;; *) die 6 "interpreter real path left the generation dir: $PY_EXE_REAL" ;; esac
}

render_profile() {           # $1 = 추가 거부 포트(선택)
  local extra=${1:-} ports=("${DENY_PORTS[@]}") line port out
  [ -n "$extra" ] && ports+=("$extra")
  out="$(
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = ';;@DENY_PORT_RULES@' ]; then
        for port in "${ports[@]}"; do
          printf '(deny network-outbound (remote ip "localhost:%s"))\n' "$port"
        done
      else
        line=${line//@VENV_PY@/$VENV_PY}; line=${line//@PY_EXE@/$PY_EXE_REAL}; line=${line//@PY_HOME@/$PY_HOME_REAL}
        line=${line//@HERMES_SRC@/$HERMES_SRC}; line=${line//@ISO@/$ISO}; line=${line//@P@/$P}
        printf '%s\n' "$line"
      fi
    done < "$P/scripts/pytest.sb"
  )"
  if printf '%s\n' "$out" | grep -q '@[A-Z_]*@'; then die 1 "unrendered placeholder in profile"; fi
  write_new "$ISO/profile.sb" "$out"
}

# env 허용목록(설계 ★구성 1). PYTHONPATH 는 --run·--prove-outside 때만.
base_env() {
  ENV_ARGS=(PATH=/usr/bin:/bin LANG=C.UTF-8
            HOME="$ISO/home" HERMES_HOME="$ISO/hermes-home" TMPDIR="$ISO/tmp"
            PYTHONPYCACHEPREFIX="$ISO/pycache" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
            PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 OHMYSLACK_ISOLATED_RUN="$RUN_TOKEN")
}
PYTEST_ARGS=(-s -B -m pytest -p pytest_asyncio.plugin -p no:cacheprovider)

# sandbox 안 실행: 출력은 $ISO/tmp/<이름>.out 에 모으고 그대로 보여 준다. rc 는 SB_RC.
sandboxed() {
  local name=$1; shift
  local out="$ISO/tmp/$name.out"
  SB_RC=0
  ( cd "$P" && /usr/bin/env -i "${ENV_ARGS[@]}" "$SANDBOX_EXEC" -f "$ISO/profile.sb" "$VENV_PY" "$@" ) \
    > "$out" 2>&1 || SB_RC=$?
  printf -- '--- [%s] rc=%s\n' "$name" "$SB_RC"
  cat "$out"
  if [ "$SB_RC" -gt 128 ]; then
    SB_FATAL=1
    printf -- '--- [%s] sandboxed child aborted by signal %s (profile too narrow or sandbox unusable) — no fallback\n' "$name" "$((SB_RC - 128))"
  fi
  if grep -q 'sandbox-exec:' "$out"; then
    printf -- '--- [%s] sandbox-exec reported an error (see above) — no fallback\n' "$name"
    SB_FATAL=1
  fi
  SB_OUT="$out"
}

mode_preflight() {
  local fail=0 target
  base_env
  SB_FATAL=0
  sandboxed preflight-tests_isolation "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" tests_isolation -q
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec or sandboxed child failed (signal or sandbox error) — no fallback"
  [ "$SB_RC" = 0 ] || { echo "PREFLIGHT FAIL: tests_isolation rc=$SB_RC"; fail=1; }
  # I-3 부정 검사: 에이전트 모드 수집에 tests_outside 노드 0건. `.`·무인자는 pytest 가 test* 하위
  # 디렉터리 conftest(tests_outside 포함)를 읽으므로 에이전트 preflight 에서 돌리지 않는다(사람 확인 목록).
  for target in tests_isolation tests; do
    sandboxed "collect-$target" "${PYTEST_ARGS[@]}" --collect-only -q "$target"
    if [ "$SB_RC" != 0 ]; then echo "PREFLIGHT FAIL: collect $target rc=$SB_RC"; fail=1; fi
    if grep -q 'tests_outside' "$SB_OUT"; then echo "PREFLIGHT FAIL: tests_outside node collected for $target"; fail=1; fi
  done
  [ "$fail" = 0 ] || exit 1
  echo "PREFLIGHT PASS"
}

mode_probe_guard() {
  # 래퍼 표지·격리 env 만 뺀다. 나머지(PATH·LANG·PYTHONDONTWRITEBYTECODE·PYTHONNOUSERSITE·
  # PYTEST_DISABLE_PLUGIN_AUTOLOAD)는 유지 — OS 격리는 그대로.
  ENV_ARGS=(PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1)
  SB_FATAL=0
  # TMPDIR 이 없으면 pytest 출력 캡처가 임시 파일을 못 만들어 가드 전에 끝난다(/tmp 등 쓰기 거부 — probe-guard-1 실측).
  sandboxed probe-guard "${PYTEST_ARGS[@]}" --capture=no tests -q --collect-only
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec or sandboxed child failed (signal or sandbox error) — no fallback"
  if [ "$SB_RC" = 3 ] && grep -q 'OHMYSLACK-ISOLATION-GUARD-REFUSED' "$SB_OUT"; then
    echo "PROBE-GUARD PASS: rc=3 with guard marker"
    exit 3
  fi
  echo "PROBE-GUARD FAIL: rc=$SB_RC (guard marker $(grep -c 'OHMYSLACK-ISOLATION-GUARD-REFUSED' "$SB_OUT" || true) lines)"
  exit 1
}

require_human() {            # $1 = 기대 확인 인자
  [ -t 0 ] && [ -t 1 ] || die 5 "human-only mode: stdin and stdout must both be a TTY"
  [ "$CONFIRM" = "$1" ] || die 5 "human-only mode: --confirm=$1 required"
  local code answer
  code="$(od -An -tu2 -N2 /dev/urandom | tr -d ' ')"; code=$(printf '%04d' $((code % 10000)))
  printf 'type this code to continue: %s\n> ' "$code" > /dev/tty
  IFS= read -r answer < /dev/tty || die 5 "no input from /dev/tty"
  [ "$answer" = "$code" ] || die 5 "code mismatch"
}

mode_run() {
  require_human "G3-CLEARED-BY-HUMAN"
  base_env; ENV_ARGS+=(PYTHONPATH="$HERMES_SRC")
  SB_FATAL=0
  sandboxed run "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" tests "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec failed"
  exit "$SB_RC"
}

mode_prove_outside() {
  require_human "OUTSIDE-PROBE-BY-HUMAN"
  local port=$(( (RANDOM % 30000) + 20000 ))
  case " ${DENY_PORTS[*]} " in *" $port "*) port=$((port + 1)) ;; esac
  rm -f -- "$ISO/profile.sb"; render_profile "$port"
  write_new "$ISO/outside-token" "$(new_token)"
  base_env
  ENV_ARGS+=(PYTHONPATH="$HERMES_SRC" OHMYSLACK_OUTSIDE_PROBE="$(cat "$ISO/outside-token")"
             OHMYSLACK_OUTSIDE_PORT="$port" OHMYSLACK_REAL_HOME="$REAL_HOME")
  SB_FATAL=0
  sandboxed prove-outside "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" \
    -c tests_outside/pytest.ini --rootdir=tests_outside tests_outside -q
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec failed"
  exit "$SB_RC"
}

# ---- 인자
MODE="${1:-}"; [ $# -gt 0 ] && shift
CONFIRM=""; EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in --confirm=*) CONFIRM="${1#--confirm=}" ;; *) EXTRA_ARGS+=("$1") ;; esac
  shift
done
REAL_HOME="${HOME:-}"
case "$MODE" in
  --preflight|--probe-guard|--run|--prove-outside) ;;
  *) die 64 "usage: $0 --preflight | --probe-guard | --run --confirm=G3-CLEARED-BY-HUMAN [args] | --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN" ;;
esac
if [ "$MODE" != --run ] && [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then die 64 "extra arguments are only accepted with --run"; fi

require_sandbox
recreate_iso
trap cleanup EXIT
RUN_TOKEN="$(new_token)"
write_new "$ISO/run-token" "$RUN_TOKEN"
render_profile ""

case "$MODE" in
  --preflight) mode_preflight ;;
  --probe-guard) mode_probe_guard ;;
  --run) mode_run ;;
  --prove-outside) mode_prove_outside ;;
esac
