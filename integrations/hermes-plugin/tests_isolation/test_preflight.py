"""sandbox 안 카나리·환경 고정 점검(설계 r4 §Q5 ★구성 5). worktree 안에서 끝나는 점검만 둔다."""

from __future__ import annotations

import ast
import glob
import os
import sys

import pytest

from conftest import ISO, P_DIR

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
    names: list[str] = []
    stack = list(tree.body)
    while stack:
        node = stack.pop()
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
        elif isinstance(node, (ast.If, ast.Try)):
            stack.extend(node.body)
            stack.extend(getattr(node, "orelse", []))
            stack.extend(getattr(node, "finalbody", []))
            for handler in getattr(node, "handlers", []):
                stack.extend(handler.body)
    return names


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
