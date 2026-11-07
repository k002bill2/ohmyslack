/** CMP-12 작성기 연결: 열림·필터·결과 없음·키보드(§7-4 순위 3)·IME 보호·선택 → mention_user_ids. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/features/conversation';
import { MENTION_EMPTY_TEXT } from '../../src/ui/copy.js';

afterEach(cleanup);

const CANDS = [
  { id: 'me', displayName: '나' },
  { id: 'u-bob', displayName: 'Bob' },
  { id: 'u-bora', displayName: '보라' },
];

function mount() {
  const onSend = vi.fn();
  render(<Composer label="작성" onSend={onSend} mentions={{ candidates: CANDS, selfId: 'me' }} />);
  const box = screen.getByLabelText('작성') as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box, { target: { value } });
  const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(box, { key: k, ...extra });
  return { onSend, box, type, key };
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('MentionPicker in Composer', () => {
  it('닫힘 기본: textbox, 후보 없음', () => {
    const { box } = mount();
    expect(box.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('@ 입력 → combobox aria-expanded=true + listbox, 자기 자신 제외', () => {
    const { box, type } = mount();
    type('@');
    expect(box.getAttribute('role')).toBe('combobox');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(options()).toEqual(['Bob', '보라']);
  });

  it('필터 · 결과 없음 문구', () => {
    const { type } = mount();
    type('@bo');
    expect(options()).toEqual(['Bob']);
    type('@zz');
    expect(options()).toEqual([]);
    expect(screen.getByText(MENTION_EMPTY_TEXT)).toBeTruthy();
  });

  it('↓ 이동 후 Enter 선택(전송 아님) → 본문 삽입, 전송 시 ID 포함', () => {
    const { box, type, key, onSend } = mount();
    type('hi @');
    key('ArrowDown');
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    key('ArrowDown');
    key('Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('hi @보라 ');
    expect(screen.queryByRole('listbox')).toBeNull();
    key('Enter');
    expect(onSend).toHaveBeenCalledWith('hi @보라 ', ['u-bora']);
    expect(box.value).toBe('');
  });

  it('Tab 선택, 멘션을 지우면 ID를 보내지 않는다', () => {
    const { box, type, key, onSend } = mount();
    type('@B');
    key('Tab');
    expect(box.value).toBe('@Bob ');
    type('plain');
    key('Enter');
    expect(onSend).toHaveBeenCalledWith('plain');
  });

  it('Esc → 후보만 닫고 작성기 유지', () => {
    const { box, type, key, onSend } = mount();
    type('@b');
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.value).toBe('@b');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('IME 조합 중에는 @로 열지 않고, 열린 후보에서도 조합 Enter는 선택하지 않는다', () => {
    const { box, type, key, onSend } = mount();
    fireEvent.compositionStart(box);
    type('@');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.compositionEnd(box);
    type('');
    type('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.compositionStart(box);
    type('@보');
    expect(options()).toEqual(['보라']);
    key('Enter', { isComposing: true, keyCode: 229 } as Partial<KeyboardEventInit>);
    expect(box.value).toBe('@보');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});
