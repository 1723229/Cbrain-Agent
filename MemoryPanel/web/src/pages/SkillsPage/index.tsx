import { ResourcePage } from '@/pages/ResourcePage';
import SkillsPanel from './components/SkillsPanel';
import { useAuthStore } from '@/stores/auth';
import { isTeamAdmin, useTeams } from '@/services';

export function SkillsPage() {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  if (!auth) return null;

  return (
    <ResourcePage>
      <SkillsPanel currentUser={auth.user_id}
        isAdmin={auth.isAdmin || isTeamAdmin(activeTeam, auth.user_id)} isSystemAdmin={auth.isAdmin} />
    </ResourcePage>
  );
}
