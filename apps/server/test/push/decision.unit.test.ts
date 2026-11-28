import { describe, expect, it } from 'vitest';
import { isDecisionRequest } from '../../src/modules/push/decision.js';
import { MESSAGE_BODY_MAX } from '../../src/shared.js';

/** FR-CLIENT-05(TRD §6-2): 봇 스레드 답글 중 결정 요청(승인·clarify·[결정 필요])만 원문 작성자에게 알린다. */
const APPROVAL = '⚠️ **Hermes wants to run a command that needs your OK**';

describe('isDecisionRequest', () => {
  it('승인 요청 첫 줄(VS16 유무)은 참', () => {
    expect(isDecisionRequest(`${APPROVAL}\n\n\`rm -rf build\`\n/approve`)).toBe(true);
    expect(isDecisionRequest('\u{26A0} **Hermes wants to run a command that needs your OK**\n/approve')).toBe(true);
  });

  it('clarify(❓, VS16 유무)는 참', () => {
    expect(isDecisionRequest('❓ 어느 브랜치에 배포할까요?\nReply "skip" to skip this question.')).toBe(true);
    expect(isDecisionRequest('\u{2753}\u{FE0F} 계속할까요?')).toBe(true);
  });

  it('첫 줄에 [결정 필요] 표식이 있으면 참', () => {
    expect(isDecisionRequest('[결정 필요] 배포 시간 정해 주세요')).toBe(true);
    expect(isDecisionRequest('점검 결과 요약 [결정 필요]\n세부 내용')).toBe(true);
  });

  it('앞 공백·빈 줄은 무시하고 첫 비어 있지 않은 줄로 판정', () => {
    expect(isDecisionRequest('\n\n   \n  ❓ 질문')).toBe(true);
    expect(isDecisionRequest(`\r\n\t ${APPROVAL}`)).toBe(true);
  });

  it('첫 줄이 아닌 곳의 표식은 거짓', () => {
    expect(isDecisionRequest('작업을 마쳤습니다.\n[결정 필요] 다음 단계')).toBe(false);
    expect(isDecisionRequest('결과입니다\n❓ 질문')).toBe(false);
    expect(isDecisionRequest(`완료\n${APPROVAL}`)).toBe(false);
  });

  it('진행 표시·일반 답변·결과 알림은 거짓', () => {
    for (const body of [
      '💻 Running git status',
      '📖 Reading apps/server/src/app.ts',
      '⏳ Working — 9 min — iteration 6/90, clarify',
      '⌛ Approval timed out',
      '✅ Command approved',
      "⚠️ Cron 'morning' failed",
      '네, 확인했습니다. 내일 아침에 다시 정리해 드릴게요.',
    ]) expect(isDecisionRequest(body), body).toBe(false);
  });

  it('null·빈·공백 본문은 거짓', () => {
    expect(isDecisionRequest(null)).toBe(false);
    expect(isDecisionRequest('')).toBe(false);
    expect(isDecisionRequest(' \n\t\n ')).toBe(false);
  });

  it('최대 길이 본문도 선형 시간(1ms 수준)으로 판정한다', () => {
    const worst = [' '.repeat(MESSAGE_BODY_MAX - 1) + 'x', '\n'.repeat(MESSAGE_BODY_MAX), '['.repeat(MESSAGE_BODY_MAX), '[결정 필'.repeat(MESSAGE_BODY_MAX / 5)];
    for (const body of worst) isDecisionRequest(body); // 워밍업
    const start = performance.now();
    for (const body of worst) expect(isDecisionRequest(body)).toBe(false);
    expect((performance.now() - start) / worst.length).toBeLessThan(5);
  });
});
