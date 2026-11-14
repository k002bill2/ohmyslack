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
    for key, name in (("profile_sha256", "pytest.sb"), ("iso_fs_sha256", "_iso_fs.sh")):
        found = re.findall(rf"^{key}=([0-9a-f]{{64}})$", text, re.M)
        assert found == [_sha256(os.path.join(SCRIPTS, name))], key


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
    """P2-1 정적 보조: 원본 pytest.sb·_iso_fs.sh 를 여는 곳은 스냅숏 진입(`take_snapshot "$P/scripts"`)뿐."""
    with open(WRAPPER, encoding="utf-8") as fh:
        code = [line for line in fh if not line.lstrip().startswith("#")]
    assert not [line for line in code if re.search(r'\$P/scripts/(pytest\.sb|_iso_fs\.sh)', line)]
    assert not [line for line in code if re.match(r"\s*\.\s", line) or re.match(r"\s*source\s", line)]
