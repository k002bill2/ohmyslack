/**
 * 로그 누출 카나리아(정본: DEV_DESIGN §2-2 B6, 6-2 FR-OPS-03). 합성 표식이며 실제 비밀이 아니다.
 * 통합 테스트는 이 값을 본문·자격 증명·토큰 자리에 넣고, check:log-leak이 int 로그에서 0건을 확인한다.
 */
export const LOG_CANARIES: Readonly<Record<string, string>> = Object.freeze({
  body: 'OMS-CANARY-BODY-6f1c2a',
  credential: 'OMS-CANARY-CRED-93d7e0',
  token: 'OMS-CANARY-TOKEN-4b8e51',
  cookie: 'OMS-CANARY-COOKIE-c20f9d',
  invite: 'OMS-CANARY-INVITE-7a3e16',
  email: 'oms-canary-email-5d02bb@example.invalid',
  /** 봇 토큰 자리(TRD §5-2 2항 `omsb_` 접두사). 실제 토큰 형식(32바이트 base64url)이 아닌 합성 표식이다. */
  bot: 'omsb_OMS-CANARY-BOT-e81d4c',
  /**
   * push endpoint 경로 자리(TRD §6-2, DEV_DESIGN FR-OPS-03 R3.3). 통합 테스트의 구독 endpoint는
   * `https://web.push.apple.com/<이 값>…` 형태로 쓰고, 로그에는 호스트만 남아야 하므로 이 값은 0건이어야 한다.
   */
  push_endpoint: 'OMS-CANARY-PUSHEP-2a9c71',
  /**
   * 첨부 파일명 자리(TRD §6-1-1 (5)·(2), DEV_DESIGN W-26). 통합 테스트는 `X-Attachment-Filename`에 이 값을 넣어 문서를 올리고
   * 내려받으며, 파일명은 응답 헤더·본문에만 있고 로그·계측·push에는 0건이어야 한다.
   */
  filename: 'OMS-CANARY-FILENAME-3e7b90',
});
