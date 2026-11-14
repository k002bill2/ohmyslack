"""(나)-0 사람 전용 outside 점검 — 에이전트 실행 금지. 모듈 최상위 부수효과 0(모든 접근은 함수 안).

기대: 밖 쓰기·열기 4건 모두 PermissionError, 임의 포트 X 연결 거부, Hermes `gateway` import 스모크 성공.
"""

from __future__ import annotations

import importlib
import os
import socket

CANARY_NAME = ".ohmyslack-sbx-canary-"
TMP_CANARY = "/tmp/ohmyslack-sbx-canary-"


def _rand() -> str:
    return os.urandom(4).hex()


def _assert_denied_write(path: str) -> None:
    try:
        with open(path, "w") as fh:
            fh.write("x")
    except PermissionError:
        return
    os.unlink(path)
    raise AssertionError(f"write allowed outside sandbox: {path}")


def _assert_denied_open(path: str) -> None:
    try:
        with open(path, "rb"):
            pass  # 내용을 읽거나 출력하지 않는다.
    except PermissionError:
        return
    raise AssertionError(f"open allowed outside sandbox: {path}")


def test_outside_home_write_denied():
    _assert_denied_write(os.path.join(os.environ["OHMYSLACK_REAL_HOME"], CANARY_NAME + _rand()))


def test_outside_tmp_write_denied():
    _assert_denied_write(TMP_CANARY + _rand())


def test_outside_hermes_config_open_denied():
    _assert_denied_open(os.path.join(os.environ["OHMYSLACK_REAL_HOME"], ".hermes", "config.yaml"))


def test_outside_hermes_git_open_denied():
    _assert_denied_open(os.path.join(os.environ["OHMYSLACK_REAL_HOME"], ".hermes", "hermes-agent", ".git", "HEAD"))


def test_outside_gateway_import_smoke():
    module = importlib.import_module("gateway.platform_registry")
    assert hasattr(module, "platform_registry")


def test_outside_random_port_connect_denied():
    # 운영 8787·8788 대신 래퍼가 고른 임의 포트 X — 같은 목록에서 생성된 거부 줄이 실제로 걸리는지(L2 추론 대상).
    port = int(os.environ["OHMYSLACK_OUTSIDE_PORT"])
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", port))
        server.listen(1)
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            client.settimeout(2)
            try:
                client.connect(("127.0.0.1", port))
            except PermissionError:
                return
            raise AssertionError(f"connect to denied port {port} succeeded")
        finally:
            client.close()
    finally:
        server.close()
