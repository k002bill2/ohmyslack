"""live-e2e 보조: owner 세션으로 DM에 메시지 1건 게시(사람 리스너 `POST /api/conversations/:id/messages`).

입력은 env만 쓴다(argv·로그에 비밀 금지): OHMYSLACK_LIVE_MAIN_URL, OHMYSLACK_LIVE_ORIGIN, OHMYSLACK_LIVE_COOKIE
(`__Host-oms_session=…` 쌍), OHMYSLACK_LIVE_CSRF, OHMYSLACK_LIVE_DM_ID, OHMYSLACK_LIVE_BODY. 실패 시 상태 코드만 출력.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
import uuid


def main() -> int:
    env = os.environ
    url = f"{env['OHMYSLACK_LIVE_MAIN_URL']}/api/conversations/{env['OHMYSLACK_LIVE_DM_ID']}/messages"
    data = json.dumps({"client_message_id": str(uuid.uuid4()), "body": env["OHMYSLACK_LIVE_BODY"]}).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "content-type": "application/json",
        "origin": env["OHMYSLACK_LIVE_ORIGIN"],
        "cookie": env["OHMYSLACK_LIVE_COOKIE"],
        "x-csrf-token": env["OHMYSLACK_LIVE_CSRF"],
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 0 if resp.status in (200, 201) else 1
    except urllib.error.HTTPError as exc:
        print(f"owner send failed: HTTP {exc.code}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
