import { Fragment, useEffect, useMemo, useState } from 'react';
import { CODE_BLOCK_COPY, MESSAGE_MENU_COPY } from '../../ui/copy.js';
import { COPY_NOTE_MS, writeClipboard } from './clipboard.js';
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
 * 결과 안내는 role=status(포커스 이동 없음): 성공은 버튼 글자 「복사됨」(안내는 보조기술 전용), 실패는 보이는 문구.
 */
function CodeBlockView({ text }: { readonly text: string }) {
  const [note, setNote] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (note === null) return;
    const t = setTimeout(() => setNote(null), COPY_NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  const copy = () => {
    void writeClipboard(text).then((ok) => setNote(ok ? 'copied' : 'failed'));
  };
  return (
    <div className="msg-code-block">
      <pre className="msg-code">
        <code>{text}</code>
      </pre>
      <button type="button" className="msg-code-copy" aria-label={CODE_BLOCK_COPY.label} onClick={copy}>
        {note === 'copied' ? CODE_BLOCK_COPY.copied : CODE_BLOCK_COPY.copy}
      </button>
      {note !== null && (
        <span className={note === 'failed' ? 'msg-code-note' : 'msg-code-note msg-code-note-quiet'} role="status">
          {note === 'failed' ? MESSAGE_MENU_COPY.copyFailed : CODE_BLOCK_COPY.copied}
        </span>
      )}
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
