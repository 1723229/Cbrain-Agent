/**
 * api/meta-instances.ts — 登录前选实例（GET /api/v1/meta/instances）。
 */
import { request, dedupeInFlight } from './base';

/**
 * 客户端可见的实例元信息。
 *   - `api_key`（真 secret）不下发。
 *   - endpoint 字段不是 secret；每个实例独立（dev/staging/prod 不同），前端不能硬编码。
 *   - `agent_gateway_endpoint` 用于生成 Cbrain 插件安装命令。
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  proxy_endpoint?: string;
  agent_gateway_endpoint?: string;
}

export const metaInstancesApi = {
  /** 登录前选实例；GET /api/v1/meta/instances，公开、无需鉴权、无分页 */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),
};
