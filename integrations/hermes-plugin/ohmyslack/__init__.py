"""ohmyslack 플랫폼 플러그인 진입점 — 공개 플러그인 API(`ctx.register_platform`)만 사용한다."""

from __future__ import annotations

from typing import Any, Dict

from gateway.platforms._shared import env_is_connected, seed_extra_from_env

from .adapter import (PLATFORM_NAME, PORT_ENV, TOKEN_ENV, URL_ENV, OhmySlackAdapter, standalone_send)

HOME_CHANNEL_ENV = "OHMYSLACK_HOME_CHANNEL"
ALLOWED_USERS_ENV = "OHMYSLACK_ALLOWED_USERS"
PLATFORM_HINT = (
    "You are on ohmyslack, the owner's private messenger (Jarvis DM). Messages are plain text with "
    "markdown code fences; each top-level message starts a new thread and you reply inside it. "
    "Attachments: you can send MP3 audio (send_voice) and PNG/JPEG/WebP images (max 10 MiB each); "
    "images the owner attaches arrive as image files. Other file types (documents, video, other audio "
    "formats) are not supported — they are replaced by a short text notice."
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
        max_message_length=OhmySlackAdapter.MAX_MESSAGE_LENGTH,
        cron_deliver_env_var=HOME_CHANNEL_ENV,
        allowed_users_env=ALLOWED_USERS_ENV,
        env_enablement_fn=_env_enablement,
        platform_hint=PLATFORM_HINT,
        emoji="💬",
        allow_update_command=False,
    )


def register(ctx) -> None:
    ctx.register_platform(**platform_kwargs())
