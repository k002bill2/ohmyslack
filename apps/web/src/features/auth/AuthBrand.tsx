/** 앱 심볼 경로 — 현행 아이콘 자산(public/icons/favicon.svg) 재사용, 새 SVG 없음(시안 03). */
export const AUTH_SYMBOL_SRC = '/icons/favicon.svg';

/**
 * 로그인 전 카드 머리(시안 03): 앱 심볼 + 제목 + 보조 문구, 가운데 정렬.
 * 심볼은 장식이라 대체 텍스트를 비운다 — 접근 이름은 제목(h1)이 맡는다.
 */
export function AuthBrand({ title, intro }: { readonly title?: string; readonly intro?: string }) {
  return (
    <div className="auth-brand">
      <img className="auth-symbol" src={AUTH_SYMBOL_SRC} alt="" width={56} height={56} />
      {title !== undefined && <h1>{title}</h1>}
      {intro !== undefined && <p>{intro}</p>}
    </div>
  );
}
