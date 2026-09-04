import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { V3AuthContext } from '../router/auth.js';
import { SqliteMetadataStore } from '../store/sqlite-adapter.js';
import { MetadataService } from './metadata-service.js';

describe('default Agent administration permissions', () => {
  let store: SqliteMetadataStore;
  let service: MetadataService;

  beforeEach(() => {
    store = new SqliteMetadataStore(':memory:');
    store.init();
    service = new MetadataService(store, 'default');
  });

  afterEach(() => store.close());

  it('allows a team admin to create and configure an Agent owned by a member', async () => {
    const owner = await service.createNormalUser({ username: 'owner' });
    const member = await service.createNormalUser({ username: 'member' });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeam({ name: 'Team', owner_user_id: owner.user_id });
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);

    const agent = await service.createAgentForCaller({
      team_id: team.team_id,
      owner_user_id: member.user_id,
      name: '研发助手',
    }, ownerCtx);
    await expect(service.setAgentFixedAssetsForCaller(agent.agent_id, [], ownerCtx)).resolves.toBeUndefined();
    expect(agent.owner_user_id).toBe(member.user_id);
  });

  it('does not allow a regular member to create an Agent for another user', async () => {
    const owner = await service.createNormalUser({ username: 'owner' });
    const member = await service.createNormalUser({ username: 'member' });
    const ownerCtx = context(owner.user_id, owner.default_user_key);
    const team = await service.createTeam({ name: 'Team', owner_user_id: owner.user_id });
    await service.addTeamMemberForCaller({ team_id: team.team_id, user_id: member.user_id }, ownerCtx);

    await expect(service.createAgentForCaller({
      team_id: team.team_id,
      owner_user_id: owner.user_id,
      name: '越权助手',
    }, context(member.user_id, member.default_user_key))).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

function context(userId: string, token: string): V3AuthContext {
  return { token, userId, isAdmin: false, isSystemAdmin: false };
}
