"""`--run-attested` 해시 대조 점검(Hermes import 0). 래퍼 `--preflight` 가 sandbox 안에서 실행한다.

sandbox 안에서는 bash·shasum 을 exec 할 수 없어서, 단언은 래퍼가 sandbox 밖에서 `$ISO/tmp` 복사본으로 돌린
자기시험(`attest_selftest`) 결과를 읽는다 — 형식 변형마다 **실제 셸 `attest_gate`** 의 종료 코드·거부 문구
(Codex 1차 P3-2: 테스트 안 재구현 파서 의존 제거). 현재 파일 해시는 hashlib 로 독립 계산해 교차 확인한다.
"""

from __future__ import annotations

import hashlib
import os
import re

import pytest

from .conftest import ISO, P_DIR

SCRIPTS = os.path.join(P_DIR, "scripts")
WRAPPER = os.path.join(SCRIPTS, "isolated-pytest.sh")
SELFTEST = os.path.join(ISO, "tmp", "attest-selftest")
REFUSAL = "re-attestation by human required"

# 사례 → (기대 종료 코드, 사유 문구). 0 이면 거부 문구가 없어야 한다.
CASES = {
    "unmodified": (0, None),
    "eof_with_newline": (0, None),
    "eof_without_newline": (0, None),
    "comment_and_blank": (0, None),
    "profile_modified": (5, "scripts/pytest.sb sha256 differs"),
    "iso_fs_modified": (5, "scripts/_iso_fs.sh sha256 differs"),
    "leading_space": (5, "unknown or malformed line"),
    "spaced_equals": (5, "unknown or malformed line"),
    "trailing_space": (5, "profile_sha256 is not 64 lowercase hex"),
    "duplicate_key": (5, "attested_at must appear exactly once (found 2)"),
    "missing_key": (5, "main_commit must appear exactly once (found 0)"),
    "value_mismatch": (5, "scripts/pytest.sb sha256 differs"),
    "missing_profile": (5, "scripts/pytest.sb missing or not a regular file"),
    "missing_iso_fs": (5, "scripts/_iso_fs.sh missing or not a regular file"),
    "missing_attestation": (5, "G3-ATTESTATION missing or not a regular file"),
    # Issue #48: 해시 범위 5파일(래퍼·가드·conftest 추가). 기준은 실제 G3-ATTESTATION 바이트 — 사람 재승인 전에는
    # 새 키가 없어 *_modified·unmodified 류가 실패하는 것이 정상(REPORT 「예상 결과」).
    "wrapper_modified": (5, "scripts/isolated-pytest.sh sha256 differs"),
    "guard_modified": (5, "tests/_isolation_guard.py sha256 differs"),
    "conftest_modified": (5, "tests/conftest.py sha256 differs"),
    "missing_wrapper_key": (5, "wrapper_sha256 must appear exactly once (found 0)"),
    "missing_guard": (5, "tests/_isolation_guard.py missing or not a regular file"),
    "missing_conftest": (5, "tests/conftest.py missing or not a regular file"),
    "guard_symlink": (5, "tests/_isolation_guard.py missing or not a regular file"),
    # Issue #48 2차(QA O-7): pytest.ini(addopts 로 --noconftest·-p 를 넣으면 conftest 가드를 건너뛸 수 있음) 해시 대상.
    "ini_modified": (5, "pytest.ini sha256 differs"),
    "missing_ini": (5, "pytest.ini missing or not a regular file"),
}
# 승인 파일의 해시 키 → P 루트 기준 대상 파일(래퍼 HASH_KEYS 와 같은 6개).
HASHED = {
    "profile_sha256": os.path.join("scripts", "pytest.sb"),
    "iso_fs_sha256": os.path.join("scripts", "_iso_fs.sh"),
    "wrapper_sha256": os.path.join("scripts", "isolated-pytest.sh"),
    "guard_sha256": os.path.join("tests", "_isolation_guard.py"),
    "conftest_sha256": os.path.join("tests", "conftest.py"),
    "ini_sha256": "pytest.ini",
}


def _read(name: str) -> str:
    with open(os.path.join(SELFTEST, name), encoding="utf-8") as fh:
        return fh.read()


def _result() -> dict[str, str]:
    return dict(line.split("=", 1) for line in _read("result").split())


def _sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def test_attestation_hashes_match_current_files():
    text = _read_attestation()
    for key, rel in HASHED.items():
        found = re.findall(rf"^{key}=([0-9a-f]{{64}})$", text, re.M)
        assert found == [_sha256(os.path.join(P_DIR, rel))], key


def _read_attestation() -> str:
    with open(os.path.join(SCRIPTS, "G3-ATTESTATION"), encoding="utf-8") as fh:
        return fh.read()


@pytest.mark.parametrize("case", sorted(CASES))
def test_attest_gate_format_variants_in_iso_copy(case):
    rc, reason = CASES[case]
    assert _result()[case] == str(rc)
    err = _read(f"{case}.err")
    if rc == 0:
        assert REFUSAL not in err and err == ""
    else:
        assert REFUSAL in err and reason in err, err


def test_render_uses_snapshot_not_file():
    """P2-1: 렌더 입력은 스냅숏 — 스냅숏 전 표지는 있고, 스냅숏 뒤 파일에 덧붙인 표지는 없다."""
    result = _result()
    assert result["render_has_snapshot_mark"] == "0"
    assert result["render_rereads_file"] == "0"


@pytest.mark.parametrize("missing", ["pytest.sb", "_iso_fs.sh"])
def test_run_attested_missing_file_exits_5_before_layout(missing):
    """P2-2: 프로필·helper 누락은 layout(EXIT 2)이 아니라 attestation 실패(EXIT 5)."""
    assert _result()[f"entry_missing_{missing}"] == "5"
    err = _read(f"entry-{missing}.err")
    assert REFUSAL in err and f"scripts/{missing} missing or not a regular file" in err, err
    assert "layout mismatch" not in err


def test_run_attested_wrapper_symlink_exits_2():
    """QA O-5: 가짜 P 의 래퍼가 가짜 P 밖 실파일을 가리키는 symlink → realpath 불일치 EXIT 2(해시 대조 전),
    가짜 P 에 .isolation 미생성."""
    assert _result()["entry_wrapper_symlink"] == "2"
    out, err = _read("entry-wrapper_symlink.out"), _read("entry-wrapper_symlink.err")
    assert out == ""
    assert "running wrapper is not" in err, err
    assert REFUSAL not in err  # 해시 게이트까지 가지 않음
    fake_p = os.path.join(SELFTEST, "entry-wrapper_symlink", "integrations", "hermes-plugin")
    link = os.path.join(fake_p, "scripts", "isolated-pytest.sh")
    assert os.path.islink(link)  # 대조군: 실제로 symlink 였음
    assert os.path.isfile(os.path.join(fake_p, "pytest.ini"))  # 대조군: layout 은 갖춰져 있었음
    assert not os.path.lexists(os.path.join(fake_p, ".isolation"))


# QA O-6: `$P/…` 뿐 아니라 `"$P"/…`·`${P}/…`·`"${P}"/…`, 그리고 래퍼 자신(`$P/$WRAPPER_REL`·`${WRAPPER_REL}`)도 잡는다.
_P_REF = r'"?\$(?:P|\{P\})"?/'
_PROTECTED = (r'(?:scripts/(?:pytest\.sb|_iso_fs\.sh|G3-ATTESTATION|isolated-pytest\.sh)'
              r'|tests/(?:_isolation_guard\.py|conftest\.py)|pytest\.ini|"?\$(?:WRAPPER_REL|\{WRAPPER_REL\}))')
REOPEN_RE = re.compile(_P_REF + _PROTECTED)
# 내용을 열지 않는 허용 사용(경로 문자열 비교·존재 확인)만 지운 뒤 검사한다.
REOPEN_ALLOWED = (
    '[ "$WRAPPER_REAL" = "$P/$WRAPPER_REL" ]',          # realpath 결과와 경로 문자열 비교
    'running wrapper is not $P/$WRAPPER_REL',          # 거부 사유 문구
    '[ -f "$P/pytest.ini" ]',                          # layout 존재 확인(stat, 내용 안 읽음)
)


def test_reopen_regex_catches_variants():
    """O-6 정규식 자체 대조: 변형은 잡고, 다른 디렉터리 경로는 잡지 않는다."""
    for bad in ('cat "$P"/scripts/pytest.sb', 'cat ${P}/tests/conftest.py', 'cat "${P}"/pytest.ini',
                'cat "$P/$WRAPPER_REL"', 'cat $P/${WRAPPER_REL}', 'grep x "$P/scripts/G3-ATTESTATION"',
                'cat "$P"/"$WRAPPER_REL"'):
        assert REOPEN_RE.search(bad), bad
    for ok in ('cat "$dir/$WRAPPER_REL"', 'ISO="$P/.isolation"', 'cat "$P_LOGICAL/x"', 'snap_read "$1/pytest.ini"'):
        assert not REOPEN_RE.search(ok), ok


def test_wrapper_opens_protected_files_only_in_snapshot():
    """P2-1 정적 보조: 원본 해시 대상(pytest.sb·_iso_fs.sh·G3-ATTESTATION·래퍼·가드·conftest·pytest.ini)을 여는 곳은
    스냅숏 진입(`take_snapshot "$P" "$WRAPPER_SELF"`)뿐이고, 자기시험 래퍼 복사본은 cp 가 아니라 스냅숏 바이트다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        code = [line for line in fh if not line.lstrip().startswith("#")]
    text = "".join(code)
    stripped = []
    for line in code:
        for allowed in REOPEN_ALLOWED:
            line = line.replace(allowed, "")
        stripped.append(line)
    assert not [line for line in stripped if REOPEN_RE.search(line)]
    for allowed in REOPEN_ALLOWED:
        assert allowed in text, allowed  # 허용 목록이 낡지 않게(문구가 바뀌면 함께 고친다)
    assert not [line for line in code if re.match(r"\s*\.\s", line) or re.match(r"\s*source\s", line)]
    assert 'attest_gate "$P" "$WRAPPER_SELF"' in text
    assert 'take_snapshot "$P" "$WRAPPER_SELF"' in text
    assert 'cp -- "${BASH_SOURCE[0]}"' not in text


def test_wrapper_pins_env_before_gate_and_uses_absolute_commands():
    """QA O-4 정적: PATH 고정·export 함수 정리·CDPATH 등 unset 이 옵션 해석·게이트보다 앞이고, 게이트 함수는
    외부 명령을 절대 경로로 부른다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        text = fh.read()
    pin = text.index("\nPATH=/usr/bin:/bin\n")
    unset_f = text.index("\nbuiltin unset -f -- cat grep sed cut shasum")
    unset_v = text.index("\nbuiltin unset CDPATH BASH_ENV ENV")
    first_cd = text.index('P_LOGICAL="$(cd -- ')
    gate = text.index('  attest_gate "$P" "$WRAPPER_SELF"')
    args = text.index('MODE="${1:-}"')
    assert unset_f < pin < first_cd < gate < args
    assert unset_v < first_cd
    start, end = text.index("\nsnap_read() {"), text.index("\nattest_gate() {")
    body = "\n".join(line for line in text[start:end].splitlines() if not line.lstrip().startswith("#"))
    bare = re.findall(r'(?:^|[|;&(]|\$\()\s*(cat|grep|sed|cut|shasum)\s', body, re.M)
    assert bare == [], bare
    for exe in ("/bin/cat", "/usr/bin/grep", "/usr/bin/sed", "/usr/bin/cut", "SHASUM=/usr/bin/shasum"):
        assert exe in text, exe


def test_wrapper_attest_keys_cover_hashed_files():
    """정적: 래퍼의 승인 키·해시 키 목록·알 수 없는 줄 정규식이 이 파일의 HASHED(6파일)와 같다(키 추가·삭제가 한쪽만
    바뀌지 않게). 해시 대상 각각에 누락 사유·불일치 사유가 있다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        text = fh.read()
    assert len(HASHED) == 6
    all_keys = set(HASHED) | {"attested_at", "evidence", "main_commit"}
    hash_keys = re.search(r"^HASH_KEYS=\(([^)]*)\)$", text, re.M)
    attest_keys = re.search(r"^ATTEST_KEYS=\(([^)]*)\)$", text, re.M)
    assert hash_keys and attest_keys
    assert set(hash_keys.group(1).split()) == set(HASHED)
    assert set(attest_keys.group(1).split()) == all_keys
    known = re.search(r"grep -v -E '\^\(([a-z0-9_|]+)\)='", text)
    assert known and set(known.group(1).split("|")) == all_keys
    for key, rel in HASHED.items():
        # 래퍼 사유는 문구에 "$WRAPPER_REL" 을 쓴다(WRAPPER_REL=scripts/isolated-pytest.sh).
        rel = "$WRAPPER_REL" if key == "wrapper_sha256" else rel.replace(os.sep, "/")
        assert f"attestation: {rel} sha256 differs from G3-ATTESTATION" in text, key
        assert f"attestation: {rel} missing or not a regular file" in text, key
        assert f'attest_value {key})" ]' in text, key
