/**
 * same-origin JSON HTTP(TRD §3). 쿠키 세션(`credentials: 'same-origin'`), 상태 변경 요청은 `X-CSRF-Token`
 * (`GET /api/me`의 session-bound `csrf_token`, TRD §5). 401은 `onUnauthorized`로 즉시 알린다(S11).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpStatusError extends Error {
  /** `code`: 서버 오류 본문 `{ error: { code } }`(있을 때만). */
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`http ${status}`);
  }
}

/** 오류 응답 본문의 `error.code`. 본문이 없거나 형식이 다르면 undefined. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** 응답 없는 실패(네트워크 오류). */
export class NetworkError extends Error {}

export interface ApiDeps {
  readonly fetch: FetchLike;
  readonly onUnauthorized: () => void;
  /** 성공 응답(2xx) 1회 / 네트워크 오류 1회 알림 — 끊김 판정(UI_STATES C6·C7)에 쓴다. */
  readonly onNetwork?: (ok: boolean) => void;
}

export function createApi(deps: ApiDeps) {
  let csrf: string | null = null;

  /** `raw`: JSON 대신 원시 바이트(첨부 업로드, TRD §3 `POST /api/attachments`) — `Content-Type`은 파일 형식. */
  const request = async <T>(method: string, path: string, body?: unknown, raw?: { readonly bytes: Blob; readonly type: string }): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (raw !== undefined) headers['Content-Type'] = raw.type;
    else if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD' && csrf !== null) headers['X-CSRF-Token'] = csrf;
    let res: Response;
    try {
      res = await deps.fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        ...(raw !== undefined ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      deps.onNetwork?.(false);
      throw new NetworkError('network');
    }
    deps.onNetwork?.(true);
    if (res.status === 401) {
      csrf = null;
      deps.onUnauthorized();
      throw new HttpStatusError(401);
    }
    if (!res.ok) throw new HttpStatusError(res.status, await errorCode(res));
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    /** 원시 바이트 `POST`(첨부 업로드, W-22). 바이트는 그대로 보내고 어디에도 저장하지 않는다(B7). */
    upload: <T>(path: string, bytes: Blob, type: string) => request<T>('POST', path, undefined, { bytes, type }),
    /** `PATCH`(메시지 수정, W-10i). */
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    /** `PUT`(읽음 위치 저장, TRD §3 `PUT /api/read-state`). */
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    /** `DELETE`(메시지 삭제, W-10i). 본문 없이 보낸다. */
    del: <T>(path: string) => request<T>('DELETE', path),
    setCsrf(token: string | null): void {
      csrf = token;
    },
  };
}

export type Api = ReturnType<typeof createApi>;
