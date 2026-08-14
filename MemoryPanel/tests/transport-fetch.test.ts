import { describe, expect, it } from 'vitest';
import { sanitizeMetaBody } from '../src/panel/kernel/transport-fetch.js';

describe('sanitizeMetaBody', () => {
  it('redacts web session and recovery credentials from kernel request logs', () => {
    const value = sanitizeMetaBody({
      session_token: 'cs-secret-session-token-value',
      nested: { password: 'ldap-password' },
    }) as Record<string, unknown>;

    expect(value.session_token).not.toBe('cs-secret-session-token-value');
    expect((value.nested as Record<string, unknown>).password).not.toBe('ldap-password');
  });
});
