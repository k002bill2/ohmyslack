"""격리 실행 가드(순수 함수 + 종료 진입점). Hermes import 0 — 표준 라이브러리만 쓴다.

보조 장치다: 「래퍼 없이 돌렸다」·「재실행됐다」를 시작 시 실패로 바꿀 뿐, 파일 접근을 막지 않는다.
OS 수준 차단은 `scripts/pytest.sb`(sandbox-exec)의 몫이다. 설계 r4 §Q5 ★구성 4·6.

종료는 `os._exit`로 한다. pytest 9의 `pytest.exit`는 `Exception` 하위라 최초 conftest에서
`ConftestImportFailure`로 감싸져 EXIT 4가 되고, 수집 중 `SystemExit`는 INTERNAL_ERROR(=3)와
겹친다 — 그래서 래퍼는 종료 코드와 함께 아래 고유 표지 문자열을 확인한다(I-4).
"""

from __future__ import annotations

import os
import sys
from typing import Mapping, Optional

GUARD_MARKER = "OHMYSLACK-ISOLATION-GUARD-REFUSED"
OUTSIDE_MARKER = "OHMYSLACK-OUTSIDE-GUARD-REFUSED"
GUARD_EXIT = 3
OUTSIDE_EXIT = 4

# env 이름 → $ISO 아래 기대 하위 경로
ISO_PATH_VARS: Mapping[str, str] = {
    "HERMES_HOME": "hermes-home",
    "HOME": "home",
    "TMPDIR": "tmp",
    "PYTHONPYCACHEPREFIX": "pycache",
}


def default_iso() -> str:
    """`<P>/.isolation` — 이 파일(`<P>/tests/_isolation_guard.py`) 위치에서 계산한다."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(here), ".isolation")


def _same_real(value: str, expected: str) -> bool:
    """존재 검사가 아니라 정규화 값 비교 — 운영 값·임의 값이 설정돼 있으면 거짓."""
    if not value:
        return False
    return os.path.realpath(value) == os.path.realpath(expected)


def read_token(path: str) -> Optional[str]:
    """symlink가 아닌 일반 파일의 내용(앞뒤 공백 제거). 없거나 이상하면 None."""
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return None
        with open(path, encoding="ascii") as fh:
            token = fh.read().strip()
    except OSError:
        return None
    return token or None


def isolation_problems(env: Mapping[str, str], iso: str, run_token: Optional[str],
                       relaunched: bool) -> list[str]:
    """격리 실행 조건 위반 목록(빈 목록 = 통과). 순수 함수 — 파일·env를 직접 읽지 않는다."""
    problems: list[str] = []
    for name, sub in ISO_PATH_VARS.items():
        if not _same_real(env.get(name, ""), os.path.join(iso, sub)):
            problems.append(f"{name} is not <ISO>/{sub}")
    marker = env.get("OHMYSLACK_ISOLATED_RUN", "")
    if not marker or run_token is None or marker != run_token:
        problems.append("OHMYSLACK_ISOLATED_RUN does not match <ISO>/run-token")
    if relaunched:
        problems.append("sys._hermes_relaunched is set (relaunched interpreter)")
    return problems


def outside_problems(env: Mapping[str, str], outside_token: Optional[str]) -> list[str]:
    """사람 전용 outside 실행 표지 위반 목록. 순수 함수."""
    marker = env.get("OHMYSLACK_OUTSIDE_PROBE", "")
    if not marker or outside_token is None or marker != outside_token:
        return ["OHMYSLACK_OUTSIDE_PROBE does not match <ISO>/outside-token"]
    return []


def _refuse(marker: str, code: int, problems: list[str]) -> None:
    sys.stderr.write(f"{marker}: " + "; ".join(problems) + "\n")
    sys.stderr.flush()
    os._exit(code)


def enforce(iso: Optional[str] = None) -> None:
    """위반이 하나라도 있으면 표지 출력 후 즉시 EXIT 3."""
    iso = iso or default_iso()
    problems = isolation_problems(os.environ, iso, read_token(os.path.join(iso, "run-token")),
                                  bool(getattr(sys, "_hermes_relaunched", False)))
    if problems:
        _refuse(GUARD_MARKER, GUARD_EXIT, problems)


def enforce_outside(iso: Optional[str] = None) -> None:
    """outside 표지가 그 실행의 `$ISO/outside-token`과 다르면 즉시 EXIT 4."""
    iso = iso or default_iso()
    problems = outside_problems(os.environ, read_token(os.path.join(iso, "outside-token")))
    if problems:
        _refuse(OUTSIDE_MARKER, OUTSIDE_EXIT, problems)
