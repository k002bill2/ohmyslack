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
#                    P/tests 실행(레인·에이전트용, TTY·난수 입력 없음). 시작 전에 해시 대상 6파일 — scripts/pytest.sb·
#                    scripts/_iso_fs.sh·래퍼 자신(scripts/isolated-pytest.sh)·tests/_isolation_guard.py·tests/conftest.py·
#                    pytest.ini — 의 sha256 을 scripts/G3-ATTESTATION(사람 G3 확인 기록)과 대조하고, 없음(대상 파일 포함)·
#                    형식 오류·불일치면 아무것도 하지 않고(layout 검사·_iso_fs.sh 적재·.isolation 재생성 전) EXIT 5 +
#                    `re-attestation by human required`. 각 파일은 한 번만 읽어 메모리 스냅숏으로 대조한다; pytest.sb·
#                    _iso_fs.sh 는 그 스냅숏으로 적재·렌더한다(검사한 바이트 = 쓰는 바이트). env·sandbox·가드는 --run 과
#                    같은 run_tests 경로. 한계: 우발 실행·무심사 변경 방지일 뿐, 저장소 쓰기 권한이 있는 행위자의 의도적
#                    우회(래퍼에서 이 검사를 지우는 수정, 승인 파일 자체 수정)는 막지 못한다. 가드·conftest·pytest.ini 는
#                    sandbox 안 Python(pytest)이 다시 읽으므로 대조 시점과 실행 시점 사이 변경(TOCTOU)은 못 막는다. 래퍼도
#                    bash 가 실행 중 파일을 조금씩 읽으므로 대조 뒤 실행 중 변경은 같은 한계다.
#                    한계(QA O-1): symlink 거부는 파일 단위다 — 해시 대상 파일 자신이 symlink 면 거부하지만, 상위 디렉터리
#                    (scripts/·tests/)가 symlink 인 경우는 따로 거부하지 않고 해시(내용)로만 보호한다(P 경로 자체의 symlink
#                    는 아래 P 위치 확인이 EXIT 2). 한계(QA O-2): 스냅숏은 bash 명령 치환이라 NUL 바이트가 제거된 뒤
#                    해시된다 — 해시 대상은 텍스트(bash·sandbox 프로필·Python·ini)라 NUL 을 넣는 변경은 bash·Python·
#                    pytest 가 해석하는 의미를 바꾸기 전에 그 자체로 파일을 깨뜨리고, NUL 이 없는 바이트는 전부 해시된다.
#                    해시 대상을 편집한 뒤 사람 재승인 전에는 --preflight 도 FAIL 이 정상이다(자기시험 기준 = 실제 승인
#                    파일) — 에이전트·구현자는 임시 승인 파일로 --preflight 만 확인하고 원본을 복원한다(--run* 금지).
#                    한계(QA O-4): 아래 「호출 환경 고정」 참조.
#   --run-live       실서버 live 테스트(scripts/live-e2e.sh 가 부른다, Issue #47). 시작 게이트는 --run-attested 와 같은
#                    G3 해시 대조(불일치 EXIT 5). 인자 0개(--confirm 포함 무엇이든 오면 EXIT 64). 래퍼 자기 env 에서
#                    OHMYSLACK_LIVE_E2E=1, OHMYSLACK_BOT_URL·OHMYSLACK_LIVE_MAIN_URL·OHMYSLACK_LIVE_ORIGIN
#                    (각각 정확히 http://127.0.0.1:<1024-65535>, DENY_PORTS 아님), OHMYSLACK_BOT_TOKEN·OHMYSLACK_LIVE_COOKIE·
#                    OHMYSLACK_LIVE_CSRF(비어 있지 않은 한 줄)를 검증하고 위반이면 EXIT 64(사유만, 값은 출력하지 않음).
#                    비밀 3개는 argv 에 싣지 않고 $ISO 아래 0600 새 파일(write_new, noclobber·symlink 거부)에 쓰고 sandbox env
#                    에는 *_FILE 경로만 넘긴다. pytest 인자는 고정 `-q -m live tests/test_live_e2e.py tests/test_live_standalone.py`.
#                    env·sandbox·가드는 run_tests 와 같다(허용목록 + PYTHONPATH + live 값 7개는 이 모드에서만).
#   --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN
#                    probe_outside 실행(사람 전용). TTY·확인 인자·/dev/tty 난수 왕복 입력 3중 장치.
#                    이 장치의 효과는 「우발 실행 방지」뿐이다(I-2) — 의도적 우회(pty 래핑 등)는 막지 못하며,
#                    그 경우는 BRIEF 금지와 에이전트 권한 deny 에 의존한다.
#
# 종료 코드: 0 PASS / 1 검사 실패 / 2 경로 검증 실패(I-1, 아무것도 지우지 않음) / 3 probe-guard PASS /
#           5 사람 전용 모드 거부·G3 해시 대조 실패(--run-attested·--run-live) / 6 sandbox-exec 없음·사용 불가 /
#           64 사용법 오류(--run-live 의 인자·env 검증 실패 포함)
#
# ---- 호출 환경 고정(QA O-4) — 옵션 해석·해시 게이트보다 먼저. 해시 대조가 부르는 외부 명령이 호출자 PATH·export 된
# 함수(BASH_FUNC_*)·CDPATH 의 영향을 받지 않게 한다.
#   - 하는 것: (1) 이 bash 에 import 된 같은 이름의 함수 정의를 지운다(래퍼·게이트가 쓰는 외부 명령·내장 명령 이름).
#     (2) PATH=/usr/bin:/bin 고정·export(자식 명령에도 같은 값). (3) CDPATH·BASH_ENV·ENV unset — CDPATH 는 아래 P 위치
#     확인의 `cd` 를, BASH_ENV·ENV 는 이 래퍼가 띄우는 자식 bash(자기시험 복사본은 env -i 라 원래 없음)를 바꿀 수 있다.
#     (4) 게이트(snap_read·sha256_text·attest_value·attest_verify_snapshot)는 외부 명령을 절대 경로로 부른다
#     (/bin/cat·/usr/bin/grep·/usr/bin/sed·/usr/bin/cut·/usr/bin/shasum).
#   - 한계: BASH_ENV 는 bash 가 이 스크립트를 읽기 전에 이미 실행했고, SHELLOPTS·BASHOPTS 도 시작 때 적용된다 — 여기서
#     되돌릴 수 없다. `builtin`·`unset` 이름의 export 함수가 있으면 (1) 자체가 무력화될 수 있다. 호출자가 env 를 통째로
#     고를 수 있는 행위자는 래퍼를 어차피 마음대로 실행할 수 있으므로, 이 고정은 「우발적인 셸 환경(다른 PATH 의 GNU
#     coreutils, 사용자 alias 성 함수)」이 대조 결과를 바꾸지 않게 하는 장치다. sandbox 안 env 는 원래 base_env 허용목록
#     (PATH=/usr/bin:/bin 포함, env -i)이라 이 고정과 무관하게 바뀌지 않는다.
builtin unset -f -- cat grep sed cut shasum realpath readlink dirname env bash mkdir rm mv ln od tr find stat \
  printf echo test '[' cd pwd read local return exit eval set shift umask trap command type source . 2>/dev/null || true
PATH=/usr/bin:/bin
export PATH
builtin unset CDPATH BASH_ENV ENV 2>/dev/null || true
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
ISO_FILES=(run-token outside-token profile.sb snapshot-pytest.sb snapshot-_iso_fs.sh live-bot-token live-cookie live-csrf)
# --run-live 비밀 파일(0600). 종료 때 cleanup 이 run-token 과 함께 지운다.
LIVE_SECRET_FILES=(live-bot-token live-cookie live-csrf)

die() { local code=$1; shift; printf 'isolated-pytest: %s\n' "$*" >&2; exit "$code"; }

# ---- P 위치 확인: 논리 경로 = 물리 경로(경로 어디에도 symlink 없음)
P_LOGICAL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -L)"
[ -L "$P_LOGICAL" ] && die 2 "P is a symlink: $P_LOGICAL"
P="$($REALPATH "$P_LOGICAL")"
[ "$P" = "$P_LOGICAL" ] || die 2 "P path has symlink components: $P_LOGICAL -> $P"
case "$P" in */integrations/hermes-plugin) ;; *) die 2 "unexpected P: $P" ;; esac
ISO="$P/.isolation"
VENV_PY="$P/.venv/bin/python"

# ---- 스냅숏(Codex 1차 P2-1, Issue #48 확대): P 루트 기준 scripts/{G3-ATTESTATION,pytest.sb,_iso_fs.sh}·
# tests/{_isolation_guard.py,conftest.py}·pytest.ini·실행 중인 래퍼(${BASH_SOURCE[0]}) 원본은 여기서 한 번씩만 연다.
# 이후 해시 대조·_iso_fs.sh 적재(eval)·프로필 렌더·자기시험 복사본은 모두 이 메모리 스냅숏(같은 바이트)을 쓰고,
# recreate_iso 뒤 $ISO 에 pytest.sb·_iso_fs.sh 복사본을 남긴다. $ISO 를 먼저 만들 수 없는 이유: $ISO 재생성(iso_wipe)이
# 검증 전 _iso_fs.sh 를 필요로 한다. 가드·conftest·pytest.ini 스냅숏은 대조·자기시험 복사본에만 쓰인다 — sandbox 안
# Python(pytest)은 원본을 다시 읽는다(대조 바이트 = 실행 바이트 보장 없음, TOCTOU 한계). 아래 layout 검사
# `[ -f "$P/pytest.ini" ]` 는 존재 확인(stat)일 뿐 내용을 열지 않는다(「한 번만 연다」 원칙과 충돌 없음).
# here-string·heredoc 금지(bash 3.2 는 $TMPDIR·/tmp 임시 파일을 쓴다) — 입력은 printf 파이프로만.
# 게이트의 외부 명령은 절대 경로(QA O-4, 위 「호출 환경 고정」).
SHASUM=/usr/bin/shasum
# 키 순서 = 「정확히 1번」 검사 순서. 새 키(Issue #48 의 3개, 2차의 ini_sha256)는 뒤에 둔다 — 기존 키 사례의 첫 거부
# 사유가 바뀌지 않게.
ATTEST_KEYS=(profile_sha256 iso_fs_sha256 attested_at evidence main_commit wrapper_sha256 guard_sha256 conftest_sha256 ini_sha256)
# 해시 키 → (P 루트 기준 상대 경로). 사유 문구에 이 경로가 들어간다.
HASH_KEYS=(profile_sha256 iso_fs_sha256 wrapper_sha256 guard_sha256 conftest_sha256 ini_sha256)
WRAPPER_REL=scripts/isolated-pytest.sh
# $1 = 경로. 정규 파일(symlink 아님)만, 끝 줄바꿈까지 그대로 SNAP 에. 실패면 1(빈 스냅숏을 조용히 쓰지 않음).
snap_read() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  SNAP="$(/bin/cat -- "$1" && printf x)" || return 1
  SNAP="${SNAP%x}"
}
# $1 = P 루트(실제 P 또는 자기시험 복사본, scripts/·tests/·pytest.ini), $2 = 래퍼 경로(실행 중인 ${BASH_SOURCE[0]} 또는
# 복사본의 scripts/isolated-pytest.sh) → ATT_SNAP·PROFILE_SNAP·ISOFS_SNAP·WRAPPER_SNAP·GUARD_SNAP·CONFTEST_SNAP·INI_SNAP
# (없음·symlink 면 해당 *_OK=0). 파일마다 snap_read 1회.
take_snapshot() {
  ATT_OK=1 PROFILE_OK=1 ISOFS_OK=1 WRAPPER_OK=1 GUARD_OK=1 CONFTEST_OK=1 INI_OK=1
  ATT_SNAP="" PROFILE_SNAP="" ISOFS_SNAP="" WRAPPER_SNAP="" GUARD_SNAP="" CONFTEST_SNAP="" INI_SNAP=""
  if snap_read "$1/scripts/G3-ATTESTATION"; then ATT_SNAP=$SNAP; else ATT_OK=0; fi
  if snap_read "$1/scripts/pytest.sb"; then PROFILE_SNAP=$SNAP; else PROFILE_OK=0; fi
  if snap_read "$1/scripts/_iso_fs.sh"; then ISOFS_SNAP=$SNAP; else ISOFS_OK=0; fi
  if snap_read "$2"; then WRAPPER_SNAP=$SNAP; else WRAPPER_OK=0; fi
  if snap_read "$1/tests/_isolation_guard.py"; then GUARD_SNAP=$SNAP; else GUARD_OK=0; fi
  if snap_read "$1/tests/conftest.py"; then CONFTEST_SNAP=$SNAP; else CONFTEST_OK=0; fi
  if snap_read "$1/pytest.ini"; then INI_SNAP=$SNAP; else INI_OK=0; fi
}
sha256_text() { printf '%s' "$1" | "$SHASUM" -a 256 | /usr/bin/cut -d' ' -f1; }
att_lines() { printf '%s\n' "$ATT_SNAP"; }
attest_value() { att_lines | /usr/bin/sed -n "s/^$1=//p"; }
# 스냅숏 대조. 0 = 일치, 5 = 없음·형식 오류·불일치(사유 stderr). ATTESTATION 은 source 하지 않고 키별로 grep 한다.
attest_verify_snapshot() {
  local key n v
  [ "$ATT_OK" = 1 ] || { echo "attestation: G3-ATTESTATION missing or not a regular file" >&2; return 5; }
  [ "$PROFILE_OK" = 1 ] || { echo "attestation: scripts/pytest.sb missing or not a regular file" >&2; return 5; }
  [ "$ISOFS_OK" = 1 ] || { echo "attestation: scripts/_iso_fs.sh missing or not a regular file" >&2; return 5; }
  [ "$WRAPPER_OK" = 1 ] || { echo "attestation: $WRAPPER_REL missing or not a regular file" >&2; return 5; }
  [ "$GUARD_OK" = 1 ] || { echo "attestation: tests/_isolation_guard.py missing or not a regular file" >&2; return 5; }
  [ "$CONFTEST_OK" = 1 ] || { echo "attestation: tests/conftest.py missing or not a regular file" >&2; return 5; }
  [ "$INI_OK" = 1 ] || { echo "attestation: pytest.ini missing or not a regular file" >&2; return 5; }
  # -q 를 쓰지 않는다(조기 종료 SIGPIPE 가 pipefail 로 「문제 없음」처럼 보이는 것 방지).
  v="$(att_lines | /usr/bin/grep -v -E '^(#.*)?$' \
    | /usr/bin/grep -v -E '^(profile_sha256|iso_fs_sha256|wrapper_sha256|guard_sha256|conftest_sha256|ini_sha256|attested_at|evidence|main_commit)=' || true)"
  [ -z "$v" ] || { echo "attestation: unknown or malformed line" >&2; return 5; }
  for key in "${ATTEST_KEYS[@]}"; do
    n="$(att_lines | /usr/bin/grep -c -E "^$key=" || true)"
    [ "$n" = 1 ] || { echo "attestation: $key must appear exactly once (found $n)" >&2; return 5; }
  done
  for key in "${HASH_KEYS[@]}"; do
    v="$(attest_value "$key")"
    [[ "$v" =~ ^[0-9a-f]{64}$ ]] || { echo "attestation: $key is not 64 lowercase hex" >&2; return 5; }
  done
  [[ "$(attest_value attested_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "attestation: attested_at is not YYYY-MM-DD" >&2; return 5; }
  [[ "$(attest_value main_commit)" =~ ^[0-9a-f]{7,40}$ ]] || { echo "attestation: main_commit is not a commit id" >&2; return 5; }
  [ -n "$(attest_value evidence)" ] || { echo "attestation: evidence is empty" >&2; return 5; }
  [ "$(sha256_text "$PROFILE_SNAP")" = "$(attest_value profile_sha256)" ] \
    || { echo "attestation: scripts/pytest.sb sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_text "$ISOFS_SNAP")" = "$(attest_value iso_fs_sha256)" ] \
    || { echo "attestation: scripts/_iso_fs.sh sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_text "$WRAPPER_SNAP")" = "$(attest_value wrapper_sha256)" ] \
    || { echo "attestation: $WRAPPER_REL sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_text "$GUARD_SNAP")" = "$(attest_value guard_sha256)" ] \
    || { echo "attestation: tests/_isolation_guard.py sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_text "$CONFTEST_SNAP")" = "$(attest_value conftest_sha256)" ] \
    || { echo "attestation: tests/conftest.py sha256 differs from G3-ATTESTATION" >&2; return 5; }
  [ "$(sha256_text "$INI_SNAP")" = "$(attest_value ini_sha256)" ] \
    || { echo "attestation: pytest.ini sha256 differs from G3-ATTESTATION" >&2; return 5; }
  return 0
}
# $1 = P 루트, $2 = 래퍼 경로. 스냅숏을 뜨고(전역 *_SNAP 갱신) 대조한다. 실패면 EXIT 5.
attest_gate() {
  take_snapshot "$1" "$2"
  attest_verify_snapshot || die 5 "G3 attestation check failed — re-attestation by human required (nothing was run)"
}
# 실행 중인 래퍼 = 대조 대상. --run-attested·--run-live 에서는 그 realpath 가 $P/scripts/isolated-pytest.sh 와 같아야
# 한다(다르면 EXIT 2 — 예: 래퍼 파일이 다른 곳을 가리키는 symlink). snap_read 도 symlink 를 거부한다.
WRAPPER_SELF="${BASH_SOURCE[0]}"
# --run-attested·--run-live: layout 검사·_iso_fs.sh 적재·.isolation 접근보다 먼저 대조한다(Codex 1차 P2-2: 프로필·
# helper 누락도 EXIT 5). 그 밖 모드: 같은 스냅숏을 뜨되 대조 없이, pytest.sb·_iso_fs.sh 누락이면 layout 실패(EXIT 2) —
# 기존 모드의 요구 조건은 넓히지도 좁히지도 않는다(래퍼·가드·conftest·pytest.ini 스냅숏은 --preflight 자기시험
# 복사본에만 쓰임; pytest.ini 의 존재 요구는 아래 layout 검사가 예전 그대로 맡는다).
if [ "${1:-}" = --run-attested ] || [ "${1:-}" = --run-live ]; then
  WRAPPER_REAL="$($REALPATH "$WRAPPER_SELF")" || die 2 "cannot resolve running wrapper: $WRAPPER_SELF"
  [ "$WRAPPER_REAL" = "$P/$WRAPPER_REL" ] || die 2 "running wrapper is not $P/$WRAPPER_REL: $WRAPPER_SELF -> $WRAPPER_REAL"
  attest_gate "$P" "$WRAPPER_SELF"
else
  take_snapshot "$P" "$WRAPPER_SELF"
  [ "$PROFILE_OK" = 1 ] && [ "$ISOFS_OK" = 1 ] || die 2 "P layout mismatch: $P"
fi
[ -f "$P/pytest.ini" ] || die 2 "P layout mismatch: $P"

# 검증한(또는 --run-attested 아닌 모드에서 떠 둔) 스냅숏 바이트를 그대로 적재 — 원본 _iso_fs.sh 를 다시 열지 않는다.
eval "$ISOFS_SNAP"
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
cleanup() { iso_rm_files "$ISO" run-token outside-token "${LIVE_SECRET_FILES[@]}" || printf 'isolated-pytest: cleanup skipped (ISO is not a plain directory): %s\n' "$ISO" >&2; }

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

# 스냅숏 복사본을 $ISO 에 남긴다(바이트 그대로, noclobber). 렌더·적재는 메모리 스냅숏을 쓰므로 이 파일은 증거용이다.
write_snapshot_copies() {
  local name
  for name in snapshot-pytest.sb snapshot-_iso_fs.sh; do check_node "$ISO/$name" 0; done
  ( set -C; printf '%s' "$PROFILE_SNAP" > "$ISO/snapshot-pytest.sb"; printf '%s' "$ISOFS_SNAP" > "$ISO/snapshot-_iso_fs.sh" )
  for name in snapshot-pytest.sb snapshot-_iso_fs.sh; do check_node "$ISO/$name" 1; done
}

# $1 = 추가 거부 포트(선택). 입력 = PROFILE_SNAP(원본 pytest.sb 를 다시 열지 않는다, P2-1). 결과는 stdout.
render_profile_text() {
  local extra=${1:-} ports=("${DENY_PORTS[@]}") line port src_re
  src_re="$(printf '%s' "$HERMES_SRC" | sed 's/[][\.^$*+?(){}|]/\\&/g')"
  [ -n "$extra" ] && ports+=("$extra")
  printf '%s' "$PROFILE_SNAP" | while IFS= read -r line || [ -n "$line" ]; do
      if [ "$line" = ';;@DENY_PORT_RULES@' ]; then
        for port in "${ports[@]}"; do
          printf '(deny network-outbound (remote ip "localhost:%s"))\n' "$port"
        done
      else
        line=${line//@VENV_PY@/$VENV_PY}; line=${line//@PY_EXE@/$PY_EXE_REAL}; line=${line//@PY_HOME@/$PY_HOME_REAL}
        line=${line//@HERMES_SRC_RE@/$src_re}; line=${line//@HERMES_SRC@/$HERMES_SRC}; line=${line//@ISO@/$ISO}; line=${line//@P@/$P}
        printf '%s\n' "$line"
      fi
    done
}

render_profile() {           # $1 = 추가 거부 포트(선택)
  local out
  out="$(render_profile_text "${1:-}")"
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
# 사례마다 복사본 디렉터리 하나(P 루트 형태: scripts/·tests/): 메모리 스냅숏 → 변형 → 실제 attest_gate(서브셸)
# 종료 코드·stderr 기록(Codex 1차 P3-2). 기준(unmodified)은 실제 G3-ATTESTATION 바이트다 — 합성 승인 파일을 만들지 않는다.
ATTEST_CASES=(unmodified eof_with_newline eof_without_newline comment_and_blank profile_modified iso_fs_modified leading_space spaced_equals trailing_space
              duplicate_key missing_key value_mismatch missing_profile missing_iso_fs missing_attestation
              wrapper_modified guard_modified conftest_modified missing_wrapper_key missing_guard missing_conftest guard_symlink
              ini_modified missing_ini)
# $1 = 복사본 P 루트. 스냅숏 7개를 바이트 그대로 scripts/·tests/·pytest.ini 에 쓴다(래퍼도 cp 가 아니라 대조한 스냅숏).
# pytest.ini 도 스냅숏 바이트라 가짜 P 의 layout 검사([ -f pytest.ini ])와 해시 대조를 함께 통과한다.
selftest_tree() {
  mkdir -p -- "$1/scripts" "$1/tests"
  printf '%s' "$PROFILE_SNAP" > "$1/scripts/pytest.sb"; printf '%s' "$ISOFS_SNAP" > "$1/scripts/_iso_fs.sh"
  printf '%s' "$ATT_SNAP" > "$1/scripts/G3-ATTESTATION"; printf '%s' "$WRAPPER_SNAP" > "$1/$WRAPPER_REL"
  printf '%s' "$GUARD_SNAP" > "$1/tests/_isolation_guard.py"; printf '%s' "$CONFTEST_SNAP" > "$1/tests/conftest.py"
  printf '%s' "$INI_SNAP" > "$1/pytest.ini"
}
attest_case_mutate() {       # $1 = 사례, $2 = 복사본 P 루트. 변형은 printf·grep 리다이렉트·rm·mv·ln 만(임시 파일 없음).
  local c=$1 d=$2 a="$2/scripts/G3-ATTESTATION" g="$2/tests/_isolation_guard.py" old
  old="$(cat -- "$a")"
  case "$c" in
    unmodified) ;;
    eof_with_newline) printf '%s\n' "$old" > "$a" ;;      # 마지막 줄 뒤 개행 있음(실파일과 달리 명시)
    eof_without_newline) printf '%s' "$old" > "$a" ;;    # 마지막 줄 뒤 개행 없음(실파일 G3-ATTESTATION 형태)
    comment_and_blank) printf '\n# 사람 메모\n\n' >> "$a" ;;
    profile_modified) printf ' ' >> "$d/scripts/pytest.sb" ;;
    iso_fs_modified) printf '\n' >> "$d/scripts/_iso_fs.sh" ;;
    wrapper_modified) printf '\n' >> "$d/$WRAPPER_REL" ;;
    guard_modified) printf '\n' >> "$g" ;;
    conftest_modified) printf '\n' >> "$d/tests/conftest.py" ;;
    ini_modified) printf '\n' >> "$d/pytest.ini" ;;
    missing_ini) rm -f -- "$d/pytest.ini" ;;
    missing_wrapper_key) printf '%s\n' "$old" | grep -v '^wrapper_sha256=' > "$a" || true ;;
    missing_guard) rm -f -- "$g" ;;
    missing_conftest) rm -f -- "$d/tests/conftest.py" ;;
    guard_symlink) mv -- "$g" "$g.real"; ln -s -- _isolation_guard.py.real "$g" ;;   # 같은 바이트를 가리키는 symlink → 거부
    leading_space) printf '%s\n' "$old" | sed 's/^main_commit=/ main_commit=/' > "$a" ;;
    spaced_equals) printf '%s\n' "$old" | sed 's/^evidence=/evidence = /' > "$a" ;;
    trailing_space) printf '%s\n' "$old" | sed 's/^\(profile_sha256=.*\)$/\1 /' > "$a" ;;
    duplicate_key) { printf '\n'; printf '%s\n' "$old" | grep '^attested_at='; } >> "$a" ;;
    missing_key) printf '%s\n' "$old" | grep -v '^main_commit=' > "$a" ;;
    value_mismatch) printf '%s\n' "$old" | sed 's/^profile_sha256=.*/profile_sha256=0000000000000000000000000000000000000000000000000000000000000000/' > "$a" ;;
    missing_profile) rm -f -- "$d/scripts/pytest.sb" ;;
    missing_iso_fs) rm -f -- "$d/scripts/_iso_fs.sh" ;;
    missing_attestation) rm -f -- "$a" ;;
  esac
}
attest_selftest() {
  local d="$ISO/tmp/attest-selftest" c rc dir mark1=';;OHMYSLACK-SELFTEST-SNAPSHOT-MARK' mark2=';;OHMYSLACK-SELFTEST-REREAD-MARK'
  mkdir -- "$d" || die 1 "attest selftest: mkdir failed: $d"
  : > "$d/result"
  for c in "${ATTEST_CASES[@]}"; do
    dir="$d/$c"; mkdir -- "$dir"
    selftest_tree "$dir"
    attest_case_mutate "$c" "$dir"
    rc=0; ( attest_gate "$dir" "$dir/$WRAPPER_REL" ) 2> "$d/$c.err" || rc=$?
    printf '%s=%s\n' "$c" "$rc" >> "$d/result"
  done
  # 렌더 입력 = 스냅숏(P2-1): 스냅숏 전에 넣은 표지는 렌더에 있고(원본 $P/scripts/pytest.sb 를 읽으면 없음),
  # 스냅숏 뒤 파일에 덧붙인 표지는 없어야 한다(파일을 다시 읽으면 있음).
  dir="$d/render"; mkdir -- "$dir"
  selftest_tree "$dir"; printf '%s%s\n' "$PROFILE_SNAP" "$mark1" > "$dir/scripts/pytest.sb"
  ( take_snapshot "$dir" "$dir/$WRAPPER_REL"; printf '%s\n' "$mark2" >> "$dir/scripts/pytest.sb"; render_profile_text "" ) > "$d/render.out" 2> "$d/render.err" || true
  rc=0; grep -q -e "$mark1" "$d/render.out" || rc=1
  printf 'render_has_snapshot_mark=%s\n' "$rc" >> "$d/result"
  rc=0; grep -q -e "$mark2" "$d/render.out" && rc=1
  printf 'render_rereads_file=%s\n' "$rc" >> "$d/result"
  # 진입 순서(P2-2): 래퍼 복사본을 $ISO/tmp 아래 가짜 P 에 두고 pytest.sb·_iso_fs.sh 를 빼면 --run-attested 는
  # layout 검사(EXIT 2) 전에 EXIT 5 여야 한다. 대조 실패라 그 복사본은 sandbox·.isolation 에 닿지 않는다.
  for c in pytest.sb _iso_fs.sh; do
    dir="$d/entry-$c/integrations/hermes-plugin"; mkdir -p -- "$dir"
    selftest_tree "$dir"
    rm -f -- "$dir/scripts/$c"
    rc=0; /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash "$dir/$WRAPPER_REL" --run-attested \
      > "$d/entry-$c.out" 2> "$d/entry-$c.err" < /dev/null || rc=$?
    printf 'entry_missing_%s=%s\n' "$c" "$rc" >> "$d/result"
  done
  # QA O-5: 가짜 P 의 scripts/isolated-pytest.sh 를 가짜 P 밖 실파일(같은 스냅숏 바이트)을 가리키는 절대 경로 symlink 로
  # 두면 --run-attested 는 해시 대조 전 realpath 불일치로 EXIT 2 여야 하고, 가짜 P 에 .isolation 이 생기면 안 된다.
  dir="$d/entry-wrapper_symlink/integrations/hermes-plugin"; mkdir -p -- "$dir" "$d/entry-wrapper_symlink-real"
  selftest_tree "$dir"
  printf '%s' "$WRAPPER_SNAP" > "$d/entry-wrapper_symlink-real/isolated-pytest.sh"
  rm -f -- "$dir/$WRAPPER_REL"
  ln -s -- "$d/entry-wrapper_symlink-real/isolated-pytest.sh" "$dir/$WRAPPER_REL"
  rc=0; /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash "$dir/$WRAPPER_REL" --run-attested \
    > "$d/entry-wrapper_symlink.out" 2> "$d/entry-wrapper_symlink.err" < /dev/null || rc=$?
  printf 'entry_wrapper_symlink=%s\n' "$rc" >> "$d/result"
}

# --run-live 거부 경로 자기시험(sandbox 밖 — sandbox 안에서는 bash 를 exec 할 수 없음, attest_selftest 와 같은 방식).
# 래퍼 복사본을 $ISO/tmp 아래 가짜 P(P 루트 형태: scripts/·tests/, 스냅숏 바이트 그대로 → 해시 게이트 통과)에 두고
# 사례마다 env -i 로 부른다. 가짜 P 에는 .venv 가 없어 검증을 통과해도 require_sandbox 에서 EXIT 6 으로 멈춘다(실서버·
# sandbox·실제 .isolation 에 닿지 않음). 비밀 자리에는 가짜 표지 값(OMS-SELFTEST-SECRET…)만 쓴다.
# hash_* 사례(QA O-2)는 사례별 가짜 P(fake-<사례>)에서 해시 대상 1개를 1바이트 바꿔 EXIT 5·비밀 표지 0건·
# .isolation 미생성을 본다. url_port_*·main_url_8788·origin_8787 은 포트 경계(QA O-7). 65536 은 url_port_over.
# 결과는 tests_isolation/test_run_live.py 가 단언.
RUN_LIVE_CASES=(extra_arg confirm_arg empty_confirm url_malformed url_prod_8787 url_prod_8788 url_localhost url_any_host
                url_https url_low_port url_port_over token_missing token_empty token_newline live_flag_missing
                live_flag_not_1 main_url_prod origin_bad cookie_missing csrf_missing valid_env
                url_port_1023 url_port_1024 url_port_65535 main_url_8788 origin_8787 hash_profile_modified hash_guard_modified
                hash_ini_modified)
run_live_selftest() {
  local d="$ISO/tmp/run-live-selftest" dir base c rc u=__UNSET__ s=OMS-SELFTEST-SECRET
  local e2e url main origin token cookie csrf
  local -a args envs
  mkdir -- "$d" || die 1 "run-live selftest: mkdir failed: $d"
  base="$d/fake/integrations/hermes-plugin"; mkdir -p -- "$base"
  selftest_tree "$base"
  : > "$d/result"
  for c in "${RUN_LIVE_CASES[@]}"; do
    e2e=1 url=http://127.0.0.1:45678 main=http://127.0.0.1:45679 origin=http://127.0.0.1:45679
    token="omsb_$s-token" cookie="__Host-oms_session=$s-cookie" csrf="$s-csrf"
    args=() dir=$base
    case "$c" in
      hash_*)
        dir="$d/fake-$c/integrations/hermes-plugin"; mkdir -p -- "$dir"
        selftest_tree "$dir"
        case "$c" in
          hash_profile_modified) printf ' ' >> "$dir/scripts/pytest.sb" ;;
          hash_guard_modified) printf ' ' >> "$dir/tests/_isolation_guard.py" ;;
          hash_ini_modified) printf ' ' >> "$dir/pytest.ini" ;;
        esac ;;
    esac
    case "$c" in
      extra_arg) args=(-q) ;;
      confirm_arg) args=(--confirm=G3-CLEARED-BY-HUMAN) ;;
      empty_confirm) args=(--confirm=) ;;
      url_malformed) url=http://127.0.0.1:45678/x ;;
      url_prod_8787) url=http://127.0.0.1:8787 ;;
      url_prod_8788) url=http://127.0.0.1:8788 ;;
      url_localhost) url=http://localhost:45678 ;;
      url_any_host) url=http://0.0.0.0:45678 ;;
      url_https) url=https://127.0.0.1:45678 ;;
      url_low_port) url=http://127.0.0.1:80 ;;
      url_port_over) url=http://127.0.0.1:65536 ;;
      token_missing) token=$u ;;
      token_empty) token="" ;;
      token_newline) token="omsb_$s-a"$'\n'"b" ;;
      live_flag_missing) e2e=$u ;;
      live_flag_not_1) e2e=true ;;
      main_url_prod) main=http://127.0.0.1:8787 ;;
      origin_bad) origin=http://localhost:45679 ;;
      cookie_missing) cookie=$u ;;
      csrf_missing) csrf=$u ;;
      valid_env) ;;
      url_port_1023) url=http://127.0.0.1:1023 ;;      # 하한 아래 → 64
      url_port_1024) url=http://127.0.0.1:1024 ;;      # 하한 → 통과(EXIT 6)
      url_port_65535) url=http://127.0.0.1:65535 ;;    # 상한 → 통과(EXIT 6)
      main_url_8788) main=http://127.0.0.1:8788 ;;     # 운영 포트 → 64
      origin_8787) origin=http://127.0.0.1:8787 ;;     # 운영 포트 → 64
      hash_*) ;;                                       # 모든 env 유효 — 해시 게이트에서 먼저 멈춰야 한다(EXIT 5)
    esac
    envs=(PATH=/usr/bin:/bin)
    [ "$e2e" = "$u" ] || envs+=(OHMYSLACK_LIVE_E2E="$e2e")
    [ "$url" = "$u" ] || envs+=(OHMYSLACK_BOT_URL="$url")
    [ "$main" = "$u" ] || envs+=(OHMYSLACK_LIVE_MAIN_URL="$main")
    [ "$origin" = "$u" ] || envs+=(OHMYSLACK_LIVE_ORIGIN="$origin")
    [ "$token" = "$u" ] || envs+=(OHMYSLACK_BOT_TOKEN="$token")
    [ "$cookie" = "$u" ] || envs+=(OHMYSLACK_LIVE_COOKIE="$cookie")
    [ "$csrf" = "$u" ] || envs+=(OHMYSLACK_LIVE_CSRF="$csrf")
    rc=0; /usr/bin/env -i "${envs[@]}" /bin/bash "$dir/scripts/isolated-pytest.sh" --run-live ${args[@]+"${args[@]}"} \
      > "$d/$c.out" 2> "$d/$c.err" < /dev/null || rc=$?
    printf '%s=%s\n' "$c" "$rc" >> "$d/result"
  done
}

mode_preflight() {
  local label
  base_env
  SB_FATAL=0
  attest_selftest
  run_live_selftest
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

# ---- --run-live (Issue #47 레인 B). 해시 대조는 스크립트 앞부분(attest_gate)에서 이미 끝났다.
# 인자 0개 — CONFIRM·EXTRA_ARGS 가 아니라 원래 인자 수(NARGS)로 본다(`--confirm=` 빈 값도 거부).
check_live_args() { [ "$NARGS" = 0 ] || die 64 "--run-live takes no arguments (no --confirm, no pytest args)"; }
LIVE_URL_RE='^http://127\.0\.0\.1:([1-9][0-9]{3,4})$'
live_url_ok() {              # $1 = 값. 정확히 http://127.0.0.1:<1024-65535>, DENY_PORTS 아님
  local port
  [[ "$1" =~ $LIVE_URL_RE ]] || return 1
  port=${BASH_REMATCH[1]}
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || return 1
  case " ${DENY_PORTS[*]} " in *" $port "*) return 1 ;; esac
  return 0
}
live_secret_ok() {           # $1 = 값. 비어 있지 않은 한 줄(CR·LF 없음 — 헤더 주입·파일 줄 경계 방지)
  [ -n "$1" ] || return 1
  case "$1" in *$'\n'*|*$'\r'*) return 1 ;; esac
  return 0
}
# 래퍼 자기 env 검증. 위반이면 EXIT 64 + 사유(변수 이름)만 — 값은 어디에도 출력하지 않는다.
# 통과하면 값을 export 안 된 셸 변수로 옮기고 비밀 env 는 unset(래퍼가 부르는 od·find 등 자식에 상속 안 됨).
check_live_env() {
  local url_rule="must be exactly http://127.0.0.1:<1024-65535> and not an operating port (${DENY_PORTS[*]}) — value not shown"
  local secret_rule="must be a non-empty single line — value not shown"
  [ "${OHMYSLACK_LIVE_E2E-}" = 1 ] || die 64 "--run-live: OHMYSLACK_LIVE_E2E must be 1"
  live_url_ok "${OHMYSLACK_BOT_URL-}" || die 64 "--run-live: OHMYSLACK_BOT_URL $url_rule"
  live_url_ok "${OHMYSLACK_LIVE_MAIN_URL-}" || die 64 "--run-live: OHMYSLACK_LIVE_MAIN_URL $url_rule"
  live_url_ok "${OHMYSLACK_LIVE_ORIGIN-}" || die 64 "--run-live: OHMYSLACK_LIVE_ORIGIN $url_rule"
  live_secret_ok "${OHMYSLACK_BOT_TOKEN-}" || die 64 "--run-live: OHMYSLACK_BOT_TOKEN $secret_rule"
  live_secret_ok "${OHMYSLACK_LIVE_COOKIE-}" || die 64 "--run-live: OHMYSLACK_LIVE_COOKIE $secret_rule"
  live_secret_ok "${OHMYSLACK_LIVE_CSRF-}" || die 64 "--run-live: OHMYSLACK_LIVE_CSRF $secret_rule"
  unset LIVE_BOT_URL LIVE_MAIN_URL LIVE_ORIGIN LIVE_BOT_TOKEN LIVE_COOKIE LIVE_CSRF   # 호출자가 export 해 둔 같은 이름 제거
  LIVE_BOT_URL=$OHMYSLACK_BOT_URL LIVE_MAIN_URL=$OHMYSLACK_LIVE_MAIN_URL LIVE_ORIGIN=$OHMYSLACK_LIVE_ORIGIN
  LIVE_BOT_TOKEN=$OHMYSLACK_BOT_TOKEN LIVE_COOKIE=$OHMYSLACK_LIVE_COOKIE LIVE_CSRF=$OHMYSLACK_LIVE_CSRF
  unset OHMYSLACK_BOT_TOKEN OHMYSLACK_LIVE_COOKIE OHMYSLACK_LIVE_CSRF
}
# 0600 새 파일: umask 077 + write_new(check_node symlink 거부·noclobber 새 파일만). 값은 printf 내장으로만 쓴다(argv 아님).
# 서브셸로 감싸지 않는다 — `( … ) || die` 안에서는 set -e 가 꺼져 noclobber 실패가 묻힐 수 있다.
write_secret() {
  local old_umask; old_umask="$(umask)"
  umask 077
  write_new "$1" "$2"
  umask "$old_umask"
  [ "$(/usr/bin/stat -f %Lp "$1")" = 600 ] || die 2 "secret file is not mode 0600: $1"
}
mode_run_live() {
  write_secret "$ISO/live-bot-token" "$LIVE_BOT_TOKEN"
  write_secret "$ISO/live-cookie" "$LIVE_COOKIE"
  write_secret "$ISO/live-csrf" "$LIVE_CSRF"
  LIVE_BOT_TOKEN="" LIVE_COOKIE="" LIVE_CSRF=""
  # run_tests 와 같은 env(base_env + PYTHONPATH)에 live 값만 더한다 — 비밀은 *_FILE 경로만(env -i 의 argv 에 값 없음).
  base_env; ENV_ARGS+=(PYTHONPATH="$HERMES_SRC" OHMYSLACK_LIVE_E2E=1 OHMYSLACK_BOT_URL="$LIVE_BOT_URL"
                       OHMYSLACK_LIVE_MAIN_URL="$LIVE_MAIN_URL" OHMYSLACK_LIVE_ORIGIN="$LIVE_ORIGIN"
                       OHMYSLACK_BOT_TOKEN_FILE="$ISO/live-bot-token" OHMYSLACK_LIVE_COOKIE_FILE="$ISO/live-cookie"
                       OHMYSLACK_LIVE_CSRF_FILE="$ISO/live-csrf")
  SB_FATAL=0
  sandboxed run-live "${PYTEST_ARGS[@]}" --basetemp="$ISO/tmp/pytest" -q -m live tests/test_live_e2e.py tests/test_live_standalone.py
  [ "$SB_FATAL" = 0 ] || die 6 "sandbox-exec failed"
  exit "$SB_RC"
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
NARGS=$#                     # 모드 뒤 원래 인자 수(--run-live 인자 0개 검사용)
CONFIRM=""; EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in --confirm=*) CONFIRM="${1#--confirm=}" ;; *) EXTRA_ARGS+=("$1") ;; esac
  shift
done
REAL_HOME="${HOME:-}"
case "$MODE" in
  --preflight|--probe-guard|--run|--run-attested|--run-live|--prove-outside) ;;
  *) die 64 "usage: $0 --preflight | --probe-guard | --run --confirm=G3-CLEARED-BY-HUMAN [args] | --run-attested [-q] [-x] [-k <expr>] | --run-live (no args; live env) | --prove-outside --confirm=OUTSIDE-PROBE-BY-HUMAN" ;;
esac
if [ "$MODE" = --run-attested ]; then check_attested_args
elif [ "$MODE" = --run-live ]; then check_live_args; check_live_env
elif [ "$MODE" != --run ] && [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then die 64 "extra arguments are only accepted with --run or --run-attested"; fi

require_sandbox
recreate_iso
trap cleanup EXIT
write_snapshot_copies
RUN_TOKEN="$(new_token)"
write_new "$ISO/run-token" "$RUN_TOKEN"
render_profile ""

case "$MODE" in
  --preflight) mode_preflight ;;
  --probe-guard) mode_probe_guard ;;
  --run) mode_run ;;
  --run-attested) mode_run_attested ;;
  --run-live) mode_run_live ;;
  --prove-outside) mode_prove_outside ;;
esac
