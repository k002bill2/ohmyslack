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

/**
 * 요청 시간 상한 초과(action-timeout). 응답을 받지 못했다는 점에서 네트워크 오류의 한 종류라 기존 처리
 * (끊김 판정·복귀 재시도·읽음 백오프)를 그대로 따른다. 서버 쪽 동작은 이미 일어났을 수 있다 —
 * 화면 문구는 「확인하지 못했습니다」(`ERROR_COPY.timeout`)이고 자동 재전송은 하지 않는다.
 */
export class TimeoutError extends NetworkError {}

/**
 * 요청 1건의 시간 상한. fetch 표준에는 기본 타임아웃이 없어 서버가 응답하지 않으면 요청이 끝나지 않는다.
 * 지연이 큰 모바일 망에서도 정상 액션·목록 조회는 수 초 안에 끝나고, 20초를 넘으면 사용자는 이미 실패로 본다.
 * 첨부 업로드(원시 바이트)는 파일 크기·망 속도에 비례해 길어질 수 있어 제외한다.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 리버스 프록시(Tailscale Serve)가 서버에 닿지 못했을 때의 게이트웨이 응답. 앱 서버는 이 코드를 내지 않으므로
 * 끊김 판정(UI_STATES C6)에서는 네트워크 오류와 같이 센다(W-16 F-8). 전송 결과 판정(4xx·5xx → 실패)은 그대로다.
 */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** 서버에 닿지 못한 실패: 네트워크 오류 또는 게이트웨이 응답(F-8). */
export function isUnreachable(e: unknown): boolean {
  return e instanceof NetworkError || (e instanceof HttpStatusError && GATEWAY_STATUSES.has(e.status));
}

/** 2xx — `Response.ok`와 같은 기준. */
const isOkStatus = (status: number): boolean => status >= 200 && status <= 299;

/** 원시 바이트 본문(첨부 업로드). `headers`: 추가 헤더(파일명 등), `signal`: 호출자 취소. */
export interface RawBody {
  readonly bytes: Blob;
  readonly type: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** 요청 1건의 전송 문맥. `onStatus`: 헤더(상태) 수신 — 이후 시간 초과는 그 상태로 끝낸다. */
interface SendContext {
  readonly body: unknown;
  readonly raw?: RawBody;
  readonly signal?: AbortSignal;
  readonly isTimedOut: () => boolean;
  readonly notify: (ok: boolean) => void;
  readonly onStatus: (status: number) => void;
}

export interface ApiDeps {
  readonly fetch: FetchLike;
  readonly onUnauthorized: () => void;
  /** 서버 응답 1회(true) / 네트워크 오류·게이트웨이 응답 1회(false) 알림 — 끊김 판정(UI_STATES C6·C7)에 쓴다. */
  readonly onNetwork?: (ok: boolean) => void;
}

export function createApi(deps: ApiDeps) {
  let csrf: string | null = null;

  /** `raw`: JSON 대신 원시 바이트(첨부 업로드, TRD §3 `POST /api/attachments`) — `Content-Type`은 파일 형식. */
  const request = async <T>(method: string, path: string, body?: unknown, raw?: RawBody): Promise<T> => {
    // 네트워크 결과 알림(onNetwork)은 요청당 최대 1회 — 헤더 수신과 시간 초과를 실패 두 건으로 세지 않는다(Codex r1 P2).
    let notified = false;
    const notify = (ok: boolean) => {
      if (notified) return;
      notified = true;
      deps.onNetwork?.(ok);
    };
    if (raw !== undefined) {
      // 원시 업로드는 20초 상한 면제(UI-D4) — 끊기는 호출자 signal(「첨부 제거」)뿐이다.
      const ctx: SendContext = { body, raw, notify, isTimedOut: () => false, onStatus: () => undefined, ...(raw.signal === undefined ? {} : { signal: raw.signal }) };
      return send<T>(method, path, ctx);
    }
    // 상한에 닿으면 fetch를 abort하고 끝낸다. signal을 무시하는 fetch여도 race로 끝난다.
    // 헤더 전이면 TimeoutError, 오류 상태 헤더를 이미 받았으면 그 상태의 HttpStatusError(코드 미상)다(Codex r1 P2).
    const controller = new AbortController();
    let timedOut = false;
    let status: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        notify(false);
        reject(status !== undefined && !isOkStatus(status) ? new HttpStatusError(status) : new TimeoutError('timeout'));
      }, REQUEST_TIMEOUT_MS);
    });
    const ctx: SendContext = { body, notify, signal: controller.signal, isTimedOut: () => timedOut, onStatus: (s) => (status = s) };
    try {
      return await Promise.race([send<T>(method, path, ctx), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** `isTimedOut`: 상한 초과 뒤 늦게 끝난 결과는 알림(onNetwork·onUnauthorized)을 내지 않는다 — 결과는 이미 정해졌다. */
  const send = async <T>(method: string, path: string, ctx: SendContext): Promise<T> => {
    const { body, raw, signal, isTimedOut, notify } = ctx;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (raw !== undefined) {
      headers['Content-Type'] = raw.type;
      Object.assign(headers, raw.headers);
    } else if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD' && csrf !== null) headers['X-CSRF-Token'] = csrf;
    let res: Response;
    try {
      res = await deps.fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        ...(raw !== undefined ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      if (isTimedOut()) throw new TimeoutError('timeout');
      // 호출자가 끊은 업로드(「첨부 제거」)는 연결 실패가 아니다 — 네트워크 알림을 내지 않는다.
      if (raw?.signal?.aborted === true) throw new NetworkError('network');
      notify(false);
      throw new NetworkError('network');
    }
    if (isTimedOut()) throw new TimeoutError('timeout');
    ctx.onStatus(res.status);
    notify(!GATEWAY_STATUSES.has(res.status));
    if (res.status === 401) {
      csrf = null;
      deps.onUnauthorized();
      throw new HttpStatusError(401);
    }
    if (!res.ok) throw new HttpStatusError(res.status, await errorCode(res));
    if (res.status === 204) return undefined as T;
    // 성공 상태 본문을 끝까지 받지 못했으면 결과를 확인하지 못한 것 — 네트워크 오류로 분류한다(Codex r1 P1).
    try {
      return (await res.json()) as T;
    } catch {
      throw isTimedOut() ? new TimeoutError('timeout') : new NetworkError('network');
    }
  };

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    /** 원시 바이트 `POST`(첨부 업로드, W-22). 바이트는 그대로 보내고 어디에도 저장하지 않는다(B7). */
    upload: <T>(path: string, bytes: Blob, type: string, extra: Pick<RawBody, 'headers' | 'signal'> = {}) =>
      request<T>('POST', path, undefined, { bytes, type, ...extra }),
    /** `PATCH`(메시지 수정, W-10i). */
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
    /** `PUT`(읽음 위치 저장, TRD §3 `PUT /api/read-state`). */
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    /** `DELETE`(메시지 삭제, W-10i). 본문 없이 보낸다. */
    del: <T>(path: string) => request<T>('DELETE', path),
    setCsrf(token: string | null): void {
      csrf = token;
    },
    /** 현재 세션 CSRF 토큰(401 뒤 null) — 계측 전송(`data/metrics.ts`)이 같은 토큰을 쓴다. */
    csrfToken: (): string | null => csrf,
  };
}

export type Api = ReturnType<typeof createApi>;
