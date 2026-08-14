import { readFileSync } from 'node:fs';
import { Client, escapeFilter, InvalidCredentialsError } from 'ldapts';
import type { PanelConfig } from '../config/panel-config.js';

export interface LdapUserProfile {
  subjectId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  dn: string;
  rawProfileJson: string;
}

export class LdapAuthenticationError extends Error {
  constructor(readonly code: 'invalid_credentials' | 'unavailable' | 'misconfigured') {
    super(code);
    this.name = 'LdapAuthenticationError';
  }
}

type LdapConfig = PanelConfig['ldap'];

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return stringValue(value[0]);
  return null;
}

export function buildLdapUserFilter(username: string): string {
  return escapeFilter`(&(objectClass=inetOrgPerson)(uid=${username}))`;
}

export class LdapAuthenticator {
  private readonly bindPassword: string;
  private readonly ca: Buffer[] | undefined;

  constructor(private readonly config: LdapConfig) {
    if (!config.enabled) {
      this.bindPassword = '';
      this.ca = undefined;
      return;
    }
    if (!config.bindDn || !config.bindPasswordFile || !config.userBaseDn) {
      throw new LdapAuthenticationError('misconfigured');
    }
    if (!config.startTls && !config.allowInsecurePoc) {
      throw new Error('LDAP plaintext is disabled; enable StartTLS or explicitly set CBRAIN_LDAP_ALLOW_INSECURE_POC=true');
    }
    this.bindPassword = readFileSync(config.bindPasswordFile, 'utf8').trimEnd();
    this.ca = config.caFile ? [readFileSync(config.caFile)] : undefined;
  }

  private createClient(): Client {
    return new Client({
      url: this.config.url,
      connectTimeout: this.config.connectTimeoutMs,
      timeout: this.config.operationTimeoutMs,
      tlsOptions: this.ca ? { ca: this.ca, rejectUnauthorized: true } : undefined,
    });
  }

  private async secure(client: Client): Promise<void> {
    if (!this.config.startTls) return;
    await client.startTLS({ ca: this.ca, rejectUnauthorized: true });
  }

  async authenticate(rawUsername: string, password: string): Promise<LdapUserProfile> {
    if (!this.config.enabled) throw new LdapAuthenticationError('misconfigured');
    const username = rawUsername.trim();
    if (!username || username.length > 256 || username.includes('\0') || !password) {
      throw new LdapAuthenticationError('invalid_credentials');
    }

    const serviceClient = this.createClient();
    let profile: LdapUserProfile;
    try {
      await this.secure(serviceClient);
      await serviceClient.bind(this.config.bindDn, this.bindPassword);
      const filter = buildLdapUserFilter(username);
      const result = await serviceClient.search(this.config.userBaseDn, {
        scope: 'sub',
        filter,
        attributes: ['entryUUID', 'uid', 'cn', 'mail'],
        sizeLimit: 2,
        timeLimit: Math.max(1, Math.ceil(this.config.operationTimeoutMs / 1000)),
      });
      if (result.searchEntries.length !== 1) {
        throw new LdapAuthenticationError('invalid_credentials');
      }
      const entry = result.searchEntries[0] as unknown as Record<string, unknown> & { dn: string };
      const subjectId = stringValue(entry.entryUUID);
      const uid = stringValue(entry.uid);
      if (!subjectId || !uid || !entry.dn) throw new LdapAuthenticationError('invalid_credentials');
      profile = {
        subjectId,
        username: uid,
        displayName: stringValue(entry.cn),
        email: stringValue(entry.mail),
        dn: entry.dn,
        rawProfileJson: JSON.stringify({ uid, cn: stringValue(entry.cn), mail: stringValue(entry.mail) }),
      };
    } catch (err) {
      if (err instanceof LdapAuthenticationError) throw err;
      throw new LdapAuthenticationError('unavailable');
    } finally {
      await serviceClient.unbind().catch(() => undefined);
    }

    const userClient = this.createClient();
    try {
      await this.secure(userClient);
      await userClient.bind(profile.dn, password);
      return profile;
    } catch (err) {
      if (err instanceof InvalidCredentialsError) throw new LdapAuthenticationError('invalid_credentials');
      throw new LdapAuthenticationError('unavailable');
    } finally {
      await userClient.unbind().catch(() => undefined);
    }
  }

  /** 完整快照；只有成功返回且不超过上限时，调用方才可执行停用同步。 */
  async listUsers(maxUsers = 5_000): Promise<LdapUserProfile[]> {
    if (!this.config.enabled) throw new LdapAuthenticationError('misconfigured');
    const client = this.createClient();
    try {
      await this.secure(client);
      await client.bind(this.config.bindDn, this.bindPassword);
      const result = await client.search(this.config.userBaseDn, {
        scope: 'sub',
        filter: '(objectClass=inetOrgPerson)',
        attributes: ['entryUUID', 'uid', 'cn', 'mail'],
        sizeLimit: maxUsers + 1,
        paged: { pageSize: 500 },
        timeLimit: Math.max(1, Math.ceil(this.config.operationTimeoutMs / 1000)),
      });
      if (result.searchEntries.length > maxUsers) throw new LdapAuthenticationError('unavailable');
      return result.searchEntries.map((raw) => {
        const entry = raw as unknown as Record<string, unknown> & { dn: string };
        const subjectId = stringValue(entry.entryUUID);
        const username = stringValue(entry.uid);
        if (!subjectId || !username || !entry.dn) throw new LdapAuthenticationError('unavailable');
        const displayName = stringValue(entry.cn);
        const email = stringValue(entry.mail);
        return {
          subjectId,
          username,
          displayName,
          email,
          dn: entry.dn,
          rawProfileJson: JSON.stringify({ uid: username, cn: displayName, mail: email }),
        };
      });
    } catch (err) {
      if (err instanceof LdapAuthenticationError) throw err;
      throw new LdapAuthenticationError('unavailable');
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
