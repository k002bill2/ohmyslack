import { Fragment, useEffect, useMemo, useState } from 'react';
import { CODE_BLOCK_COPY, MESSAGE_MENU_COPY } from '../../ui/copy.js';
import { COPY_NOTE_MS, writeClipboard } from './clipboard.js';
import { CodeCopyIcon } from './code-copy-icons.js';
import { parseBody, type Block, type Inline, type Line } from './render.js';
import './message-format.css';

/**
 * CMP-08 MessageBody — React 요소·텍스트 노드로만 렌더한다(HTML 미실행, dangerouslySetInnerHTML 0).
 * 스타일은 정적 CSS 클래스(CSP style-src 'self'). 제한된 서식은 FR-MSG-10(ADR-001 §3-f).
 */
function InlineView({ part }: { readonly part: Inline }) {
  if (part.kind === 'link') {
    return (
      <a href={part.href} target="_blank" rel="noopener noreferrer">
        {part.children === undefined ? part.text : <LineView line={part.children} />}
      </a>
    );
  }
  if (part.kind === 'mention') return <span className="msg-mention">{part.text}</span>;
  if (part.kind === 'code') return <code className="msg-inline-code">{part.text}</code>;
  if (part.kind === 'strong') {
    return (
      <strong>
        <LineView line={part.children} />
      </strong>
    );
  }
  return <>{part.text}</>;
}

function LineView({ line }: { readonly line: Line }) {
  return (
    <>
      {line.map((part, i) => (
        <InlineView key={i} part={part} />
      ))}
    </>
  );
}

/**
 * 제목은 문서 heading 태그를 쓰지 않는다(UI_STATES §2-5: 제목 태그 남용 금지). 메시지는 화면 제목(h1~h3) 아래에
 * 놓이므로 보조기술 수준은 3+n(4~6)으로 두어 대화 문서 구조를 깨지 않고, 시각 강조는 `<strong class="msg-h">`.
 */
function HeadingView({ block }: { readonly block: Extract<Block, { kind: 'heading' }> }) {
  return (
    <p className="msg-heading" role="heading" aria-level={3 + block.level}>
      <strong className={`msg-h msg-h${block.level}`}>
        <LineView line={block.line} />
      </strong>
    </p>
  );
}

function ListView({ block }: { readonly block: Extract<Block, { kind: 'list' }> }) {
  const items = block.items.map((line, i) => (
    <li key={i}>
      <LineView line={line} />
    </li>
  ));
  if (!block.ordered) return <ul className="msg-list">{items}</ul>;
  return (
    <ol className="msg-list" start={block.start === 1 ? undefined : block.start}>
      {items}
    </ol>
  );
}

/**
 * 코드 블록 + 「복사」 버튼. 버튼은 pre 밖·래퍼 안 — pre가 가로 스크롤되어도 오른쪽 위에 고정되고,
 * pre textContent에 버튼 글자가 섞이지 않는다. 원문(`text`)은 가공 없이 복사한다.
 * 버튼은 아이콘 단독(copy → 성공 check / 실패 x)이고 접근 이름·툴팁은 상태와 무관하게 「코드 복사」.
 * 결과 낭독은 늘 렌더되는 role=status(보조기술 전용)가 글자만 바꿔 맡는다(포커스 이동 없음).
 * `tick`은 클릭 결과마다 늘어 연속 성공에도 1600ms를 다시 센다.
 */
type CopyNote = 'copied' | 'failed' | null;
const BUTTON_ICON = { copied: 'check', failed: 'x' } as const;
const STATUS_TEXT = { copied: CODE_BLOCK_COPY.copied, failed: MESSAGE_MENU_COPY.copyFailed } as const;

function CodeBlockView({ text }: { readonly text: string }) {
  const [state, setState] = useState<{ readonly note: CopyNote; readonly tick: number }>({ note: null, tick: 0 });
  const { note, tick } = state;
  useEffect(() => {
    if (note === null) return;
    const t = setTimeout(() => setState((s) => ({ note: null, tick: s.tick })), COPY_NOTE_MS);
    return () => clearTimeout(t);
  }, [note, tick]);
  const copy = () => {
    void writeClipboard(text).then((ok) => setState((s) => ({ note: ok ? 'copied' : 'failed', tick: s.tick + 1 })));
  };
  return (
    <div className="msg-code-block">
      <pre className="msg-code">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="msg-code-copy"
        aria-label={CODE_BLOCK_COPY.label}
        title={CODE_BLOCK_COPY.label}
        data-state={note ?? 'idle'}
        onClick={copy}
      >
        <CodeCopyIcon name={note === null ? 'copy' : BUTTON_ICON[note]} />
      </button>
      <span className="msg-code-note" role="status">
        {note === null ? '' : STATUS_TEXT[note]}
      </span>
    </div>
  );
}

function BlockView({ block }: { readonly block: Block }) {
  if (block.kind === 'code') return <CodeBlockView text={block.text} />;
  if (block.kind === 'heading') return <HeadingView block={block} />;
  if (block.kind === 'list') return <ListView block={block} />;
  return (
    <p className="msg-paragraph">
      {block.lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          <LineView line={line} />
        </Fragment>
      ))}
    </p>
  );
}

/** 본문이 같으면 다시 파싱하지 않는다(F-1: store 이벤트마다 보이는 모든 메시지를 재파싱하지 않게). */
export function MessageBody({ body, mentionNames }: { readonly body: string; readonly mentionNames?: readonly string[] }) {
  const blocks = useMemo(() => parseBody(body, mentionNames), [body, mentionNames]);
  return (
    <div className="msg-body">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
