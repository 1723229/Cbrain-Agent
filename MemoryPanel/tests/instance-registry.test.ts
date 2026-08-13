import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';

describe('InstanceRegistry agent gateway endpoint', () => {
  it('publishes the optional plugin endpoint without exposing the service key', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'instance-registry-')), 'instances.json');
    writeFileSync(path, JSON.stringify({ instances: [{ id: 'one', name: 'One', gateway_endpoint: 'http://core:8420', agent_gateway_endpoint: 'https://cbrain.example', api_key: 'service-secret' }] }));
    const item = InstanceRegistry.load(path).listPublic()[0];
    expect(item).toEqual({ instance_id: 'one', name: 'One', gateway_endpoint: 'http://core:8420', agent_gateway_endpoint: 'https://cbrain.example' });
    expect(JSON.stringify(item)).not.toContain('service-secret');
  });
});
