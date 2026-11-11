/**
 * 작성기 자리 안내(G-52 비활성 상대 DM). 호출자가 작성기 대신 그린다 — 입력란·전송 버튼 없이 `role="status"`로 알린다.
 * `tabIndex=-1`: 잠금 전환 때 사라진 입력란의 포커스를 받을 수 있게(Tab 순서에는 넣지 않음).
 */
export function ComposerNotice({ text }: { readonly text: string }) {
  return (
    <p className="composer-notice" role="status" tabIndex={-1}>
      {text}
    </p>
  );
}
