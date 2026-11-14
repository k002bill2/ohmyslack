-- 0005 문서·텍스트 첨부. 정본: docs/03-trd/TRD.md §6-1-1 (5)(R3.5·R3.6, ADR-002 §4). 단방향(롤백 없음).
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 미디어 10 MiB 상한은 서비스가 검사하고, DB CHECK는 문서 상한 26,214,400까지 넓힌다.

ALTER TABLE attachments ADD COLUMN filename text;
ALTER TABLE attachments ADD COLUMN has_macros boolean NOT NULL DEFAULT false;

ALTER TABLE attachments DROP CONSTRAINT attachments_mime_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_mime_check CHECK (mime IN (
  'audio/mpeg', 'image/png', 'image/jpeg', 'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/hwp+zip', 'application/x-hwp',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'text/plain', 'text/markdown', 'text/csv'));

ALTER TABLE attachments DROP CONSTRAINT attachments_byte_size_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_byte_size_check CHECK (byte_size BETWEEN 1 AND 26214400);

-- 문서·텍스트 계열이면 파일명 필수, 미디어면 NULL(기존 행은 미디어라 NULL 그대로 통과).
ALTER TABLE attachments ADD CONSTRAINT attachments_filename_presence_check CHECK ((mime IN (
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/hwp+zip', 'application/x-hwp',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'text/plain', 'text/markdown', 'text/csv')) = (filename IS NOT NULL));
ALTER TABLE attachments ADD CONSTRAINT attachments_filename_length_check
  CHECK (filename IS NULL OR (char_length(filename) BETWEEN 1 AND 200 AND octet_length(filename) <= 255));
