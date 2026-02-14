import type { AgentRecord, ReputationSignal } from '@shielded-x402/shared-types';

export interface Erc8004AdapterConfig {
  enabled: boolean;
  registryUrl?: string;
  timeoutMs?: number;
}

function buildUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

export class Erc8004Adapter {
  constructor(private readonly config: Erc8004AdapterConfig) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async resolveAgent(did: string): Promise<AgentRecord | null> {
    if (!this.config.enabled || !this.config.registryUrl) return null;

    const response = await fetch(buildUrl(this.config.registryUrl, `/agents/${encodeURIComponent(did)}`), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000)
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`erc8004 resolve failed: ${response.status}`);
    }

    return (await response.json()) as AgentRecord;
  }

  async publishRailCapability(record: AgentRecord): Promise<void> {
    if (!this.config.enabled || !this.config.registryUrl) return;

    const response = await fetch(buildUrl(this.config.registryUrl, '/agents'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000)
    });

    if (!response.ok) {
      throw new Error(`erc8004 publish failed: ${response.status}`);
    }
  }

  async getReputation(did: string): Promise<ReputationSignal | null> {
    if (!this.config.enabled || !this.config.registryUrl) return null;

    const response = await fetch(
      buildUrl(this.config.registryUrl, `/reputation/${encodeURIComponent(did)}`),
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000)
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`erc8004 reputation failed: ${response.status}`);
    }

    return (await response.json()) as ReputationSignal;
  }
}
