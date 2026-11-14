"""`--run-attested` 해시 대조 점검(Hermes import 0). 래퍼 `--preflight` 가 sandbox 안에서 실행한다.

sandbox 안에서는 bash·shasum 을 exec 할 수 없어서, EXIT 5 단언은 래퍼가 sandbox 밖에서 `$ISO/tmp` 복사본으로
돌린 자기시험(`attest_selftest`) 결과를 읽는다. 형식 단언은 hashlib 로 독립 계산해 교차 확인한다.
"""

from __future__ import annotations

import hashlib
import os
import re

from .conftest import ISO, P_DIR

SCRIPTS = os.path.join(P_DIR, "scripts")
ATTESTATION = os.path.join(SCRIPTS, "G3-ATTESTATION")
SELFTEST = os.path.join(ISO, "tmp", "attest-selftest")
KEYS = {"profile_sha256", "iso_fs_sha256", "attested_at", "evidence", "main_commit"}
REFUSAL = "re-attestation by human required"


def parse_attestation(text: str) -> dict[str, str]:
    """주석(#)·빈 줄 외에는 `키=값` 만, 알려진 키가 정확히 한 번씩. 어긋나면 ValueError."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key not in KEYS:
            raise ValueError(f"unknown or malformed line: {line!r}")
        if key in values:
            raise ValueError(f"duplicate key: {key}")
        values[key] = value
    if set(values) != KEYS:
        raise ValueError(f"missing keys: {sorted(KEYS - set(values))}")
    return values


def _sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def test_attestation_format_and_hashes_match_current_files():
    with open(ATTESTATION, encoding="utf-8") as fh:
        values = parse_attestation(fh.read())
    assert re.fullmatch(r"[0-9a-f]{64}", values["profile_sha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", values["iso_fs_sha256"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", values["attested_at"])
    assert re.fullmatch(r"[0-9a-f]{7,40}", values["main_commit"])
    assert values["evidence"]
    assert values["profile_sha256"] == _sha256(os.path.join(SCRIPTS, "pytest.sb"))
    assert values["iso_fs_sha256"] == _sha256(os.path.join(SCRIPTS, "_iso_fs.sh"))


def test_parse_attestation_rejects_malformed():
    good = "profile_sha256=a\niso_fs_sha256=b\nattested_at=c\nevidence=d\nmain_commit=e\n"
    assert parse_attestation("# c\n\n" + good)["evidence"] == "d"
    for bad in (good + "extra=1\n", good + "profile_sha256=x\n", good.replace("evidence=d\n", ""),
                good + "no-equals-line\n"):
        try:
            parse_attestation(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted malformed attestation: {bad!r}")


def test_attest_gate_exits_5_on_hash_mismatch_in_iso_copy():
    with open(os.path.join(SELFTEST, "result"), encoding="ascii") as fh:
        result = dict(line.split("=", 1) for line in fh.read().split())
    assert result == {"unmodified": "0", "profile_modified": "5", "iso_fs_modified": "5"}

    def err(name: str) -> str:
        with open(os.path.join(SELFTEST, f"{name}.err"), encoding="utf-8") as fh:
            return fh.read()

    assert REFUSAL not in err("unmodified")
    assert REFUSAL in err("profile_modified") and "pytest.sb sha256 differs" in err("profile_modified")
    assert REFUSAL in err("iso_fs_modified") and "_iso_fs.sh sha256 differs" in err("iso_fs_modified")
