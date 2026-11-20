import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface SplitterProps {
  readonly label: string;
  /** 현재 폭(px) — aria-valuenow. */
  readonly now: number;
  readonly min: number;
  readonly max: number;
  /** 오른쪽으로 끌 때 폭이 늘면 1(내비), 줄면 -1(스레드). */
  readonly dir: 1 | -1;
  /** 끌기 시작 시점 폭(실측). */
  readonly measure: () => number;
  readonly onResize: (width: number) => void;
  /** ←→ 한 칸(부호는 화면 방향: ← = -1). */
  readonly onStep: (screenDirection: -1 | 1) => void;
  /** Home = 최소(-1), End = 최대(1) — APG Window Splitter. */
  readonly onEdge: (edge: -1 | 1) => void;
  readonly onEnter: () => void;
  readonly onReset: () => void;
}

/**
 * R4 분할선(시안 Main): `role="separator"` + 포커스 가능(APG Window Splitter). 포인터 캡처로 끌고,
 * ←→로 한 칸, Home/End로 최소/최대, Enter로 접기/닫기, 더블클릭으로 기본 폭. 손잡이는 hover·포커스·끌기 중에 길어지고 accent가 된다(CSS).
 */
export function Splitter({ label, now, min, max, dir, measure, onResize, onStep, onEdge, onEnter, onReset }: SplitterProps) {
  const drag = useRef<{ readonly x: number; readonly base: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 캡처를 못 해도(합성 이벤트) 끌기는 같은 요소 위에서 계속된다.
    }
    drag.current = { x: e.clientX, base: measure() };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d !== null) onResize(d.base + dir * (e.clientX - d.x));
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onStep(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      onEdge(e.key === 'Home' ? -1 : 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(now)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className="splitter"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="splitter-handle" aria-hidden="true" />
    </div>
  );
}
