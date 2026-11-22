/** 클립보드 쓰기(없거나 거부되면 false). 메시지 메뉴 복사·코드 블록 복사가 함께 쓴다. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 복사 결과 안내를 잠깐 보였다가 지운다(role=status, 포커스 이동 없음 — D §7-1 4.1.3). */
export const COPY_NOTE_MS = 1600;
