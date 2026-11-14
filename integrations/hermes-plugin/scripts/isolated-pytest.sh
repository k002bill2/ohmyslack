#!/usr/bin/env bash
# 격리 pytest 래퍼 — env -i 허용목록 + sandbox-exec(사용자 정의 프로필) + conftest 가드.
# 설계 r4 §Q5 ★구성 1–6, §4 단계 1. sandbox-exec 를 쓸 수 없으면 실행하지 않는다(조용한 폴백 없음).
#
# 모드
#   --preflight      sandbox 안 tests_isolation 실행 → 수집 부정 검사 4조합(무인자·`.`·`tests`·`tests_isolation`,
#                    각 rc 0 + probe_outside 노드·outside 표지 0건) → `probe_outside` 직접 지정 수집이 rc 4 + outside
#                    표지인지. 첫 실패·신호·sandbox 오류에서 즉시 종료(뒤 수집 0). PYTHONPATH 비움 → Hermes import 0.
#   --probe-guard    sandbox 안, 래퍼 표지·격리 env(OHMYSLACK_ISOLATED_RUN·HERMES_HOME·HOME·TMPDIR·
#                    PYTHONPYCACHEPREFIX·PYTHONPATH)만 뺀 `pytest tests --collect-only`. 가드 표지 + rc 3 이면 EXIT 3(PASS).
#   --run --confirm=G3-CLEARED-BY-HUMAN [pytest 인자]
#                    P/tests 실행(사람 전용, G3 = (나) 0–5 확인 뒤). TTY 필수.
#   --run-attested [-q] [-x] [-k <expr>]
#                    P/tests 실행(레인·에이전트용, TTY·난수 입력 없음). 시작 전에 scripts/pytest.sb·scripts/_iso_fs.sh 의
#                    sha256 을 scripts/G3-ATTESTATION(사람 G3 확인 기록)과 대조하고, 없음·형식 오류·불일치면
#                    아무것도 하지 않고(_iso_fs.sh source·.isolation 재생성 전) EXIT 5 + `re-attestation by human required`.
#                    env·sandbox·가드는 --run 과 같은 run_tests 경로. 한계: 우발 실행·무심사 프로필 변경 방지일 뿐,
#                    저장소 쓰기 권한이 있는 행위자의 의도적 우회(래퍼·가드·이 파일 자체 수정)는 막지 못한다 —
#                    해시는 두 파일만 덮는다.
#   --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN
#                    probe_outside 실행(사람 전용). TTY·확인 인자·/dev/tty 난수 왕복 입력 3중 장치.
#                    이 장치의 효과는 「우발 실행 방지」뿐이다(I-2) — 의도적 우회(pty 래핑 등)는 막지 못하며,
#                    그 경우는 BRIEF 금지와 에이전트 권한 deny 에 의존한다.
#
# 종료 코드: 0 PASS / 1 검사 실패 / 2 경로 검증 실패(I-1, 아무것도 지우지 않음) / 3 probe-guard PASS /
#           5 사람 전용 모드 거부·G3 해시 대조 실패(--run-attested) / 6 sandbox-exec 없음·사용 불가 / 64 사용법 오류
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

# ---- G3 해시 대조(--run-attested). ATTESTATION 은 source 하지 않고 키별로 grep 한다.
SHASUM=/usr/bin/shasum
ATTEST_KEYS=(profile_sha256 iso_fs_sha256 attested_at evidence main_commit)
attest_value() { sed -n "s/^$2=//p" "$1"; }
sha256_of() { [ -f "$1" ] && [ ! -L "$1" ] || return 1; "$SHASUM" -a 256 < "$1" | cut -d' ' -f1; }
# $1 = pytest.sb·_iso_fs.sh·G3-ATTESTATION 이 있는 디렉터리. 0 = 일치, 5 = 없음·형식 오류·불일치(사유 stderr).
attest_verify() {
  local dir=$1 file="$1/G3-ATTESTATION" key n v
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "attestation: missing or not a regular file: $file" >&2; return 5; }
  # -q 를 쓰지 않는다(조기 종료 SIGPIPE 가 pipefail 로 「문제 없음」처럼 보이는 것 방지).
  v="$(grep -v -E '^(#.*)?$' "$file" | grep -v -E '^(profile_sha256|iso_fs_sha256|attested_at|evidence|main_commit)=' || true)"
  [ -z "$v" ] || { echo "attestation: unknown or malformed line" >&2; return 5; }
  for key in "${ATTEST_KEYS[@]}"; do
    n="$(grep -c -E "^$key=" "$file" || true)"
    [ "$n" = 1 ] || { echo "attestation: $key must appear exactly once (found $n)" >&2; return 5; }
  done
  for key in profile_sha256 iso_fs_sha256; do
    v="$(attest_value "$file" "$key")"
    [[ "$v" =~ ^[0-9a-f]{64}$ ]] || { echo "attestation: $key is not 64 lowercase hex" >&2; return 5; }
  done
  [[ "$(attest_value "$file" attested_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "attestation: attested_at is not YYYY-MM-DD" >&2; return 5; }
  [[ "$(attest_value "$file" main_commit)" =~ ^[0-9a-f]{7,40}$ ]] || { echo "attestation: main_commit is not a commit id" >&2; return 5; }
  [ -n "$(attest_value "$file" evidence)" ] || { echo "attestation: evidence is empty" >&2; return 5; }
  [ "$(sha256_of "$dir/pytest.sb" || true)" = "$(attest_value "$file" profile_sha256)" ] \
    || { echo "attestation: scripts/pytest.sb sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_of "$dir/_iso_fs.sh" || true)" = "$(attest_value "$file" iso_fs_sha256)" ] \
    || { echo "attestation: scripts/_iso_fs.sh sha256 differs from G3-ATTESTATION" >&2; return 5; }
  return 0
}
attest_gate() { attest_verify "$1" || die 5 "G3 attestation check failed — re-attestation by human required (nothing was run)"; }
# 바뀐 _iso_fs.sh 가 source 되기 전에, .isolation 을 건드리기 전에 대조한다.
if [ "${1:-}" = --run-attested ]; then attest_gate "$P/scripts"; fi

# shellcheck source=_iso_fs.sh
. "$P/scripts/_iso_fs.sh"
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
  # Codex 1차 P1: rm -rf 대신 symlink 를 따라가지 않는 삭제(scripts/_iso_fs.sh). $ISO 를 통째로 지우고
  # 새 mkdir 로 만든다(-p 없음 — 그 사이 무엇이든 생겼으면 실패, 기존 경로 재사용 없음).
  iso_wipe "$ISO" || die 2 "refused to wipe (symlink or not a directory): $ISO"
  local name
  ( umask 077 && mkdir -- "$ISO" ) || die 2 "mkdir failed (path reappeared?): $ISO"
  check_node "$ISO" 1
  for name in "${ISO_SUBDIRS[@]}"; do mkdir -- "$ISO/$name" || die 2 "mkdir failed: $ISO/$name"; done
  check_iso 1                       # 재생성 뒤 다시 확인
}
# noclobber 로 새 파일만 만든다(미리 심은 symlink 로 밖에 쓰는 것 방지).
write_new() { local path=$1 content=$2; check_node "$path" 0; ( set -C; printf '%s\n' "$content" > "$path" ); check_node "$path" 1; }
new_token() { od -An -tx1 -N16 /dev/urandom | tr -d ' \n'; }
# 종료 때 토큰 파일만 지운다 — $ISO 가 그새 symlink 가 됐으면 아무것도 지우지 않는다(iso_rm_files).
cleanup() { iso_rm_files "$ISO" run-token outside-token || printf 'isolated-pytest: cleanup skipped (ISO is not a plain directory): %s\n' "$ISO" >&2; }

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
  local extra=${1:-} ports=("${DENY_PORTS[@]}") line port out src_re
  src_re="$(printf '%s' "$HERMES_SRC" | sed 's/[][\.^$*+?(){}|]/\\&/g')"
  [ -n "$extra" ] && ports+=("$extra")
  out="$(
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = ';;@DENY_PORT_RULES@' ]; then
        for port in "${ports[@]}"; do
          printf '(deny network-outbound (remote ip "localhost:%s"))\n' "$port"
        done
      else
        line=${line//@VENV_PY@/$VENV_PY}; line=${line//@PY_EXE@/$PY_EXE_REAL}; line=${line//@PY_HOME@/$PY_HOME_REAL}
        line=${line//@HERMES_SRC_RE@/$src_re}; line=${line//@HERMES_SRC@/$HERMES_SRC}; line=${line//@ISO@/$ISO}; line=${line//@P@/$P}
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

OUTSIDE_DIR=probe_outside                    # 사람 전용 디렉터리 — test* 로 시작하지 않는다(pytest 가 test* 하위 conftest 를 자동으로 읽음)
OUTSIDE_MARKER=OHMYSLACK-OUTSIDE-GUARD-REFUSED

# 수집 뒤 공통 판정: sandbox 오류·신호면 EXIT 6, 그 밖의 실패는 EXIT 1 — 둘 다 즉시(뒤 수집 0, Codex 1차 P2).
preflight_stop_if_fatal() {
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec or sandboxed child failed in [$1] (signal or sandbox error) — no fallback, nothing more collected"
}
preflight_fail() { echo "PREFLIGHT FAIL: $*"; echo "PREFLIGHT STOPPED: no further collection after the first failure"; exit 1; }

# --run-attested 해시 대조 자기시험(sandbox 밖, sandbox 안에서는 bash·shasum 을 exec 할 수 없음).
# $ISO/tmp 안 복사본만 바꾼다(작업 트리 파일 불변). 결과는 tests_isolation/test_attestation.py 가 sandbox 안에서 단언.
attest_selftest() {
  local d="$ISO/tmp/attest-selftest" rc_ok=0 rc_profile=0 rc_isofs=0
  mkdir -- "$d" || die 1 "attest selftest: mkdir failed: $d"
  cp -- "$P/scripts/pytest.sb" "$P/scripts/_iso_fs.sh" "$P/scripts/G3-ATTESTATION" "$d/"
  ( attest_gate "$d" ) 2> "$d/unmodified.err" || rc_ok=$?
  cp -- "$P/scripts/pytest.sb" "$d/pytest.sb.orig"
  printf ' ' >> "$d/pytest.sb"
  ( attest_gate "$d" ) 2> "$d/profile_modified.err" || rc_profile=$?
  mv -- "$d/pytest.sb.orig" "$d/pytest.sb"
  printf '\n' >> "$d/_iso_fs.sh"
  ( attest_gate "$d" ) 2> "$d/iso_fs_modified.err" || rc_isofs=$?
  printf 'unmodified=%s\nprofile_modified=%s\niso_fs_modified=%s\n' "$rc_ok" "$rc_profile" "$rc_isofs" > "$d/result"
}

mode_preflight() {
  local label
  base_env
  SB_FATAL=0
  attest_selftest
  sandboxed preflight-tests_isolation "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" tests_isolation -q
  preflight_stop_if_fatal preflight-tests_isolation
  [ "$SB_RC" = 0 ] || preflight_fail "tests_isolation rc=$SB_RC"
  # I-3 부정 검사(G2): 네 호출 조합 모두 rc 0 + probe_outside 노드·outside 표지 0건.
  # 무인자 = testpaths(tests), `.` = 하위 전체(--ignore=probe_outside 가 막아야 함).
  for label in noargs dot tests tests_isolation; do
    case "$label" in
      noargs) set -- ;;
      dot) set -- . ;;
      *) set -- "$label" ;;
    esac
    sandboxed "collect-$label" "${PYTEST_ARGS[@]}" --collect-only -q "$@"
    preflight_stop_if_fatal "collect-$label"
    [ "$SB_RC" = 0 ] || preflight_fail "collect $label rc=$SB_RC"
    if grep -q -e "$OUTSIDE_DIR" -e "$OUTSIDE_MARKER" -e 'tests_outside' "$SB_OUT"; then
      preflight_fail "outside node or marker in collect $label"
    fi
  done
  # 직접 지정: outside conftest 가 실제로 연결돼 첫 동작에서 끊는지 — rc 4 + outside 고유 표지(둘 다).
  # --collect-only 라 시험 함수는 돌지 않고, 표지 검사는 그 conftest 의 첫 동작이다(outside-token 없음 → 거부).
  # --capture=no: PYTEST_ARGS 의 -s 는 python 플래그다. pytest fd 캡처가 켜져 있으면 os._exit 가 표지를 버린다(fix-preflight-1 실측).
  sandboxed "collect-direct-$OUTSIDE_DIR" "${PYTEST_ARGS[@]}" --capture=no --collect-only -q "$OUTSIDE_DIR"
  preflight_stop_if_fatal "collect-direct-$OUTSIDE_DIR"
  if [ "$SB_RC" != 4 ] || ! grep -q "$OUTSIDE_MARKER" "$SB_OUT"; then
    preflight_fail "direct $OUTSIDE_DIR: expected rc=4 with $OUTSIDE_MARKER, got rc=$SB_RC"
  fi
  if grep -q '::' "$SB_OUT"; then preflight_fail "direct $OUTSIDE_DIR: test nodes were listed"; fi
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

# --run·--run-attested 공통 실행 경로(env·sandbox·가드 동일). 두 모드의 차이는 시작 조건뿐이다.
run_tests() {
  base_env; ENV_ARGS+=(PYTHONPATH="$HERMES_SRC")
  SB_FATAL=0
  sandboxed run "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" tests "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec failed"
  exit "$SB_RC"
}

mode_run() {
  require_human "G3-CLEARED-BY-HUMAN"
  run_tests
}

# 해시 대조는 스크립트 앞부분(attest_gate)에서 이미 끝났다 — 여기 오면 일치한 것.
mode_run_attested() { run_tests; }

# --run-attested 는 -q·-x·-k <식> 만 받는다(-p·-c·--rootdir 등으로 수집 대상·플러그인을 바꾸지 못하게).
check_attested_args() {
  local i=0 n=${#EXTRA_ARGS[@]}
  [ -z "$CONFIRM" ] || die 64 "--run-attested takes no --confirm"
  while [ "$i" -lt "$n" ]; do
    case "${EXTRA_ARGS[$i]}" in
      -q|-x) ;;
      -k) i=$((i + 1))
          [ "$i" -lt "$n" ] || die 64 "-k needs an expression"
          case "${EXTRA_ARGS[$i]}" in -*) die 64 "-k expression must not start with -" ;; esac ;;
      *) die 64 "--run-attested accepts only -q, -x, -k <expr> (got: ${EXTRA_ARGS[$i]})" ;;
    esac
    i=$((i + 1))
  done
}

mode_prove_outside() {
  require_human "OUTSIDE-PROBE-BY-HUMAN"
  local port=$(( (RANDOM % 30000) + 20000 ))
  case " ${DENY_PORTS[*]} " in *" $port "*) port=$((port + 1)) ;; esac
  iso_rm_files "$ISO" profile.sb || die 2 "refused to remove profile (ISO is not a plain directory): $ISO"
  render_profile "$port"
  write_new "$ISO/outside-token" "$(new_token)"
  base_env
  ENV_ARGS+=(PYTHONPATH="$HERMES_SRC" OHMYSLACK_OUTSIDE_PROBE="$(cat "$ISO/outside-token")"
             OHMYSLACK_OUTSIDE_PORT="$port" OHMYSLACK_REAL_HOME="$REAL_HOME")
  SB_FATAL=0
  sandboxed prove-outside "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" \
    -c "$OUTSIDE_DIR/pytest.ini" --rootdir="$OUTSIDE_DIR" "$OUTSIDE_DIR" -q
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
  --preflight|--probe-guard|--run|--run-attested|--prove-outside) ;;
  *) die 64 "usage: $0 --preflight | --probe-guard | --run --confirm=G3-CLEARED-BY-HUMAN [args] | --run-attested [-q] [-x] [-k <expr>] | --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN" ;;
esac
if [ "$MODE" = --run-attested ]; then check_attested_args
elif [ "$MODE" != --run ] && [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then die 64 "extra arguments are only accepted with --run or --run-attested"; fi

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
  --run-attested) mode_run_attested ;;
  --prove-outside) mode_prove_outside ;;
esac
