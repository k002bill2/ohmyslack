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
});
