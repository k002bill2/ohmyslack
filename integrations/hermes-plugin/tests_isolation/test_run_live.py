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
    # QA O-7 포트 경계(65536 은 위 url_port_over). 운영 포트는 MAIN_URL·ORIGIN 에도 적용.
    "url_port_1023": f"OHMYSLACK_BOT_URL {URL_RULE}",
    "main_url_8788": f"OHMYSLACK_LIVE_MAIN_URL {URL_RULE}",
    "origin_8787": f"OHMYSLACK_LIVE_ORIGIN {URL_RULE}",
}
# 대조군: 모든 값이 유효하면 검증을 통과해 다음 단계(require_sandbox)에서 멈춘다 — 가짜 P 에 .venv 가 없어 EXIT 6.
VALID = "valid_env"
PASS = (VALID, "url_port_1024", "url_port_65535", "xtrace_env")
# QA O-2: 가짜 P 복사본에서 해시 대상 1바이트 변형 → 해시 게이트 EXIT 5(env 는 모두 유효).
HASH_MISMATCH = {
    "hash_profile_modified": "scripts/pytest.sb sha256 differs from G3-ATTESTATION",
    "hash_guard_modified": "tests/_isolation_guard.py sha256 differs from G3-ATTESTATION",
    # Issue #48 2차(QA O-7): pytest.ini 도 해시 대상.
    "hash_ini_modified": "pytest.ini sha256 differs from G3-ATTESTATION",
}
REFUSAL = "re-attestation by human required"


def _read(name: str) -> str:
    with open(os.path.join(SELFTEST, name), encoding="utf-8") as fh:
        return fh.read()


def _result() -> dict[str, str]:
    return dict(line.split("=", 1) for line in _read("result").split())


def test_every_case_recorded():
    assert set(_result()) == set(REJECT) | set(PASS) | set(HASH_MISMATCH)


@pytest.mark.parametrize("case", sorted(REJECT))
def test_run_live_rejects_with_64_and_no_secret(case):
    assert _result()[case] == "64"
    out, err = _read(f"{case}.out"), _read(f"{case}.err")
    assert out == ""
    assert REJECT[case] in err, err
    assert SECRET_MARK not in out and SECRET_MARK not in err
    assert REFUSAL not in err  # 해시 게이트는 통과한 뒤의 거부


@pytest.mark.parametrize("case", PASS)
def test_run_live_valid_env_passes_validation(case):
    """검증 통과 → require_sandbox 에서 EXIT 6(가짜 P 에 venv 없음). 검증이 유효 값(포트 1024·65535 경계 포함)을
    거부하지 않는다는 대조군."""
    assert _result()[case] == "6"
    out, err = _read(f"{case}.out"), _read(f"{case}.err")
    assert "venv interpreter missing" in err, err
    assert NO_ARGS not in err and "must be" not in err  # 64 사유 없음
    assert REFUSAL not in err
    assert SECRET_MARK not in out and SECRET_MARK not in err


def test_run_live_xtrace_env_does_not_trace_secret_assignments():
    """N-3: SHELLOPTS=xtrace 로 시작해도 래퍼가 게이트 전에 xtrace 를 끈다 → 비밀 대입·write_secret 인자가 stderr 에
    나오지 않는다(맨 앞 몇 줄의 trace 에는 비밀이 없다). valid env 와 같은 EXIT 6."""
    assert _result()["xtrace_env"] == "6"
    out, err = _read("xtrace_env.out"), _read("xtrace_env.err")
    assert SECRET_MARK not in out and SECRET_MARK not in err
    assert "LIVE_BOT_TOKEN=" not in err and "write_secret" not in err and "OHMYSLACK_BOT_TOKEN" not in err, err
    assert "venv interpreter missing" in err, err
    # Issue #58-1 양성 대조: SHELLOPTS 가 무시되는 환경이면 위 단언은 수정 전 코드도 통과한다. xtrace 가 실제로 켜진 채
    # 시작했다는 증거로, 래퍼 맨 앞 정리 구문(66–72행: `builtin unset -f -- …`·`builtin unset BASH_XTRACEFD`·
    # `builtin set +x +o xtrace`)의 trace 줄(bash 3.2 기본 PS4 `+ `, env -i 라 PS4 불변)이 있어야 하고, xtrace 를
    # 끄는 줄 뒤에는 trace 줄이 0줄이어야 한다.
    trace = _trace_lines(err)
    assert trace, err
    assert any(k in trace[0] for k in XTRACE_PRELUDE), err
    off = [i for i, line in enumerate(trace) if "set +x" in line]
    assert off, err
    assert trace[off[0] + 1:] == [], err
    # 대조군: SHELLOPTS 없는 valid env 에는 trace 줄이 0줄이다.
    assert _trace_lines(_read(f"{VALID}.err")) == []


# 래퍼 맨 앞 정리 구문(isolated-pytest.sh 66–72행)에 실제로 있는 문자열 — 첫 trace 줄은 이 중 하나를 담는다.
XTRACE_PRELUDE = ("builtin unset", "unset -f", "BASH_XTRACEFD", "set +x")


def _trace_lines(err: str) -> list[str]:
    """xtrace 줄(PS4 `+ `, 중첩이면 `++ `)만. 래퍼의 die 사유는 `isolated-pytest:` 로 시작한다."""
    return [line for line in err.splitlines() if re.match(r"\++ ", line)]


XTRACE_OFF = "builtin set +x +o xtrace"
# xtrace 를 다시 켜는 구문: `set -x`·`set -xv`·`set -euxo …` 류(짧은 옵션 묶음에 x), `-o xtrace`(set·shopt -o),
# `shopt … xtrace`, SHELLOPTS·BASH_XTRACEFD 대입.
XTRACE_ON = (
    re.compile(r"\bset\s+(?:[^;&|()\s]+\s+)*?-[A-Za-z]*x[A-Za-z]*(?=[\s;&|)]|$)"),
    re.compile(r"-o\s*xtrace\b"),
    re.compile(r"\bshopt\b[^;&|\n]*\bxtrace\b"),
    re.compile(r"\bSHELLOPTS\+?="),
    re.compile(r"\bBASH_XTRACEFD\+?="),
)
# 허용: run_live_selftest 가 `env -i` 자식 bash(가짜 P 래퍼 복사본)에 넘기는 env 배열 원소 — 이 셸의 대입이 아니다.
XTRACE_SELFTEST_ENV = "envs+=(SHELLOPTS=xtrace)"


def _code_lines(text: str) -> list[str]:
    """주석 제거한 bash 줄(줄 번호 유지). `#` 는 줄 맨 앞이나 공백 뒤에서만 주석(`${#a[@]}`·`$#` 는 남김)."""
    return [re.sub(r"(^|\s)#.*$", "", line) for line in text.splitlines()]


def _xtrace_on_hits(lines: list[str]) -> list[str]:
    return [line for line in lines if any(p.search(line.replace(XTRACE_SELFTEST_ENV, "")) for p in XTRACE_ON)]


def test_wrapper_never_reenables_xtrace_before_write_secret():
    """Issue #58-2 정적 근거: 래퍼 원문에서 xtrace 끄기 줄(`builtin set +x +o xtrace`)이 정확히 1줄이고, 그 뒤(그리고
    그 뒤 eval 로 적재되는 scripts/_iso_fs.sh)에 xtrace 를 다시 켜는 구문이 없으며, check_live_env·write_secret 의
    정의·호출이 모두 그 줄 뒤에 있다.

    위 xtrace_env 양성 대조(xtrace 가 켜진 채 시작해 끄는 줄 뒤 trace 0줄) + 이 정적 단언이 write_secret 인자 비노출의
    근거다. 자기시험은 EXIT 6(require_sandbox)에서 멈춰 write_secret 에 닿지 않는다 — 런타임 실측은 실제 sandbox·.venv
    가 필요한 live 경로(`--run-live`, 사람 실행)의 몫이다."""
    with open(WRAPPER, encoding="utf-8") as fh:
        lines = _code_lines(fh.read())
    off = [i for i, line in enumerate(lines) if line.strip().startswith(XTRACE_OFF)]
    assert len(off) == 1, off
    off_i = off[0]
    after = lines[off_i + 1:]
    assert _xtrace_on_hits(after) == []
    assert sum(line.count(XTRACE_SELFTEST_ENV) for line in after) == 1  # 허용 원소가 실제로 그 한 곳뿐(대조군)
    assert not re.search(r"\bset\s+-[A-Za-z]*x", "\n".join(lines[:off_i]))  # 끄기 전에 켜는 줄도 없음
    with open(os.path.join(SCRIPTS, "_iso_fs.sh"), encoding="utf-8") as fh:
        assert _xtrace_on_hits(_code_lines(fh.read())) == []
    assert any(re.match(r"eval \"\$ISOFS_SNAP\"", line) for line in after)  # _iso_fs.sh 적재도 끄는 줄 뒤
    for pattern in (r"^write_secret\(\) \{", r"^\s*write_secret \"", r"^check_live_env\(\) \{", r"\bcheck_live_env\s*$",
                    r"^\s*LIVE_BOT_TOKEN="):
        hits = [i for i, line in enumerate(lines) if re.search(pattern, line)]
        assert hits, pattern
        assert min(hits) > off_i, (pattern, hits, off_i)
    # 정규식 자체의 양성 대조: 켜는 구문은 잡고, 래퍼에 실제로 있는 무해한 set 은 잡지 않는다.
    for bad in ("set -x", "  set -xv", "set -euxo pipefail", "set -o xtrace", "shopt -s -o xtrace", "SHELLOPTS=xtrace",
                "export BASH_XTRACEFD=3", "( set -C; set -x )"):
        assert _xtrace_on_hits([bad]), bad
    for ok in ("set -euo pipefail", "( set -C; printf '%s' \"$x\" > \"$ISO/snapshot-pytest.sb\" )", "set -- .",
               "set -- \"$label\"", "builtin set +x +o xtrace", "[ \"$c\" != xtrace_env ] || envs+=(SHELLOPTS=xtrace)"):
        assert not _xtrace_on_hits([ok]), ok


@pytest.mark.parametrize("case", sorted(HASH_MISMATCH))
def test_run_live_hash_mismatch_exits_5(case):
    """QA O-2: 해시 대상(pytest.sb·가드·pytest.ini) 1바이트 변형 → env 검증·sandbox·.isolation 전에 EXIT 5, 비밀 표지 0건."""
    assert _result()[case] == "5"
    out, err = _read(f"{case}.out"), _read(f"{case}.err")
    assert out == ""
    assert REFUSAL in err and HASH_MISMATCH[case] in err, err
    assert SECRET_MARK not in out and SECRET_MARK not in err
    fake_p = os.path.join(SELFTEST, f"fake-{case}", "integrations", "hermes-plugin")
    assert os.path.isfile(os.path.join(fake_p, "pytest.ini"))  # 경로 대조군(가짜 P 가 실제로 그 자리에 있음)
    assert not os.path.lexists(os.path.join(fake_p, ".isolation"))


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
    # Issue #58-3: 래퍼 인터프리터는 호출자 PATH 의 `bash` 가 아니라 /bin/bash(래퍼의 PATH 고정 이전 단계).
    assert re.search(r'^\s*/bin/bash "\$PLUGIN/scripts/isolated-pytest\.sh" --run-live\s*$', text, re.M)
    assert not re.search(r'(^|[\s;&|(])bash "\$PLUGIN/scripts/isolated-pytest\.sh"', text, re.M)
    assert not re.search(r"^\s*export\s+OHMYSLACK_", text, re.M)


def test_live_e2e_disables_xtrace_first():
    """Issue #67-2: live-e2e.sh 는 맨 앞에서 xtrace 를 끈다(정적). 런타임 실측은 사람 --run-live 몫."""
    with open(LIVE_E2E, encoding="utf-8") as fh:
        lines = _code_lines(fh.read())
    unset = [i for i, line in enumerate(lines) if line.strip().startswith("builtin unset BASH_XTRACEFD")]
    off = [i for i, line in enumerate(lines) if line.strip().startswith(XTRACE_OFF)]
    assert len(unset) == 1, unset
    assert len(off) == 1, off
    assert unset[0] < off[0]
    # 첫 실행 구문이 이 두 줄: 앞선 줄은 (shebang·주석 제거 후) 빈 줄뿐.
    assert all(not line.strip() or line.startswith("#!") for line in lines[:unset[0]])
    off_i = off[0]
    after = lines[off_i + 1:]
    assert _xtrace_on_hits(after) == []
    for pattern in (r"\bset -a\b", r"BOT_TOKEN=", r"LIVE_COOKIE=", r"LIVE_CSRF=",
                    r'/bin/bash "\$PLUGIN/scripts/isolated-pytest\.sh" --run-live'):
        hits = [i for i, line in enumerate(lines) if re.search(pattern, line)]
        assert hits, pattern
        assert min(hits) > off_i, (pattern, hits, off_i)


def test_live_tests_read_secret_files_and_spawn_nothing():
    """정적: live 두 파일은 토큰을 `_secret`(env 또는 *_FILE)로 읽고, sandbox 에서 막히는 subprocess 를 쓰지 않는다."""
    for name in ("test_live_e2e.py", "test_live_standalone.py"):
        with open(os.path.join(P_DIR, "tests", name), encoding="utf-8") as fh:
            text = fh.read()
        assert 'BOT_TOKEN = _secret("OHMYSLACK_BOT_TOKEN")' in text, name
        assert "create_subprocess" not in text and "import subprocess" not in text, name
