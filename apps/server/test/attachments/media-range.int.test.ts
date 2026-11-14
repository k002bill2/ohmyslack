import { afterEach, describe, expect, it } from 'vitest';
import { as, createChannel, setupConvInt, teardownConvInt, type ConvIntContext } from '../conversations/conv-int-harness.js';
import { counts, png, upload } from './att-harness.js';

/**
 * SR-D-03(보안 델타 리뷰): 판정기가 헤더에서 읽은 폭·높이·길이가 저장 열(int4) 범위를 넘으면 INSERT 오류(500)가 아니라
 * 판정 단계의 415 `unsupported_media_type`(TRD §3 415 하위 코드, §6-1)로 거부하고 저장 0.
 */
let ctx: ConvIntContext | undefined;

afterEach(async () => {
  await teardownConvInt(ctx);
  ctx = undefined;
});

/** ID3(빈 태그) + MPEG1 Layer III 128kbps 44.1kHz 조인트 스테레오 프레임 + Xing(프레임 수 플래그) 헤더. */
function xingMp3(frames: number): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frame = Buffer.alloc(417, 0x00);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame, 0);
  const tagAt = 4 + 32; // MPEG1 스테레오 side info 32바이트 뒤
  frame.write('Xing', tagAt, 'latin1');
  frame.writeUInt32BE(0x1, tagAt + 4);
  frame.writeUInt32BE(frames, tagAt + 8);
  return Buffer.concat([id3, frame]);
}

describe('첨부 판정값 범위(SR-D-03)', () => {
  it('FR-OPS-05 판정기가 읽은 PNG 폭·높이나 mp3 길이가 저장 범위를 넘으면 415로 거부하고 저장되지 않는다', async () => {
    ctx = await setupConvInt();
    const a = await as(ctx.app, 'a');
    const channel = await createChannel(ctx.app, a, 'range');
    const cases: [string, Buffer, string][] = [
      ['png width 2^31', png(0x80000000, 3), 'image/png'],
      ['png height 2^32-1', png(2, 0xffffffff), 'image/png'],
      ['mp3 xing frames 2^32-1', xingMp3(0xffffffff), 'audio/mpeg'],
    ];
    for (const [label, bytes, type] of cases) {
      const res = await upload(ctx.app, a, channel, bytes, type);
      expect(res.statusCode, label).toBe(415);
      expect(res.json<{ error: { code: string } }>().error.code, label).toBe('unsupported_media_type');
    }
    expect(await counts(ctx.schema)).toEqual({ meta: 0, blobs: 0 });
    // 경계 회귀: 범위 안 최대값(2^31-1)·작은 Xing 프레임 수는 그대로 201.
    expect((await upload(ctx.app, a, channel, png(0x7fffffff, 3), 'image/png')).statusCode).toBe(201);
    const ok = await upload(ctx.app, a, channel, xingMp3(100), 'audio/mpeg');
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ attachment: { duration_ms: Math.round((100 * 1152 * 1000) / 44100) } });
  });
});
