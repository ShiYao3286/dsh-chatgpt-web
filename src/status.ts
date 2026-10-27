/** Read-only, fixed-path local credential inspection through the desktop owner gateway. */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { loadAuth, authExpired, type StoredAuth } from './auth.ts';
export type AuthStatus = 'missing' | 'expired' | 'unchecked';
export function classifyAuth(auth: StoredAuth | null): AuthStatus {
  return !auth ? 'missing' : authExpired(auth) ? 'expired' : 'unchecked';
}
export class ChatGptWebStatus extends TypertRemoteService {
  constructor(ctx: unknown) { super(ctx, 'chatGptWebStatus'); }
  @Remote
  async status(): Promise<{ authStatus: AuthStatus }> {
    // No path argument, writes, network validation, identity or credential material.
    return { authStatus: classifyAuth(await loadAuth()) };
  }
}
