import { normalizeHex } from '@shielded-x402/shared-types';
import type { Hex } from '@shielded-x402/shared-types';
import type { Pool } from 'pg';

export interface RelayerKeySeed {
  chainRef: string;
  keyId: string;
  publicKey: Hex;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function parseRelayerKeysEnv(raw: string | undefined): RelayerKeySeed[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SEQUENCER_RELAYER_KEYS_JSON must be an object');
  }
  const seeded: RelayerKeySeed[] = [];
  for (const [chainRef, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    for (const [keyId, pubkey] of Object.entries(value)) {
      if (!keyId || typeof pubkey !== 'string') {
        continue;
      }
      seeded.push({
        chainRef,
        keyId,
        publicKey: normalizeHex(pubkey)
      });
    }
  }
  return seeded;
}

export async function seedRelayerKeys(pool: Pool, keys: RelayerKeySeed[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const now = nowSeconds().toString();
  for (const key of keys) {
    await pool.query(
      `INSERT INTO relayer_keys(chain_ref, key_id, public_key, status, created_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4)
       ON CONFLICT (chain_ref, key_id)
       DO UPDATE SET public_key = EXCLUDED.public_key, status = 'ACTIVE'`,
      [key.chainRef, key.keyId, key.publicKey, now]
    );
  }
}
