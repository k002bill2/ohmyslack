# 런북 — 최초 owner 생성·비밀번호 복구 (BOOT-01, TRD §5·§5-1 S4·S9)

> 로컬 전용 운영 명령입니다. 원격 HTTP 경로는 없습니다. 이 문서는 접속 문자열·비밀번호 같은 **값을 담지 않습니다.**
> 실제 운영 계정 생성은 이 문서로 승인되지 않습니다(DEV_DESIGN 6-2 BOOT-01). 운영 실행은 영환님이 직접 합니다.

## 0. 준비

1. Node 26 경로: `export PATH=$HOME/.nvm/versions/node/v26.13.0/bin:$PATH`
2. 저장소 루트에서 `pnpm install --frozen-lockfile`
3. 마이그레이션이 적용된 DB인지 확인합니다(`schema_migrations`에 `0001_initial_schema.sql`).
4. 접속 문자열은 **사람이 셸에서 직접** 로드합니다. 운영 `.env`의 `DATABASE_URL`은 에이전트가 열거나 출력하지 않습니다.
   ```sh
   set -a; . ./.env; set +a     # 운영: 사람만. 합성 환경 리허설은 합성 DB를 가리키는 별도 파일을 씁니다.
   ```
   명령은 `DATABASE_URL`만 읽습니다. 값이 비어 있으면 종료 코드 2로 끝납니다.

## 1. 최초 owner 생성

```sh
pnpm --filter @ohmyslack/server bootstrap-owner --email <이메일> --name <표시 이름> --workspace <워크스페이스 이름>
```

- 비밀번호는 **인자·환경변수로 받지 않습니다.** TTY에서는 `새 비밀번호:`·`비밀번호 확인:` 프롬프트가 나오고 입력이 화면에 보이지 않습니다. 두 입력이 다르면 실패합니다.
- 파이프 입력(자동화·리허설)은 stdin 첫 줄만 씁니다. 셸 히스토리에 남지 않게 파일·`printf` 인자 대신 비밀 관리 도구 출력으로 넘깁니다.
- 정책: 12–128자(Unicode code point). 그 밖의 조합 규칙은 없습니다.
- 해시: Node 내장 `crypto.argon2` argon2id, m=19456 KiB·t=2·p=1·tag 32B·salt 16B, PHC 문자열만 `users.password_hash`에 저장합니다.
- 이메일은 trim → NFC → 소문자로 정규화해 `users.email_norm`에 저장합니다.
- 한 트랜잭션에서 워크스페이스(없을 때만 생성, `--workspace` 필수)·`users`·`workspace_members(role=owner)`를 만듭니다.
- 성공: 종료 코드 0, stdout에 고정 문구 한 줄. 출력에는 비밀번호·해시·이메일·ID가 없습니다.

## 2. 재실행 거부

owner가 **1명이라도** 있으면 어떤 행도 바꾸지 않고 종료 코드 1, stderr에 `bootstrap-owner 실패(owner_exists)`를 씁니다.
같은 이메일·다른 이메일 모두 같습니다. 기존 owner의 비밀번호를 바꾸려면 3절을 씁니다.

| 종료 코드 | 의미 |
|---|---|
| 0 | 생성 완료 |
| 1 | 거부(`owner_exists`·`email_taken`·`multiple_workspaces`·`workspace_name_required`·`policy_too_short`·`policy_too_long`·`input`) 또는 DB 오류(SQLSTATE만 표시). 변경 없음 |
| 2 | 사용법 오류(필수 인자 누락·알 수 없는 인자 예: `--password`)·`DATABASE_URL` 없음. 변경 없음 |

## 3. 비밀번호 복구 (TRD §5-1 S4)

```sh
pnpm --filter @ohmyslack/server reset-password --email <이메일>
```

- 입력 방식·정책은 1절과 같습니다.
- 한 트랜잭션에서 해시를 바꾸고 그 계정의 **열린 세션 전부**에 `revoked_at=now()`를 기록합니다(이미 폐기된 세션의 시각은 그대로).
- 없는 이메일은 종료 코드 1(`no_such_user`), 변경 없음.
- 열린 WS는 서버 재시작 없이 **5초 안에** close 1008로 닫힙니다. CLI는 별도 프로세스라 서버에 이벤트를 보내지 못하므로, 서버 realtime hub가 열린 연결이 있는 동안 4초마다 그 연결들의 세션을 한 쿼리로 다시 확인(비연장)해 폐기·만료·비활성 계정의 연결을 닫습니다(NC-21, `apps/server/test/ops/credential-reset.int.test.ts`). 수동 SQL로 세션을 폐기하거나 계정을 비활성화한 경우도 같습니다.
- 확인: 복구 직후 해당 사용자의 브라우저가 5초 안에 로그인 화면으로 돌아가는지 봅니다. 서버 재시작은 필요하지 않습니다.

## 4. 합성 환경 리허설 (QA-BOOT-01)

1. 합성 DB(테스트 DB 규칙을 통과하는 `*_test` DB의 빈 스키마)에 마이그레이션을 적용합니다.
2. 1절 명령 → 종료 코드 0 확인.
3. 다른 이메일로 1절 재실행 → 종료 코드 1·`owner_exists` 확인, `users`·`workspace_members` 행 수 무변경 확인.
4. 출력·DB 덤프에서 입력한 합성 비밀번호 문자열 0건 확인.
5. 결과를 `qa/manual/QA-BOOT-01.md`에 5-4 형식으로 기록합니다. 실행하지 않은 항목은 `PASS`로 적지 않습니다.

## 주의

- 이 명령을 원격 라우트·서버 프로세스에서 import하지 않습니다(`apps/server/bin/`은 빌드 대상 `src/` 밖).
- 비밀번호를 커밋·이슈·채팅·로그에 붙이지 않습니다.
