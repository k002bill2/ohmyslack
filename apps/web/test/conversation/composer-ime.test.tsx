import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer, type ComposerProps } from '../../src/features/conversation/index.js';
import { JUST_COMPOSED_WINDOW_MS, MESSAGE_BODY_MAX_CODE_POINTS, decideKey } from '../../src/features/conversation/ime.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(props: Partial<ComposerProps> = {}) {
  const onSend = vi.fn<(body: string) => void>();
  render(<Composer onSend={onSend} {...props} />);
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  return { onSend, box };
}

function type(box: HTMLTextAreaElement, value: string): void {
  fireEvent.change(box, { target: { value } });
}

/** keydown이 기본 동작을 막지 않았으면 true(textarea 기본 동작 = 줄바꿈 등이 일어남). */
function keyDown(box: HTMLTextAreaElement, init: KeyboardEventInit & { keyCode?: number }): boolean {
  return fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', ...init });
}

/** 한글 조합: compositionstart → 조합 중 값 → compositionend(확정). */
function compose(box: HTMLTextAreaElement, value: string): void {
  fireEvent.compositionStart(box);
  type(box, value);
  fireEvent.compositionEnd(box, { data: value });
}

describe('FR-MSG-08 세부 사례(DEV_DESIGN 6-4 1–6)', () => {
  it('사례 1: keydown Enter + isComposing=true → 전송 0, 입력 보존', () => {
    const { onSend, box } = setup();
    type(box, '안녕');
    const notPrevented = keyDown(box, { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
    expect(box.value).toBe('안녕');
  });

  it('사례 2: keydown Enter + keyCode=229 → 전송 0 (key=Process도 동일)', () => {
    const { onSend, box } = setup();
    type(box, '안녕');
    keyDown(box, { keyCode: 229 });
    keyDown(box, { key: 'Process' });
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('안녕');
  });

  it('사례 3: compositionend 직후 같은 틱의 Enter(isComposing=false) → 전송 0, 그 다음 독립 Enter → 전송 1', () => {
    const { onSend, box } = setup();
    compose(box, '안녕하세요');
    const notPrevented = keyDown(box, { isComposing: false });
    expect(notPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('안녕하세요');
    fireEvent.keyUp(box, { key: 'Enter' });
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('안녕하세요');
    expect(box.value).toBe('');
  });

  it('사례 3-b: Chrome 순서(조합 중 Enter → compositionend → keyup) 후 독립 Enter → 전송 1', () => {
    const { onSend, box } = setup();
    fireEvent.compositionStart(box);
    type(box, '한글');
    keyDown(box, { isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(box, { data: '한글' });
    fireEvent.keyUp(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('사례 4: 조합 확정 후 시간이 지난 독립 Enter는 버리지 않음 → 전송 1', () => {
    const { onSend, box } = setup();
    compose(box, '확정');
    act(() => {
      vi.advanceTimersByTime(JUST_COMPOSED_WINDOW_MS);
    });
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('확정');
  });

  it('사례 5-a: 조합 중 Shift+Enter는 IME에 맡긴다(앱 처리 0, 입력 훼손 0)', () => {
    const { onSend, box } = setup();
    fireEvent.compositionStart(box);
    type(box, '가나');
    const notPrevented = keyDown(box, { shiftKey: true, isComposing: true });
    expect(notPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('가나');
  });

  it('사례 5-b: 조합 중이 아닐 때 Shift+Enter는 줄바꿈(전송 0, 기본 동작 유지)', () => {
    const { onSend, box } = setup();
    type(box, '첫 줄');
    const notPrevented = keyDown(box, { shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('사례 5-c: 마우스로 조합 확정(keyup 없음) 후 100ms 뒤 Enter → 전송 1', () => {
    const { onSend, box } = setup();
    compose(box, '마우스');
    keyDown(box, {});
    expect(onSend).not.toHaveBeenCalled();
    compose(box, '마우스확정');
    act(() => {
      vi.advanceTimersByTime(JUST_COMPOSED_WINDOW_MS);
    });
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('마우스확정');
  });

  it('사례 5-d: 연속 입력 — 여러 번 조합해도 입력이 훼손되지 않고 Enter 1회에 1회 전송', () => {
    const { onSend, box } = setup();
    compose(box, '가');
    fireEvent.keyUp(box, { key: 'ㅏ' });
    compose(box, '가나');
    fireEvent.keyUp(box, { key: 'ㅏ' });
    compose(box, '가나다');
    fireEvent.keyUp(box, { key: 'ㅏ' });
    expect(box.value).toBe('가나다');
    keyDown(box, {});
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('가나다');
  });

  it('사례 5-e: 전송 응답 대기 중 새 조합을 시작해도 작성기는 이미 비워졌고 새 입력이 보존된다', () => {
    const { onSend, box } = setup();
    type(box, '첫 메시지');
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('');
    fireEvent.compositionStart(box);
    type(box, '두');
    expect(box.value).toBe('두');
  });

  it('사례 5-f: 조합 중 전송 버튼 클릭 → 전송 1, 비우기는 compositionend 이후로 미룸', () => {
    const { onSend, box } = setup();
    fireEvent.compositionStart(box);
    type(box, '버튼');
    fireEvent.click(screen.getByRole('button', { name: '전송' }));
    expect(onSend).toHaveBeenCalledWith('버튼');
    expect(box.value).toBe('버튼');
    fireEvent.compositionEnd(box, { data: '버튼' });
    expect(box.value).toBe('');
  });

  it('사례 6: 멘션 후보가 열린 상태의 Enter는 후보 선택이고 전송하지 않는다', () => {
    const onMentionKey = vi.fn();
    const { onSend, box } = setup({ mentionOpen: true, onMentionKey });
    type(box, '@홍');
    keyDown(box, {});
    fireEvent.keyDown(box, { key: 'Tab' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onSend).not.toHaveBeenCalled();
    expect(onMentionKey.mock.calls.map((c) => c[0])).toEqual(['Enter', 'Tab', 'Escape']);
    expect(box.value).toBe('@홍');
  });

  it('사례 6-b: 멘션 후보가 열려 있어도 조합 중 Enter는 IME가 먼저(순위 1)', () => {
    const onMentionKey = vi.fn();
    const { onSend, box } = setup({ mentionOpen: true, onMentionKey });
    keyDown(box, { isComposing: true });
    expect(onMentionKey).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('빈 본문·공백만·상한 초과는 전송하지 않고 상한 초과 안내를 표시한다', () => {
    const { onSend, box } = setup();
    keyDown(box, {});
    type(box, '   \n ');
    keyDown(box, {});
    expect(screen.getByRole('button', { name: '전송' })).toHaveProperty('disabled', true);
    type(box, '가'.repeat(MESSAGE_BODY_MAX_CODE_POINTS + 1));
    keyDown(box, {});
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('4,000자까지 입력할 수 있습니다')).toBeTruthy();
    type(box, '😀'.repeat(MESSAGE_BODY_MAX_CODE_POINTS));
    expect(screen.queryByText('4,000자까지 입력할 수 있습니다')).toBeNull();
    keyDown(box, {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('우선순위 표: 그 외 키는 기본 편집', () => {
    const base = { key: 'a', keyCode: 65, isComposing: false, shiftKey: false };
    expect(decideKey(base, { composing: false, justComposed: false, mentionOpen: false })).toBe('default');
    expect(decideKey(base, { composing: false, justComposed: false, mentionOpen: true })).toBe('default');
  });
});

it('FR-MSG-08 조합 중 Enter와 조합 확정 Enter는 전송하지 않고 확정 후 독립 Enter는 1회 전송하며 조합 중 입력이 훼손되지 않는다', async () => {
  const onMentionKey = vi.fn();
  const { onSend, box } = setup();
  // 사례 1·2: 조합 중 Enter(isComposing·keyCode 229·Process) → 전송 0, 입력 보존
  type(box, '안녕');
  keyDown(box, { isComposing: true });
  keyDown(box, { keyCode: 229 });
  keyDown(box, { key: 'Process' });
  expect(onSend).not.toHaveBeenCalled();
  expect(box.value).toBe('안녕');
  // 사례 3: compositionend 직후 같은 틱 Enter(isComposing=false) → 0, 다음 독립 Enter → 1
  compose(box, '안녕하세요');
  keyDown(box, { isComposing: false });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyUp(box, { key: 'Enter' });
  keyDown(box, {});
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenLastCalledWith('안녕하세요');
  // 사례 4: 확정 후 시간이 지난 독립 Enter → 1
  compose(box, '확정');
  act(() => {
    vi.advanceTimersByTime(JUST_COMPOSED_WINDOW_MS);
  });
  keyDown(box, {});
  expect(onSend).toHaveBeenCalledTimes(2);
  // 사례 5: 조합 중 Shift+Enter는 IME에 맡김(입력 훼손 0), 전송 대기 중 새 조합 보존
  fireEvent.compositionStart(box);
  type(box, '가나');
  expect(keyDown(box, { shiftKey: true, isComposing: true })).toBe(true);
  expect(box.value).toBe('가나');
  expect(onSend).toHaveBeenCalledTimes(2);
  cleanup();
  // 사례 6: 멘션 후보 열림 Enter = 선택, 전송 0
  const mention = setup({ mentionOpen: true, onMentionKey });
  type(mention.box, '@홍');
  keyDown(mention.box, {});
  expect(onMentionKey).toHaveBeenCalledWith('Enter');
  expect(mention.onSend).not.toHaveBeenCalled();
});
