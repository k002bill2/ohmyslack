"""outside(사람 전용) 항목이 에이전트 경로에 들어오지 않음을 정적으로 고정(설계 r4 §Q5 ★구성 6, I-3).

probe_outside 를 수집·실행하지 않는다 — 파일 읽기와 순수 함수만. 실제 연결(무인자·`.`·`tests`·`tests_isolation`
수집 outside 0건, 직접 지정 rc 4 + 표지)은 래퍼 `--preflight` 가 sandbox 안에서 확인한다(Codex 1차 P2).
"""

from __future__ import annotations

import ast
import configparser
import os

from .conftest import P_DIR, guard

OUTSIDE_NAME = "probe_outside"
OUTSIDE_DIR = os.path.join(P_DIR, OUTSIDE_NAME)


def test_outside_excluded_statically():
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(P_DIR, "pytest.ini"), encoding="utf-8")
    assert f"--ignore={OUTSIDE_NAME}" in cfg.get("pytest", "addopts").split()
    # pytest 는 인자 디렉터리 바로 아래 test* 디렉터리의 conftest 를 자동으로 읽는다 — 사람 전용 디렉터리는 그 이름을 피한다.
    assert not OUTSIDE_NAME.startswith("test")
    assert not os.path.exists(os.path.join(P_DIR, "tests_outside"))
    assert cfg.get("pytest", "testpaths").split() == ["tests"]
    here = os.listdir(os.path.dirname(os.path.abspath(__file__)))
    assert not [name for name in here if name.startswith("test_outside_probe")]
    assert os.path.isfile(os.path.join(OUTSIDE_DIR, "pytest.ini"))


def test_outside_marker_required():
    # 판정 함수 보조 점검. 직접 지정의 실제 EXIT 4 + 표지는 래퍼 preflight 의 sandbox 수집이 확인한다.
    assert guard.outside_problems({}, "tok")
    assert guard.outside_problems({"OHMYSLACK_OUTSIDE_PROBE": "other"}, "tok")
    assert guard.outside_problems({"OHMYSLACK_OUTSIDE_PROBE": "tok"}, None)
    assert guard.outside_problems({"OHMYSLACK_OUTSIDE_PROBE": ""}, None)
    assert guard.outside_problems({"OHMYSLACK_OUTSIDE_PROBE": "tok"}, "tok") == []
    assert guard.OUTSIDE_EXIT == 4


def _module(path: str) -> ast.Module:
    with open(path, encoding="utf-8") as fh:
        return ast.parse(fh.read(), filename=path)


def test_outside_conftest_checks_marker_first():
    # 표지 검사가 스텁·가드·그 밖 어떤 동작보다 먼저다(우발 로드 때 다른 코드 실행 0).
    with open(os.path.join(OUTSIDE_DIR, "conftest.py"), encoding="utf-8") as fh:
        text = fh.read()
    first = text.index("enforce_outside(")
    assert first < text.index("hermes_bootstrap")
    assert first < text.index("_guard.enforce(")


def test_outside_probe_has_no_toplevel_side_effects():
    # 수집 단계에서 밖 접근 0: 최상위는 docstring·import(표준 라이브러리)·상수·함수 정의뿐.
    tree = _module(os.path.join(OUTSIDE_DIR, "test_outside_probe.py"))
    for node in tree.body:
        if isinstance(node, ast.Expr):
            assert isinstance(node.value, ast.Constant), ast.dump(node)
        elif isinstance(node, ast.Import):
            assert all(a.name.split(".")[0] in {"os", "socket", "importlib"} for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.module in {"__future__"}
        elif isinstance(node, ast.Assign):
            assert isinstance(node.value, ast.Constant), ast.dump(node)
        else:
            assert isinstance(node, ast.FunctionDef), ast.dump(node)
