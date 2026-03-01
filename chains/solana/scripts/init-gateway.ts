import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  createKeyPairSignerFromBytes,
  type Address
} from '@solana/kit';
import {
  submitInitializeState,
  submitSetSmtRoot
} from '../client/adapter.js';

function envRequired(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function deriveStateAccount(gatewayProgramId: string, adminAddress: string): string {
  const out = execFileSync(
    'solana',
    [
      'find-program-derived-address',
      gatewayProgramId,
      'string:state',
      `pubkey:${adminAddress}`,
      '--output',
      'json-compact'
    ],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(out) as { address?: string };
  if (!parsed.address) {
    throw new Error('failed to derive state PDA from solana CLI output');
  }
  return parsed.address;
}

function hexFromWitnessRoot(publicWitnessPath: string): `0x${string}` {
  const witness = fs.readFileSync(publicWitnessPath);
  if (witness.length < 44) {
    throw new Error(`public witness too short at ${publicWitnessPath}`);
  }
  const root = witness.subarray(12, 44);
  return (`0x${Buffer.from(root).toString('hex')}`) as `0x${string}`;
}

async function readAddressFromKeypair(path: string): Promise<string> {
  const keyBytes = Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')));
  const signer = await createKeyPairSignerFromBytes(keyBytes);
  return String(signer.address);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const wsUrl =
    process.env.SOLANA_WS_URL ??
    rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  const gatewayProgramId = envRequired('SOLANA_GATEWAY_PROGRAM_ID');
  const verifierProgramId = envRequired('SOLANA_VERIFIER_PROGRAM_ID');
  const adminKeypairPath = envRequired('SOLANA_ADMIN_KEYPAIR_PATH');
  const defaultWitnessPath = 'chains/solana/circuits/smt_exclusion/target/smt_exclusion.pw';
  const publicWitnessPath = process.env.SOLANA_PUBLIC_WITNESS_PATH ?? defaultWitnessPath;

  const adminAddress = await readAddressFromKeypair(adminKeypairPath);
  const stateAccount =
    process.env.SOLANA_STATE_ACCOUNT?.trim() ||
    deriveStateAccount(gatewayProgramId, adminAddress);

  const smtRootHex =
    (process.env.SOLANA_SMT_ROOT_HEX as `0x${string}` | undefined) ??
    hexFromWitnessRoot(publicWitnessPath);

  console.log('[solana] gateway init inputs');
  console.log(`rpcUrl=${rpcUrl}`);
  console.log(`gatewayProgramId=${gatewayProgramId}`);
  console.log(`verifierProgramId=${verifierProgramId}`);
  console.log(`adminAddress=${adminAddress}`);
  console.log(`stateAccount=${stateAccount}`);
  console.log(`smtRootHex=${smtRootHex}`);

  try {
    const initResult = await submitInitializeState({
      rpcUrl,
      wsUrl,
      gatewayProgramId: gatewayProgramId as Address,
      verifierProgramId: verifierProgramId as Address,
      stateAccount: stateAccount as Address,
      payerKeypairPath: adminKeypairPath
    });
    console.log(`[solana] InitializeState tx=${initResult.txSignature}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('already in use')) {
      console.log('[solana] state account already initialized, continuing');
    } else {
      throw error;
    }
  }

  const setRootResult = await submitSetSmtRoot({
    rpcUrl,
    wsUrl,
    gatewayProgramId: gatewayProgramId as Address,
    stateAccount: stateAccount as Address,
    smtRootHex,
    payerKeypairPath: adminKeypairPath
  });
  console.log(`[solana] SetSmtRoot tx=${setRootResult.txSignature}`);
  console.log(`[solana] ready state account: ${stateAccount}`);
}

void main().catch((error) => {
  console.error(`[solana] init failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
