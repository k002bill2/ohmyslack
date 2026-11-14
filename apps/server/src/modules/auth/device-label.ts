import { SESSION_DEVICE_LABEL_MAX } from '../../shared.js';

/**
 * 기기 세션 거친 라벨(TRD §5-3 1·2항, TM-HTTP-22). 요청 User-Agent에서 고정 표의 값만 골라
 * 「{기기 종류} · {브라우저}」를 만든다. 원문 UA·버전·OS 버전은 결과에 담지 않고 어디에도 남기지 않는다.
 * 각 축은 위에서부터 첫 일치, 둘 중 하나라도 못 정하면 라벨 전체가 null(부분 라벨 없음).
 */
const DEVICE_RULES: readonly (readonly [readonly string[], string])[] = Object.freeze([
  [['iPhone'], 'iPhone'],
  [['iPad'], 'iPad'],
  [['Android'], 'Android'],
  [['Macintosh'], 'Mac'],
  [['Windows'], 'Windows'],
  [['Linux'], 'Linux'],
]);

const BROWSER_RULES: readonly (readonly [readonly string[], string])[] = Object.freeze([
  [['Edg/'], 'Edge'],
  [['Firefox/', 'FxiOS/'], 'Firefox'],
  [['Chrome/', 'CriOS/'], 'Chrome'],
  [['Safari/'], 'Safari'],
]);

function firstMatch(userAgent: string, rules: readonly (readonly [readonly string[], string])[]): string | undefined {
  return rules.find(([needles]) => needles.some((needle) => userAgent.includes(needle)))?.[1];
}

export function deviceLabelFor(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent === '') return null;
  const device = firstMatch(userAgent, DEVICE_RULES);
  const browser = firstMatch(userAgent, BROWSER_RULES);
  if (device === undefined || browser === undefined) return null;
  const label = `${device} · ${browser}`;
  const length = [...label].length;
  return length >= 1 && length <= SESSION_DEVICE_LABEL_MAX ? label : null;
}
