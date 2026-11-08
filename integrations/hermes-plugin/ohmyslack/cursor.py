"""따라잡기 커서 파일 (ADR-001 §3-e: 마지막 처리 전역 `change_id`를 숫자로 저장).

본문·토큰은 저장하지 않는다. 저장 항목: `change_id`(REST catch-up 완료 watermark), `saved_at`
(epoch 초), `recent_ids`(최근 처리한 message id — 재시작 후 중복 실행 방지용 식별자).
쓰기는 같은 디렉터리의 임시 파일 → `os.replace`로 원자적이다.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

RECENT_IDS_MAX = 500


@dataclass(frozen=True)
class CursorState:
    change_id: int
    saved_at: float
    recent_ids: tuple[str, ...] = field(default_factory=tuple)


class CursorStore:
    def __init__(self, path: Path):
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> Optional[CursorState]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            change_id = int(raw["change_id"])
        except (FileNotFoundError, ValueError, KeyError, TypeError):
            return None
        if change_id < 0:
            return None
        ids = tuple(str(x) for x in raw.get("recent_ids", []) if isinstance(x, str))[-RECENT_IDS_MAX:]
        return CursorState(change_id=change_id, saved_at=float(raw.get("saved_at", 0.0)), recent_ids=ids)

    def save(self, state: CursorState) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "change_id": int(state.change_id),
            "saved_at": float(state.saved_at),
            "recent_ids": list(state.recent_ids[-RECENT_IDS_MAX:]),
        }
        fd, tmp = tempfile.mkstemp(prefix=".cursor-", dir=str(self._path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
