"""ohmyslack 플랫폼 플러그인 진입점 — 공개 플러그인 API(`ctx.register_platform`)만 사용한다."""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, Optional, Tuple

from gateway.platforms._shared import env_is_connected, seed_extra_from_env

from .adapter import (PLATFORM_NAME, PORT_ENV, TOKEN_ENV, URL_ENV, OhmySlackAdapter, standalone_send)

HOME_CHANNEL_ENV = "OHMYSLACK_HOME_CHANNEL"
ALLOWED_USERS_ENV = "OHMYSLACK_ALLOWED_USERS"
PLATFORM_HINT = (
    "You are on ohmyslack, the owner's private messenger (Jarvis DM, plus channels the owner added you to). "
    "Messages are plain text with markdown code fences; each top-level message starts a new thread and you "
    "reply inside it. In channels you only see the owner's messages that mention you, and you always reply "
    "in the thread. "
    "Attachments: images the owner attaches arrive as image files, and documents the owner attaches "
    "(PDF, Word/Excel/PowerPoint, HWP/HWPX, TXT/MD/CSV; max 25 MiB each) arrive as files whose saved "
    "path is given to you. Video and other audio attachments are not supported. You can still only send "
    "MP3 audio (send_voice) and PNG/JPEG/WebP images (max 10 MiB each); other file types you send "
    "(documents, video, other audio formats) are replaced by a short text notice."
)


def check_requirements() -> bool:
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config: Any) -> bool:
    from gateway.platforms._shared import get_scoped_secret
    return bool((getattr(config, "token", None) or get_scoped_secret(TOKEN_ENV, "") or "").strip())


# send_message 대상 `ohmyslack:<conversation UUID>`(하이픈 8-4-4-4-12, 대소문자 무시, 앞뒤 공백 허용).
_SEND_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def parse_send_target(ref: str) -> Optional[Tuple[str, None]]:
    """Hermes `target_ref_syntax_fn` 계약 `(ref) -> (chat_id, thread_id) | None`(inputs/probe49b.txt:6-8).

    대화 UUID와 완전 일치하면 `(소문자 표준형, None)`, 아니면 None(Hermes 일반 규칙·채널 디렉터리로 넘어감 — Buzz 선례,
    inputs/probe49b.txt:58-68). Hermes 모듈은 import하지 않는다(정규식·`uuid`만 — 구 Hermes에서도 import가 깨지지 않게).
    """
    # 정규화 이유: standalone sender는 `/me` 대화 id(소문자 표준형)와 정확히 일치해야 보낸다(adapter.py:1189-1193).
    # `<uuid>:<thread uuid>`는 받지 않는다: standalone은 thread_id를 쓰지 않아 스레드 대상이 조용히 최상위로 게시될 수 있다.
    if not isinstance(ref, str):
        return None
    match = _SEND_UUID_RE.fullmatch(ref.strip())
    return (str(uuid.UUID(match.group(0))), None) if match else None


def _env_enablement() -> dict:
    return seed_extra_from_env([(URL_ENV, "url", None), (PORT_ENV, "port", None)], home_env=HOME_CHANNEL_ENV)


def platform_kwargs() -> Dict[str, Any]:
    return dict(
        name=PLATFORM_NAME,
        label="ohmyslack",
        adapter_factory=OhmySlackAdapter,
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=env_is_connected(TOKEN_ENV),
        required_env=[TOKEN_ENV],
        install_hint="pip install aiohttp",
        standalone_sender_fn=standalone_send,
        # 0 = Hermes가 standalone 전송을 쪼개지 않는다(단일 호출 계약): 원문 전체·첨부 전체가 sender 1회 호출에 실리고,
        # 길이 통제(4000 code point 청크)·첨부 첫 청크 결속은 어댑터 내부 `OhmySlackAdapter.MAX_MESSAGE_LENGTH`가 한다.
        # Hermes에서 이 등록값을 읽는 곳은 `tools/send_message_tool.py` `_platform_max_length` 하나뿐이다 — 라이브
        # 어댑터 경로는 어댑터의 MAX_MESSAGE_LENGTH로 직접 나누므로 게시 형태가 같다.
        max_message_length=0,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        # `parse_target_ref_fn`은 일부러 등록하지 않는다: 등록하면 cron이 못 푼 대상을 어댑터에 넘기지 않고 오류로 끝낸다
        # (inputs/probe49.txt:110-117). `target_ref_syntax_fn`은 그 조건에 들지 않아 cron 통과 동작이 그대로다.
        target_ref_syntax_fn=parse_send_target,
        allowed_users_env=ALLOWED_USERS_ENV,
        env_enablement_fn=_env_enablement,
        platform_hint=PLATFORM_HINT,
        emoji="💬",
        allow_update_command=False,
    )


def register(ctx) -> None:
    ctx.register_platform(**platform_kwargs())
