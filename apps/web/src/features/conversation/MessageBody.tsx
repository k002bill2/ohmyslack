import { Fragment, useMemo } from 'react';
import { parseBody, type Block, type Line } from './render.js';

/** CMP-08 MessageBody — React text node로만 렌더한다(HTML 미실행). 스타일은 정적 CSS 클래스(CSP style-src 'self'). */
function LineView({ line }: { readonly line: Line }) {
  return (
    <>
      {line.map((part, i) =>
        part.kind === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { readonly block: Block }) {
  if (block.kind === 'code') {
    return (
      <pre className="msg-code">
        <code>{block.text}</code>
      </pre>
    );
  }
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
export function MessageBody({ body }: { readonly body: string }) {
  const blocks = useMemo(() => parseBody(body), [body]);
  return (
    <div className="msg-body">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
