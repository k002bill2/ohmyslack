/**
 * 대화·워크스페이스 멤버 조회(활성만)에 없는 사용자 이름을 `GET /api/users/names`로 찾는다(G-50·G-51).
 * 비활성 사용자는 「{이름} (비활성)」로 바꿔 돌려준다. 실패(네트워크·HTTP 오류)는 빈 결과 — 호출자가 대체 이름을 쓴다.
 */
import { USER_NAMES_MAX_IDS, type UserNamesResponse } from '../../../../packages/shared/src/members.js';
import { AUTHOR_NAME_COPY } from '../ui/copy.js';
import { HttpStatusError, NetworkError, type Api } from './api.js';

export function userLabel(user: UserNamesResponse['users'][number]): string {
  return user.status === 'disabled' ? AUTHOR_NAME_COPY.inactive(user.display_name) : user.display_name;
}

export async function lookupUserNames(api: Api, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, string>();
  for (let i = 0; i < unique.length; i += USER_NAMES_MAX_IDS) {
    const chunk = unique.slice(i, i + USER_NAMES_MAX_IDS);
    try {
      const res = await api.get<UserNamesResponse>(`/api/users/names?ids=${chunk.map(encodeURIComponent).join(',')}`);
      for (const u of res.users) found.set(u.id, userLabel(u));
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof HttpStatusError)) throw e;
    }
  }
  return found;
}
