"""가드 순수 함수 판정(설계 r4 §4 단계 1). 파일 쓰기는 $ISO/tmp 아래만."""

from __future__ import annotations

import os

import pytest

from .conftest import ISO, guard

TOKEN = "t0ken"


def isolated_env(**over: str) -> dict:
    env = {
        "HERMES_HOME": os.path.join(ISO, "hermes-home"),
        "HOME": os.path.join(ISO, "home"),
        "TMPDIR": os.path.join(ISO, "tmp"),
        "PYTHONPYCACHEPREFIX": os.path.join(ISO, "pycache"),
        "OHMYSLACK_ISOLATED_RUN": TOKEN,
    }
    env.update(over)
    return env


def test_guard_accepts_isolated_env():
    assert guard.isolation_problems(isolated_env(), ISO, TOKEN, False) == []


@pytest.mark.parametrize("value", ["", "/nonexistent-hermes-home", "~/.hermes"])
def test_guard_rejects_unset_or_foreign_hermes_home(value, tmp_path):
    env = isolated_env(HERMES_HOME=value)
    if not value:
        del env["HERMES_HOME"]
    assert guard.isolation_problems(env, ISO, TOKEN, False)


def test_guard_rejects_existing_foreign_hermes_home(tmp_path):
    # 존재하는 다른 디렉터리 — 존재 검사로는 통과해 버리는 경우(뮤테이션 4c 대상).
    foreign = tmp_path / "other-hermes-home"
    foreign.mkdir()
    assert guard.isolation_problems(isolated_env(HERMES_HOME=str(foreign)), ISO, TOKEN, False)


@pytest.mark.parametrize("name", ["HOME", "TMPDIR", "PYTHONPYCACHEPREFIX"])
def test_guard_rejects_foreign_iso_paths(name, tmp_path):
    assert guard.isolation_problems(isolated_env(**{name: str(tmp_path)}), ISO, TOKEN, False)


def test_guard_rejects_missing_or_wrong_run_token():
    no_marker = isolated_env()
    del no_marker["OHMYSLACK_ISOLATED_RUN"]
    assert guard.isolation_problems(no_marker, ISO, TOKEN, False)
    assert guard.isolation_problems(isolated_env(OHMYSLACK_ISOLATED_RUN="other"), ISO, TOKEN, False)
    assert guard.isolation_problems(isolated_env(), ISO, None, False)


def test_guard_rejects_relaunched_marker():
    assert guard.isolation_problems(isolated_env(), ISO, TOKEN, True)


def test_read_token_refuses_symlink(tmp_path):
    real = tmp_path / "real-token"
    real.write_text("abc\n")
    link = tmp_path / "link-token"
    link.symlink_to(real)
    assert guard.read_token(str(real)) == "abc"
    assert guard.read_token(str(link)) is None
    assert guard.read_token(str(tmp_path / "missing")) is None
