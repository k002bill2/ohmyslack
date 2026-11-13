-- 0006 기기 세션 거친 라벨. 정본: docs/03-trd/TRD.md §2 `sessions` 행(R3.6), §5-3(ADR-002 §3 1c, FR-AUTH-04).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 원문 User-Agent·IP는 저장하지 않는다. 라벨은 로그인 때 서버가 고정 표로 만든 「{기기 종류} · {브라우저}」뿐이며 기존 행은 NULL이다.

ALTER TABLE sessions
  ADD COLUMN device_label text,
  ADD CONSTRAINT sessions_device_label_check CHECK (device_label IS NULL OR char_length(device_label) BETWEEN 1 AND 64);
