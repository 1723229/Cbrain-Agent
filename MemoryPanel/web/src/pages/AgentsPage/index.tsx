import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin } from '@/services';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';

export function AgentsPage() {
  const { auth } = useAuthStore();
  if (!auth) return null;

  return (
    <TeamManagementPanel
      currentUser={auth.user_id}
      instanceId={auth.instance_id}
      isSystemAdmin={isGlobalAdmin(auth.user, auth.isAdmin)}
      section="agents"
    />
  );
}
