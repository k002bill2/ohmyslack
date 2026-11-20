"""`--run-live` 거부 경로 점검(Hermes import 0, Issue #47 레인 B). 래퍼 `--preflight` 가 sandbox 안에서 실행한다.

sandbox 안에서는 bash 를 exec·fork 할 수 없어서(`scripts/pytest.sb` process-exec·process-fork 거부), test_attestation.py 와
같은 방식으로 래퍼가 sandbox 밖에서 돌린 자기시험(`run_live_selftest`) 결과를 읽는다 — 사례마다 **실제 래퍼 복사본**
(`$ISO/tmp/run-live-selftest/fake/…`, 해시 게이트 통과)을 `env -i` 로 `--run-live` 호출한 종료 코드·stdout·stderr.
비밀 자리에는 가짜 표지 값(`OMS-SELFTEST-SECRET…`)만 쓰고, 그 표지가 어떤 출력에도 나오지 않는지 단언한다.
실제 live 실행(실서버·sandbox)은 여기서 시험하지 않는다.
"""

from __future__ import annotations

import os
import re

import pytest

from .conftest import ISO, P_DIR

SCRIPTS = os.path.join(P_DIR, "scripts")
WRAPPER = os.path.join(SCRIPTS, "isolated-pytest.sh")
LIVE_E2E = os.path.join(SCRIPTS, "live-e2e.sh")
SELFTEST = os.path.join(ISO, "tmp", "run-live-selftest")
SECRET_MARK = "OMS-SELFTEST-SECRET"

URL_RULE = "must be exactly http://127.0.0.1:<1024-65535> and not an operating port"
SECRET_RULE = "must be a non-empty single line"
NO_ARGS = "--run-live takes no arguments"

# 사례 → 기대 사유(모두 EXIT 64). 래퍼 RUN_LIVE_CASES 와 같은 이름.
REJECT = {
    "extra_arg": NO_ARGS,
    "confirm_arg": NO_ARGS,
    "empty_confirm": NO_ARGS,
    "url_malformed": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_prod_8787": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_prod_8788": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_localhost": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_any_host": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_https": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_low_port": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "url_port_over": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "token_missing": f"OHMYSLACK_BOT_TOKEN {SECRET_RULE}",
    "token_empty": f"OHMYSLACK_BOT_TOKEN {SECRET_RULE}",
    "token_newline": f"OHMYSLACK_BOT_TOKEN {SECRET_RULE}",
    "live_flag_missing": "OHMYSLACK_LIVE_E2E must be 1",
    "live_flag_not_1": "OHMYSLACK_LIVE_E2E must be 1",
    "main_url_prod": f"OHMYSLACK_LIVE_MAIN_URL {URL_RULE}",
    "origin_bad": f"OHMYSLACK_LIVE_ORIGIN {URL_RULE}",
    "cookie_missing": f"OHMYSLACK_LIVE_COOKIE {SECRET_RULE}",
    "csrf_missing": f"OHMYSLACK_LIVE_CSRF {SECRET_RULE}",
}
# 대조군: 모든 값이 유효하면 검증을 통과해 다음 단계(require_sandbox)에서 멈춘다 — 가짜 P 에 .venv 가 없어 EXIT 6.
VALID = "valid_env"


def _read(name: str) -> str:
    with open(os.path.join(SELFTEST, name), encoding="utf-8") as fh:
        return fh.read()


def _result() -> dict[str, str]:
    return dict(line.split("=", 1) for line in _read("result").split())


def test_every_case_recorded():
    assert set(_result()) == set(REJECT) | {VALID}


@pytest.mark.parametrize("case", sorted(REJECT))
def test_run_live_rejects_with_64_and_no_secret(case):
    assert _result()[case] == "64"
    out, err = _read(f"{case}.out"), _read(f"{case}.err")
    assert out == ""
    assert REJECT[case] in err, err
    assert SECRET_MARK not in out and SECRET_MARK not in err
    assert "re-attestation by human required" not in err  # 해시 게이트는 통과한 뒤의 거부


def test_run_live_valid_env_passes_validation():
    """검증 통과 → require_sandbox 에서 EXIT 6(가짜 P 에 venv 없음). 검증이 유효 값을 거부하지 않는다는 대조군."""
    assert _result()[VALID] == "6"
    out, err = _read(f"{VALID}.out"), _read(f"{VALID}.err")
    assert "venv interpreter missing" in err, err
    assert NO_ARGS not in err and "must be" not in err  # 64 사유 없음
    assert SECRET_MARK not in out and SECRET_MARK not in err


def _function_body(text: str, name: str) -> str:
    m = re.search(rf"^{name}\(\) \{{\n(.*?)^\}}", text, re.M | re.S)
    assert m, name
    return m.group(1)


def test_run_live_passes_secrets_as_files_only():
    """정적: mode_run_live 는 sandbox env 에 비밀 값이 아니라 *_FILE 경로만 싣고, 고정 pytest 인자만 쓴다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        body = _function_body(fh.read(), "mode_run_live")
    for name in ("OHMYSLACK_BOT_TOKEN", "OHMYSLACK_LIVE_COOKIE", "OHMYSLACK_LIVE_CSRF"):
        assert f"{name}_FILE=" in body
        assert f"{name}=" not in body
    assert "-q -m live tests/test_live_e2e.py tests/test_live_standalone.py" in body
    assert "EXTRA_ARGS" not in body


def test_live_e2e_uses_wrapper_not_direct_pytest():
    """정적: live-e2e.sh 는 pytest 를 sandbox 밖에서 직접 부르지 않고 `--run-live` 한 번만 부른다."""
    with open(LIVE_E2E, encoding="utf-8") as fh:
        code = [line for line in fh if not line.lstrip().startswith("#")]
    text = "".join(code)
    assert "-m pytest" not in text
    assert "OHMYSLACK_LIVE_OWNER_SEND" not in text
    assert len(re.findall(r'isolated-pytest\.sh" --run-live\s*$', text, re.M)) == 1
    assert not re.search(r"^\s*export\s+OHMYSLACK_", text, re.M)


def test_live_tests_read_secret_files_and_spawn_nothing():
    """정적: live 두 파일은 토큰을 `_secret`(env 또는 *_FILE)로 읽고, sandbox 에서 막히는 subprocess 를 쓰지 않는다."""
    for name in ("test_live_e2e.py", "test_live_standalone.py"):
        with open(os.path.join(P_DIR, "tests", name), encoding="utf-8") as fh:
            text = fh.read()
        assert 'BOT_TOKEN = _secret("OHMYSLACK_BOT_TOKEN")' in text, name
        assert "create_subprocess" not in text and "import subprocess" not in text, name
