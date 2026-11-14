"""tests_isolation 전용 conftest — Hermes import 0, 표준 라이브러리 + pytest 만.

래퍼 `--preflight`가 sandbox 안에서 이 디렉터리만 실행한다(설계 r4 §Q5 ★구성 5).
가드 모듈은 `P/tests`를 sys.path에 올리지 않고 파일 경로로 읽는다(`conftest` 이름 가림 방지).
"""

from __future__ import annotations

import importlib.util
import os
import sys

P_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ISO = os.path.join(P_DIR, ".isolation")
GUARD_PATH = os.path.join(P_DIR, "tests", "_isolation_guard.py")


def load_guard():
    spec = importlib.util.spec_from_file_location("_ohmyslack_isolation_guard_ti", GUARD_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


guard = load_guard()
# 이 디렉터리도 래퍼 밖에서는 돌지 않는다.
guard.enforce(ISO)
