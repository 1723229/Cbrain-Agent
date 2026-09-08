import { createHash } from "node:crypto";
import type {
  ExternalTeamSyncCounts,
  ExternalTeamSyncIssue,
  ExternalTeamSyncPreview,
  ExternalTeamSyncResolvedMember,
  ExternalTeamSyncResolvedProject,
  ExternalTeamSyncSnapshot,
  TeamEntity,
  TeamMemberSourceEntity,
  UserEntity,
} from "../types.js";

export interface BuildExternalTeamSyncPreviewInput {
  snapshot: ExternalTeamSyncSnapshot;
  users: UserEntity[];
  teams: TeamEntity[];
  memberSources: TeamMemberSourceEntity[];
}

const EMPTY_COUNTS: ExternalTeamSyncCounts = {
  teams_create: 0,
  teams_update: 0,
  teams_inactivate: 0,
  teams_reactivate: 0,
  members_add: 0,
  members_remove: 0,
  members_role_change: 0,
  unresolved_users: 0,
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function hashExternalTeamSyncSnapshot(snapshot: ExternalTeamSyncSnapshot): string {
  const stable = canonical({
    provider_id: snapshot.provider_id,
    identity_provider_id: snapshot.identity_provider_id,
    source_url: snapshot.source_url.replace(/\/+$/, ""),
    complete: snapshot.complete,
    projects: snapshot.projects,
  });
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function resolveAccount(
  account: string,
  providerId: string,
  users: UserEntity[],
): { user?: UserEntity; issue?: ExternalTeamSyncIssue["code"] } {
  const matches = users.filter((candidate) =>
    candidate.auth_provider === providerId && candidate.username === account,
  );
  if (matches.length === 0) return { issue: "USER_NOT_FOUND" };
  const activeMatches = matches.filter((candidate) => candidate.status === "active");
  if (activeMatches.length === 1) return { user: activeMatches[0] };
  if (activeMatches.length > 1) return { issue: "USER_AMBIGUOUS" };
  return { issue: "USER_INACTIVE" };
}

function projectIsActive(status: string): boolean {
  return status.trim().toLowerCase() !== "closed";
}

function teamNeedsUpdate(team: TeamEntity, project: ExternalTeamSyncResolvedProject, sourceUrl: string): boolean {
  return team.name !== project.name
    || (team.description ?? "") !== (project.description ?? "")
    || (team.source_url ?? "") !== sourceUrl
    || team.metadata_json !== (project.metadata_json ?? "{}");
}

export function buildExternalTeamSyncPreview(
  input: BuildExternalTeamSyncPreviewInput,
): ExternalTeamSyncPreview {
  if (input.snapshot.complete !== true) throw new Error("external team sync requires a complete snapshot");
  const counts = { ...EMPTY_COUNTS };
  const issues: ExternalTeamSyncIssue[] = [];
  const existingByRef = new Map(
    input.teams
      .filter((team) => team.source_type === "zentao" && team.source_ref)
      .map((team) => [team.source_ref!, team]),
  );
  const externalSourcesByTeam = new Map<string, TeamMemberSourceEntity[]>();
  for (const source of input.memberSources) {
    if (source.source_type !== "zentao" || source.status !== "active") continue;
    const rows = externalSourcesByTeam.get(source.team_id) ?? [];
    rows.push(source);
    externalSourcesByTeam.set(source.team_id, rows);
  }

  const projects: ExternalTeamSyncResolvedProject[] = [];
  const seenProjectRefs = new Set<string>();
  for (const raw of [...input.snapshot.projects].sort((a, b) => a.external_id.localeCompare(b.external_id))) {
    seenProjectRefs.add(raw.external_id);
    const existing = existingByRef.get(raw.external_id);
    const active = projectIsActive(raw.status);
    if (!active && !existing) continue;

    const desiredByUser = new Map<string, ExternalTeamSyncResolvedMember>();
    const candidates = [...raw.members];
    if (raw.pm_account && !candidates.some((member) => member.account === raw.pm_account)) {
      candidates.push({
        external_id: `${raw.external_id}:pm:${raw.pm_account}`,
        account: raw.pm_account,
        role: "admin",
      });
    }
    for (const member of candidates.sort((a, b) => a.account.localeCompare(b.account))) {
      const resolved = resolveAccount(member.account, input.snapshot.identity_provider_id, input.users);
      if (!resolved.user) {
        issues.push({ code: resolved.issue!, project_ref: raw.external_id, account: member.account });
        continue;
      }
      const role = member.account === raw.pm_account ? "admin" : member.role;
      const prior = desiredByUser.get(resolved.user.user_id);
      if (!prior || role === "admin") {
        desiredByUser.set(resolved.user.user_id, {
          user_id: resolved.user.user_id,
          account: member.account,
          external_id: member.external_id,
          role,
        });
      }
    }
    const project: ExternalTeamSyncResolvedProject = {
      ...raw,
      ...(existing ? { team_id: existing.team_id } : {}),
      active,
      members: active ? [...desiredByUser.values()] : [],
    };
    projects.push(project);

    if (!existing) {
      counts.teams_create += 1;
      counts.members_add += project.members.length;
      continue;
    }
    if (existing.status === "active" && !active) counts.teams_inactivate += 1;
    if (existing.status === "archived" && active) counts.teams_reactivate += 1;
    if (teamNeedsUpdate(existing, project, input.snapshot.source_url)) counts.teams_update += 1;

    const oldByUser = new Map((externalSourcesByTeam.get(existing.team_id) ?? []).map((row) => [row.user_id, row]));
    const newByUser = new Map(project.members.map((row) => [row.user_id, row]));
    for (const [userId, member] of newByUser) {
      const old = oldByUser.get(userId);
      if (!old) counts.members_add += 1;
      else if (old.role !== member.role) counts.members_role_change += 1;
    }
    for (const userId of oldByUser.keys()) {
      if (!newByUser.has(userId)) counts.members_remove += 1;
    }
  }
  for (const [sourceRef, team] of existingByRef) {
    if (seenProjectRefs.has(sourceRef)) continue;
    if (team.status === "active") counts.teams_inactivate += 1;
    counts.members_remove += (externalSourcesByTeam.get(team.team_id) ?? []).length;
  }
  counts.unresolved_users = issues.length;
  return {
    provider_id: input.snapshot.provider_id,
    snapshot_hash: hashExternalTeamSyncSnapshot(input.snapshot),
    counts,
    issues,
    projects,
  };
}
