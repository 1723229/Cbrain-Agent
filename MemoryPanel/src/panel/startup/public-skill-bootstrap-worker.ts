import type { PanelDeps } from '../panel-deps.js';
import type { MetaCallContext } from '../kernel/types.js';
import type { PublicSkillSnapshot } from '../kernel/ports/knowledge-client-port.js';

const POLL_MS = 2_000;
const CONCURRENCY = 3;

export function startPublicSkillBootstrapWorker(deps: PanelDeps): () => void {
  let stopped = false;
  let running = false;
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const entry of deps.instanceRegistry.listAll()) {
        const client = deps.knowledgeClientFactory(entry.instance_id);
        const jobs = await Promise.all(Array.from({ length: CONCURRENCY }, () => client.publicSkillBootstrapClaim().catch(() => null)));
        await Promise.all(jobs.filter((job): job is Record<string, unknown> => !!job).map(async (claim) => {
          const job = claim.job as BootstrapJob;
          const item = claim.item as BootstrapItem;
          const snapshot = claim.snapshot as PublicSkillSnapshot;
          const ctx: MetaCallContext = { instanceId: entry.instance_id, gatewayEndpoint: entry.gateway_endpoint,
            gatewayApiKey: entry.api_key, userId: job.owner_user_id, reqId: `public-skill-${job.job_id}` };
          try {
            const env = await deps.skillKernel.invoke('snapshot/apply', {
              user_id: job.owner_user_id, team_id: job.team_id, agent_id: job.agent_id,
              name: snapshot.name, content: snapshot.content, resources: snapshot.resources,
              metadata: { catalog_origin: { source_id: snapshot.source_id, item_id: snapshot.item_id,
                repo_path: snapshot.repo_path, source_revision: snapshot.source_revision,
                content_hash: snapshot.content_hash, bootstrap_job_id: job.job_id } },
            }, ctx);
            if (env.code !== 0) throw new Error(`${env.code}:${env.message}`);
            const data = env.data as { skill_id?: string } | null;
            await client.publicSkillBootstrapComplete({ job_id: job.job_id, item_id: item.item_id, skill_id: data?.skill_id });
          } catch (error) {
            await client.publicSkillBootstrapComplete({ job_id: job.job_id, item_id: item.item_id,
              error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
          }
        }));
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => void drain(), POLL_MS);
  timer.unref();
  void drain();
  return () => { stopped = true; clearInterval(timer); };
}

interface BootstrapJob { job_id: string; team_id: string; agent_id: string; owner_user_id: string }
interface BootstrapItem { item_id: string }
