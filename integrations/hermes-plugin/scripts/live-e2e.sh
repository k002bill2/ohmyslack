#!/usr/bin/env bash
# 실서버 live E2E(TRD R3.3 §5-2, ADR-001): 실행 스키마 → migrate → owner → 봇·토큰 → 서버(PORT+BOT_PORT) →
# owner 로그인 → pytest -m live → 서버 종료·스키마 삭제(trap).
#
# 전제: 저장소 루트에서 `pnpm install` 완료, `.env.test`에 TEST_DATABASE_URL(루프백·`_test` DB, 쿼리 없음).
#       호출자가 `set -a; . ./.env.test; set +a`로 미리 로드해도 되고, 없으면 이 스크립트가 같은 방식으로 로드한다.
# 비밀(토큰·비밀번호·쿠키·CSRF)은 출력하지 않고 argv에도 싣지 않는다(env·0600 파일만).
# 선택 env: HERMES_AGENT_DIR(기본 ~/.hermes/hermes-agent — import 전용), PYTHON(기본 플러그인 .venv/bin/python).
set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$PLUGIN/../.." && pwd)"
cd "$ROOT"

die() { echo "live-e2e 실패: $*" >&2; exit 1; }

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  [ -f .env.test ] || die ".env.test 없음(TEST_DATABASE_URL 필요)"
  set -a; . ./.env.test; set +a
fi
[ -n "${TEST_DATABASE_URL:-}" ] || die "TEST_DATABASE_URL 미설정"
# PG* 폴백 차단(ctl.mjs와 같은 규칙): URL에 없는 값이 셸 env에서 새어 들어오지 않게.
for v in $(env | sed -n 's/^\(PG[A-Z_]*\)=.*/\1/p'); do unset "$v"; done

TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || die "tsx 없음 — 저장소 루트에서 pnpm install"
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HOME/.hermes/hermes-agent}"
PYTHON="${PYTHON:-$PLUGIN/.venv/bin/python}"
[ -x "$PYTHON" ] || die "python 없음: PYTHON 지정 또는 $PLUGIN/.venv 생성"
command -v curl >/dev/null || die "curl 없음"

export LIVE_SCHEMA="t_live_$(date +%s)_$$"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
SERVER_PID=""
SCHEMA_CREATED=0
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$SCHEMA_CREATED" = 1 ]; then
    "$TSX" "$PLUGIN/scripts/live-e2e-db.ts" drop || echo "live-e2e: 스키마 삭제 실패($LIVE_SCHEMA) — 수동 DROP 필요" >&2
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT INT TERM

free_port() { "$PYTHON" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }

# 1) 실행 스키마 + 스키마 고정 URL(값은 변수로만)
DB_URL="$("$TSX" "$PLUGIN/scripts/live-e2e-db.ts" url)" || die "스키마 URL 생성 실패"
"$TSX" "$PLUGIN/scripts/live-e2e-db.ts" create || die "스키마 생성 실패"
SCHEMA_CREATED=1
echo "live-e2e: schema $LIVE_SCHEMA"

server_cli() { DATABASE_URL="$DB_URL" pnpm --silent --filter @ohmyslack/server "$@"; }
# bot-admin은 pnpm 스크립트가 없어 apps/server에서 루트 tsx로 직접 실행한다.
bot_admin() { (cd "$ROOT/apps/server" && DATABASE_URL="$DB_URL" "$TSX" bin/bot-admin.ts "$@"); }

# 2) migrate → owner(비밀번호는 stdin 첫 줄) → 봇 + owner DM → 토큰(stdout 마지막 줄)
server_cli migrate >/dev/null || die "migrate 실패"
OWNER_EMAIL="owner@live-e2e.test"
OWNER_PW="$("$PYTHON" -c 'import secrets; print(secrets.token_urlsafe(24))')"
printf '%s\n' "$OWNER_PW" | server_cli bootstrap-owner --email "$OWNER_EMAIL" --name "라이브 오너" \
  --workspace "라이브 E2E" >/dev/null || die "bootstrap-owner 실패"
bot_admin create --name Jarvis --slug jarvis >/dev/null || die "bot-admin create 실패"
BOT_TOKEN="$(bot_admin token issue --bot jarvis --label live-e2e | tail -n 1)" \
  || die "bot-admin token issue 실패"
case "$BOT_TOKEN" in omsb_*) ;; *) die "토큰 형식이 예상과 다름(값 비공개)";; esac

# 3) 서버 기동(사람 PORT + 봇 BOT_PORT). env는 필요한 것만 넘긴다.
PORT="$(free_port)"; BOT_PORT="$(free_port)"
[ "$PORT" != "$BOT_PORT" ] || BOT_PORT="$(free_port)"
MAIN_URL="http://127.0.0.1:$PORT"
(cd "$ROOT/apps/server" && exec env -i PATH="$PATH" HOME="$HOME" HOST=127.0.0.1 PORT="$PORT" BOT_PORT="$BOT_PORT" \
  ALLOWED_ORIGIN="$MAIN_URL" DATABASE_URL="$DB_URL" "$TSX" src/main.ts) >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -sf "$MAIN_URL/api/healthz" >/dev/null 2>&1 && (exec 3<>"/dev/tcp/127.0.0.1/$BOT_PORT") 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 20 "$WORK/server.log" >&2; die "서버 기동 실패"; }
  sleep 0.2
done
curl -sf "$MAIN_URL/api/healthz" >/dev/null || { tail -n 20 "$WORK/server.log" >&2; die "서버 준비 시간 초과"; }

# 4) owner 로그인 → 세션 쿠키(__Host-oms_session, http라 쿠키 jar 대신 Set-Cookie 직접 파싱) + csrf_token
OWNER_EMAIL="$OWNER_EMAIL" OWNER_PW="$OWNER_PW" "$PYTHON" -c \
  'import json,os; print(json.dumps({"email": os.environ["OWNER_EMAIL"], "password": os.environ["OWNER_PW"]}))' \
  >"$WORK/cred.json"
curl -s -o "$WORK/login.json" -D "$WORK/login.h" -w '%{http_code}' -H "origin: $MAIN_URL" \
  -H 'content-type: application/json' --data @"$WORK/cred.json" "$MAIN_URL/api/auth/login" >"$WORK/login.status"
[ "$(cat "$WORK/login.status")" = 200 ] || die "owner 로그인 실패(HTTP $(cat "$WORK/login.status"))"
OHMYSLACK_LIVE_COOKIE="$(tr -d '\r' <"$WORK/login.h" | sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-oms_session=[^;]*\).*/\1/p' | head -n 1)"
[ -n "$OHMYSLACK_LIVE_COOKIE" ] || die "세션 쿠키 없음"
OHMYSLACK_LIVE_CSRF="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["csrf_token"])' "$WORK/login.json")"

# 5) pytest -m live — 비밀은 env로만 전달, 송신 명령 문자열에는 비밀이 없다.
export OHMYSLACK_LIVE_COOKIE OHMYSLACK_LIVE_CSRF
export OHMYSLACK_LIVE_MAIN_URL="$MAIN_URL" OHMYSLACK_LIVE_ORIGIN="$MAIN_URL"
export OHMYSLACK_LIVE_OWNER_SEND="\"$PYTHON\" \"$PLUGIN/scripts/live_owner_send.py\""
export OHMYSLACK_LIVE_E2E=1 OHMYSLACK_BOT_URL="http://127.0.0.1:$BOT_PORT" OHMYSLACK_BOT_TOKEN="$BOT_TOKEN"
set +e
(cd "$PLUGIN" && PYTHONPATH="$HERMES_AGENT_DIR" "$PYTHON" -m pytest -m live -q -p no:cacheprovider tests/test_live_e2e.py)
RESULT=$?
set -e
[ "$RESULT" = 0 ] || tail -n 20 "$WORK/server.log" >&2
exit "$RESULT"
