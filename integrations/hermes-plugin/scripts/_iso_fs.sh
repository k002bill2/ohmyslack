# shellcheck shell=bash
# $ISO 정리 함수 — scripts/isolated-pytest.sh 와 scripts/iso-symlink-regress.sh 가 source 한다(직접 실행하지 않음).
# Codex 1차 P1(TOCTOU): `rm -rf "$ISO/<하위>"` 는 검사 뒤 $ISO 가 symlink 로 바뀌면 그 대상을 지운다.
# 그래서 삭제는 모두 `find -P … -delete` 로 한다.
#   - -P: 루트를 포함해 어떤 symlink 도 따라가지 않는다(루트가 symlink 면 링크 자체만 본다).
#   - -delete: fts 를 chdir 모드로 돌려 각 디렉터리 안에서 이름만으로 지운다(하위 경로에 "/" 가
#     있으면 거부, symlink 추적과 함께 쓸 수 없음 — find(1)). fts 는 디렉터리 진입 때 dev/ino 를
#     다시 비교한다(BSD fts_safe_changedir, L2 — 소스 근거, 이 레인에서 실측 안 함).
# 셸에는 검증한 디렉터리 fd 를 끝까지 잡고 그 fd 기준으로 만들고 지우는 수단이 없다(openat/unlinkat 불가).
# 남는 경쟁 창은 REPORT 「Codex 1차 수정」 P1 절 참조 — 같은 사용자가 실행 중에 경로를 바꿔치는 경우뿐이며,
# 그때도 이 함수들은 symlink 너머를 지우지 않는다(만들기는 새 mkdir 로만, 기존 경로 재사용 없음).

# $1 을 통째로 지운다. 루트가 symlink·디렉터리 아님이면 아무것도 지우지 않고 2. 없으면 0.
iso_wipe() {
  local iso=$1
  if [ -L "$iso" ]; then return 2; fi
  if [ ! -e "$iso" ]; then return 0; fi
  if [ ! -d "$iso" ]; then return 2; fi
  find -P "$iso" -delete
}

# $1 바로 아래의 일반 파일 중 이름이 $2… 인 것만 지운다(symlink·디렉터리는 건드리지 않음).
iso_rm_files() {
  local iso=$1 name expr=()
  shift
  if [ -L "$iso" ]; then return 2; fi
  if [ ! -d "$iso" ]; then return 0; fi
  for name in "$@"; do
    case "$name" in */*|''|.|..) return 2 ;; esac
    [ "${#expr[@]}" -gt 0 ] && expr+=(-o)
    expr+=(-name "$name")
  done
  [ "${#expr[@]}" -gt 0 ] || return 0
  find -P "$iso" -mindepth 1 -maxdepth 1 -type f \( "${expr[@]}" \) -delete
}
