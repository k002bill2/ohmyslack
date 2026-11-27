-- 0009 로컬 계측 일 단위 집계. 정본: docs/02-prd/PRD.md §10, docs/03-trd/TRD.md TR-SEC-09·계측 allowlist.
-- 스키마 중립: 이름을 스키마로 한정하지 않는다(실행기가 search_path의 스키마에 적용). 트랜잭션은 실행기가 연다.
-- 열은 이 네 개뿐이다: 식별자·본문·IP·UA·원시 오류를 담을 열이 없다. dims는 shared allowlist로 검증된 enum·구간값·boolean만 담는다.
-- 보관: 서버가 기동 시·24시간마다 오늘 포함 7일 밖 행을 지운다(ops/metrics.ts startMetricRetention).

CREATE TABLE metric_daily (
  day date NOT NULL,
  event text NOT NULL,
  dims jsonb NOT NULL,
  count integer NOT NULL,
  CONSTRAINT metric_daily_pkey PRIMARY KEY (day, event, dims),
  CONSTRAINT metric_daily_count_check CHECK (count > 0),
  CONSTRAINT metric_daily_dims_check CHECK (jsonb_typeof(dims) = 'object')
);
