"""사람 전용 outside 점검 conftest — 에이전트 실행 금지(설계 r4 §Q5 ★구성 6, (나)-0).

첫 동작은 outside 표지 검사다: `--prove-outside` 가 그 실행에만 만든 `$ISO/outside-token` 과
env `OHMYSLACK_OUTSIDE_PROBE` 가 다르면 다른 어떤 코드도 돌기 전에 EXIT 4.
"""

from __future__ import annotations

import importlib.util as _ilu
import os as _os
import sys as _sys

_spec = _ilu.spec_from_file_location(
    "_ohmyslack_isolation_guard_to",
    _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "tests", "_isolation_guard.py"),
)
_guard = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_guard)
_guard.enforce_outside()

import types as _types  # noqa: E402

_sys.modules.setdefault("hermes_bootstrap", _types.ModuleType("hermes_bootstrap"))
_sys.dont_write_bytecode = True
_guard.enforce()
