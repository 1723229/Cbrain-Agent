import { describe, expect, it, vi } from 'vitest';

import type { Transport } from '../src/client.js';
import { ParamError } from '../src/errors.js';
import { SkillClient } from '../src/v3/skill-client.js';

describe('SkillClient v2.0.1 API parity', () => {
  it('calls get-by-name and export with the documented request shapes', async () => {
    const post = vi.fn(async () => ({}));
    const client = new SkillClient({ post } as unknown as Transport);

    await client.getByName({ team_id: 'team-1', agent_id: 'agent-1', skill_name: 'code-review' });
    await client.exportSkill({ skill_id: 'skl-1', format: 'zip' });

    expect(post).toHaveBeenNthCalledWith(1, '/v3/skill/get-by-name', {
      team_id: 'team-1', agent_id: 'agent-1', skill_name: 'code-review',
    });
    expect(post).toHaveBeenNthCalledWith(2, '/v3/skill/export', {
      skill_id: 'skl-1', format: 'zip',
    });
  });

  it('requires space_id for forced conversation archive', () => {
    const client = new SkillClient({ post: vi.fn() } as unknown as Transport);
    expect(() => client.conversationForceArchive({
      session_id: 'session-1',
      space_id: '',
      user_id: 'user-1',
      team_id: 'team-1',
      agent_id: 'agent-1',
    })).toThrow(ParamError);
  });
});
