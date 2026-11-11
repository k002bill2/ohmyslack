/** 작성기 자리 안내(G-52 비활성 상대 DM). 호출자가 작성기 대신 그린다 — 입력란·전송 버튼 없이 `role="status"`로 알린다. */
export function ComposerNotice({ text }: { readonly text: string }) {
  return (
    <p className="composer-notice" role="status">
      {text}
    </p>
  );
}
