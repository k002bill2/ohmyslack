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
}
# 승인 파일의 해시 키 → P 루트 기준 대상 파일(래퍼 HASH_KEYS 와 같은 5개).
HASHED = {
    "profile_sha256": os.path.join("scripts", "pytest.sb"),
    "iso_fs_sha256": os.path.join("scripts", "_iso_fs.sh"),
    "wrapper_sha256": os.path.join("scripts", "isolated-pytest.sh"),
    "guard_sha256": os.path.join("tests", "_isolation_guard.py"),
    "conftest_sha256": os.path.join("tests", "conftest.py"),
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


def test_wrapper_opens_protected_files_only_in_snapshot():
    """P2-1 정적 보조: 원본 해시 대상(pytest.sb·_iso_fs.sh·G3-ATTESTATION·가드·conftest)을 여는 곳은
    스냅숏 진입(`take_snapshot "$P" "$WRAPPER_SELF"`)뿐이고, 자기시험 래퍼 복사본은 cp 가 아니라 스냅숏 바이트다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        code = [line for line in fh if not line.lstrip().startswith("#")]
    text = "".join(code)
    assert not [line for line in code if re.search(
        r'\$P/(scripts/(pytest\.sb|_iso_fs\.sh|G3-ATTESTATION)|tests/(_isolation_guard\.py|conftest\.py))', line)]
    assert not [line for line in code if re.match(r"\s*\.\s", line) or re.match(r"\s*source\s", line)]
    assert 'attest_gate "$P" "$WRAPPER_SELF"' in text
    assert 'take_snapshot "$P" "$WRAPPER_SELF"' in text
    assert 'cp -- "${BASH_SOURCE[0]}"' not in text


def test_wrapper_attest_keys_cover_five_files():
    """정적: 래퍼의 승인 키·해시 키 목록이 이 파일의 HASHED 와 같다(키 추가·삭제가 한쪽만 바뀌지 않게)."""
    with open(WRAPPER, encoding="utf-8") as fh:
        text = fh.read()
    hash_keys = re.search(r"^HASH_KEYS=\(([^)]*)\)$", text, re.M)
    attest_keys = re.search(r"^ATTEST_KEYS=\(([^)]*)\)$", text, re.M)
    assert hash_keys and attest_keys
    assert set(hash_keys.group(1).split()) == set(HASHED)
    assert set(attest_keys.group(1).split()) == set(HASHED) | {"attested_at", "evidence", "main_commit"}
