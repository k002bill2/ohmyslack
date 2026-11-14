"""sandbox 안 카나리·환경 고정 점검(설계 r4 §Q5 ★구성 5). worktree 안에서 끝나는 점검만 둔다."""

from __future__ import annotations

import ast
import glob
import os
import sys

import pytest

from .conftest import ISO, P_DIR

# 래퍼가 넘기는 env 허용목록(설계 ★구성 1). PYTHONPATH 는 preflight 에서 비운다.
EXPECTED_ENV = {
    "PATH", "LANG", "HOME", "HERMES_HOME", "TMPDIR", "PYTHONPYCACHEPREFIX",
    "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
    "OHMYSLACK_ISOLATED_RUN",
}
# pytest 자신이 실행 중에 넣는 키(main()의 PYTEST_VERSION, 테스트별 PYTEST_CURRENT_TEST)
PYTEST_OWN_ENV = {"PYTEST_VERSION", "PYTEST_CURRENT_TEST"}
# macOS 가 프로세스 기동 때 넣는 키(env -i 뒤에도 생김 — preflight-4 실측). 값은 문자 인코딩 코드뿐.
OS_OWN_ENV = {"__CF_USER_TEXT_ENCODING"}
HERMES_TOPLEVEL = ("ohmyslack", "gateway", "hermes_cli", "hermes_bootstrap", "agent", "cron", "tools")


def test_preflight_canary_deny_in_iso():
    with pytest.raises(PermissionError):
        with open(os.path.join(ISO, "canary-deny", "x"), "w") as fh:
            fh.write("x")


def test_preflight_worktree_path_outside_allowlist_denied():
    target = os.path.join(P_DIR, "tests", ".canary")
    try:
        with open(target, "w") as fh:
            fh.write("x")
    except PermissionError:
        return
    os.unlink(target)  # 쓰기가 됐다 = 프로필 쓰기 기본 거부가 깨짐. 흔적을 지우고 실패.
    pytest.fail(f"write outside allowlist succeeded: {target}")


def test_preflight_iso_tmp_writable():
    target = os.path.join(ISO, "tmp", "x")
    with open(target, "w") as fh:
        fh.write("x")
    assert os.path.exists(target)


def test_preflight_env_is_allowlist():
    assert set(os.environ) - PYTEST_OWN_ENV - OS_OWN_ENV == EXPECTED_ENV
    assert "PYTHONPATH" not in os.environ
    assert os.environ["PATH"] == "/usr/bin:/bin"
    assert sys.flags.no_user_site == 1
    assert sys.dont_write_bytecode
    assert sys.pycache_prefix == os.path.realpath(os.path.join(ISO, "pycache"))


def _toplevel_imports(tree: ast.Module) -> list[str]:
    """모듈 로딩 때 실행되는 import 전부. 함수·메서드 본문만 뺀다(Codex 1차 P3).

    `class` 본문·`with`·`for`·`while`·`try`(except·else·finally·except*)·`if`·`match` 는 모두
    모듈 실행 중에 돈다 — 문장 종류를 나열하지 않고 자식 노드 전체를 훑되 함수 정의만 건너뛴다
    (import 문은 식 안에 올 수 없으므로 lambda 는 볼 필요가 없다).
    """
    names: list[str] = []
    stack: list[ast.AST] = list(tree.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
        stack.extend(ast.iter_child_nodes(node))
    return names


# 구문별 회귀 사례: 모듈 로딩 때 실행되는 위치의 Hermes import 는 모두 잡혀야 한다.
EXECUTED_AT_IMPORT = {
    "plain": "import gateway\n",
    "class_body": "class A:\n    import gateway\n",
    "nested_class_body": "class A:\n    class B:\n        from gateway import x\n",
    "with": "with open('x') as fh:\n    import gateway\n",
    "for": "for _ in ():\n    import gateway\nelse:\n    pass\n",
    "for_else": "for _ in ():\n    pass\nelse:\n    import gateway\n",
    "while": "while False:\n    import gateway\n",
    "while_else": "while False:\n    pass\nelse:\n    import gateway\n",
    "if_else": "if False:\n    pass\nelse:\n    import gateway\n",
    "try_body": "try:\n    import gateway\nexcept Exception:\n    pass\n",
    "try_handler": "try:\n    pass\nexcept Exception:\n    import gateway\n",
    "try_else_finally": "try:\n    pass\nexcept Exception:\n    pass\nelse:\n    import gateway\nfinally:\n    import hermes_cli\n",
    "try_star": "try:\n    pass\nexcept* ValueError:\n    import gateway\n",
    "match": "match 1:\n    case 1:\n        import gateway\n    case _:\n        pass\n",
    "deep_mix": "if True:\n    class A:\n        with x:\n            for _ in y:\n                try:\n                    import ohmyslack.adapter\n                except E:\n                    pass\n",
}
# 함수·메서드 본문은 호출될 때만 돈다 — 잡지 않는다(오탐 방지 대조군).
NOT_EXECUTED_AT_IMPORT = {
    "function": "def f():\n    import gateway\n",
    "async_function": "async def f():\n    import gateway\n",
    "method": "class A:\n    def m(self):\n        import gateway\n",
    "nested_function": "if True:\n    def f():\n        import gateway\n",
    "relative": "from . import gateway\n",
}


def _hermes_names(source: str) -> list[str]:
    tree = ast.parse(source)
    return [n for n in _toplevel_imports(tree) if n.split(".")[0] in HERMES_TOPLEVEL]


@pytest.mark.parametrize("case", sorted(EXECUTED_AT_IMPORT))
def test_toplevel_import_scan_catches_executed_statements(case):
    assert _hermes_names(EXECUTED_AT_IMPORT[case]), case


@pytest.mark.parametrize("case", sorted(NOT_EXECUTED_AT_IMPORT))
def test_toplevel_import_scan_skips_function_bodies(case):
    assert _hermes_names(NOT_EXECUTED_AT_IMPORT[case]) == [], case


def test_tests_dir_has_no_toplevel_hermes_imports():
    # I-3 정적 보조: P/tests/*.py 최상위에 ohmyslack·gateway(및 Hermes 패키지) import 가 없다
    # → sandbox 안 `--collect-only tests` 부정 검사가 Hermes 를 import 하지 않는 근거.
    files = sorted(glob.glob(os.path.join(P_DIR, "tests", "*.py")))
    assert files
    offenders = []
    for path in files:
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=path)
        for name in _toplevel_imports(tree):
            if name.split(".")[0] in HERMES_TOPLEVEL:
                offenders.append(f"{os.path.basename(path)}: {name}")
    assert offenders == []
