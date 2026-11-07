import { useId, useState, type FormEvent } from 'react';
import type { ActionFailure, ActionResult } from '../../data';
import { CHANNEL_NAME_TAKEN_TEXT, DIALOG_TITLES } from '../../ui/copy.js';
import { ErrorState } from '../../ui/ErrorState.js';
import { failureText } from './failure.js';

export interface CreateChannelFormProps {
  /** 입력란 접근 이름으로 쓸 제목 요소 ID(Dialog `titleId`). 채널 이름 라벨 문구는 정본에 없다(REPORT Q). */
  readonly labelledBy: string;
  readonly create: (name: string) => Promise<ActionResult<string>>;
  readonly onCreated: (conversationId: string) => void;
}

/**
 * 채널 만들기(owner, CMP-18 용도 1, D §10-1 SCR-06). 이름 → `POST /api/conversations` → 성공 시 `onCreated(id)`.
 * 409 → G-25 문장 + 입력란 `aria-invalid`(버튼 없음), 403·기타 → ErrorState(서버 403이 최종 진실).
 */
export function CreateChannelForm({ labelledBy, create, onCreated }: CreateChannelFormProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const errorId = useId();
  const taken = failure !== null && failure.status === 409;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const res = await create(name.trim());
    setBusy(false);
    if (res.ok) onCreated(res.value);
    else setFailure(res);
  };

  return (
    <form className="create-channel" onSubmit={(e) => void submit(e)}>
      <input
        type="text"
        value={name}
        aria-labelledby={labelledBy}
        aria-invalid={taken ? 'true' : undefined}
        aria-describedby={taken ? errorId : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      {taken && (
        <p id={errorId} className="field-error">
          {CHANNEL_NAME_TAKEN_TEXT}
        </p>
      )}
      {failure !== null && !taken && <ErrorState message={failureText(failure)} />}
      <button type="submit" disabled={busy || name.trim().length === 0}>
        {DIALOG_TITLES.createChannel}
      </button>
    </form>
  );
}
