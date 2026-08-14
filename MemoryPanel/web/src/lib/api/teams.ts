/**
 * api/teams.ts — Team + TeamMember（链路 A：meta/team/* + meta/team-member/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { PaginatedResult, Team, TeamMember } from './types';

export interface MemberCandidate {
  user_id: string;
  username: string;
  display_name?: string | null;
}

export const teamsApi = {
  /**
   * 列出当前用户作为 active 成员的 team（内核 listTeamsByUser）。
   * 内核 /v3/meta/team/list 要求 body 带 user_id 或 user_key；身份只在 header 不够。
   * admin 也传自己的 user_id（后端暂无 user/list 式「实例级列举全部 team」）。
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** team 详情 */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** 创建 team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** 更新 team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /** 删除 team（meta team/delete） */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_id: teamId }),
};

export const membersApi = {
  /** 列出 team 成员 */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /** 搜索尚未加入 team 的有效普通用户；仅 team admin 可调用。 */
  candidates: (teamId: string, query = '', limit = 100) =>
    metaPost<PaginatedResult<MemberCandidate>>('team-member/candidate/list', {
      team_id: teamId,
      query: query.trim() || undefined,
      limit,
      offset: 0,
    }),

  /**
   * 将候选用户加入 team；候选项由 candidate/list 按当前管理员权限提供。
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** 移除成员 */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};
