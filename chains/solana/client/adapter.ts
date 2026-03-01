import {
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address
} from '@solana/kit';
import fs from 'node:fs';
import { buildPayAuthorizedData } from './encoding.js';

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address;
const COMPUTE_BUDGET_PROGRAM_ADDRESS = 'ComputeBudget111111111111111111111111111111' as Address;
const SOLANA_PROOF_LEN = 388;
const SOLANA_WITNESS_LEN = 76;

function parseHex32(hex: `0x${string}`, fieldName: string): Uint8Array {
  const trimmed = hex.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a 32-byte 0x-prefixed hex string`);
  }
  return Uint8Array.from(Buffer.from(trimmed, 'hex'));
}

async function loadSignerFromKeypairPath(keypairPath: string) {
  const signerBytes = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  return createKeyPairSignerFromBytes(signerBytes);
}

async function sendGatewayInstruction(input: {
  rpcUrl: string;
  wsUrl: string;
  payerKeypairPath: string;
  instructions: Array<{
    programAddress: Address;
    accounts: Array<{ address: Address; role: number }>;
    data: Uint8Array;
  }>;
}): Promise<string> {
  const payer = await loadSignerFromKeypairPath(input.payerKeypairPath);
  const rpc = createSolanaRpc(input.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(input.wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const msg = appendTransactionMessageInstructions(
    input.instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 0 }))
    )
  );

  const signed = await signTransactionMessageWithSigners(msg);
  assertIsSendableTransaction(signed);
  assertIsTransactionWithBlockhashLifetime(signed);

  await sendAndConfirm(signed, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signed);
}

function buildSetComputeUnitLimitInstruction(units: number): {
  programAddress: Address;
  accounts: Array<{ address: Address; role: number }>;
  data: Uint8Array;
} {
  if (!Number.isFinite(units) || units <= 0 || units > 1_400_000) {
    throw new Error('computeUnits must be a positive number <= 1_400_000');
  }
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data
  };
}

export interface SolanaInitializeStateRequest {
  rpcUrl: string;
  wsUrl: string;
  gatewayProgramId: Address;
  verifierProgramId: Address;
  stateAccount: Address;
  payerKeypairPath: string;
}

export async function submitInitializeState(
  request: SolanaInitializeStateRequest
): Promise<{ txSignature: string }> {
  const payer = await loadSignerFromKeypairPath(request.payerKeypairPath);
  const txSignature = await sendGatewayInstruction({
    rpcUrl: request.rpcUrl,
    wsUrl: request.wsUrl,
    payerKeypairPath: request.payerKeypairPath,
    instructions: [
      {
        programAddress: request.gatewayProgramId,
        accounts: [
          { address: payer.address, role: 3 },
          { address: request.stateAccount, role: 1 },
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 }
        ],
        data: new Uint8Array([0, ...Array.from(getAddressEncoder().encode(request.verifierProgramId))])
      }
    ]
  });

  return { txSignature };
}

export interface SolanaSetSmtRootRequest {
  rpcUrl: string;
  wsUrl: string;
  gatewayProgramId: Address;
  stateAccount: Address;
  smtRootHex: `0x${string}`;
  payerKeypairPath: string;
}

export async function submitSetSmtRoot(
  request: SolanaSetSmtRootRequest
): Promise<{ txSignature: string }> {
  const payer = await loadSignerFromKeypairPath(request.payerKeypairPath);
  const smtRoot = parseHex32(request.smtRootHex, 'smtRootHex');

  const txSignature = await sendGatewayInstruction({
    rpcUrl: request.rpcUrl,
    wsUrl: request.wsUrl,
    payerKeypairPath: request.payerKeypairPath,
    instructions: [
      {
        programAddress: request.gatewayProgramId,
        accounts: [
          { address: payer.address, role: 2 },
          { address: request.stateAccount, role: 1 }
        ],
        data: new Uint8Array([1, ...smtRoot])
      }
    ]
  });

  return { txSignature };
}

export interface SolanaPayAuthorizedRequest {
  rpcUrl: string;
  wsUrl: string;
  gatewayProgramId: Address;
  verifierProgramId: Address;
  stateAccount: Address;
  recipient: Address;
  amountLamports: bigint;
  authIdHex: `0x${string}`;
  authExpiryUnix: bigint;
  proof: Uint8Array;
  publicWitness: Uint8Array;
  computeUnits?: number;
  payerKeypairPath: string;
}

export async function submitPayAuthorized(
  request: SolanaPayAuthorizedRequest
): Promise<{ txSignature: string }> {
  if (request.proof.length !== SOLANA_PROOF_LEN) {
    throw new Error(`proof must be exactly ${SOLANA_PROOF_LEN} bytes`);
  }
  if (request.publicWitness.length !== SOLANA_WITNESS_LEN) {
    throw new Error(`publicWitness must be exactly ${SOLANA_WITNESS_LEN} bytes`);
  }

  const payer = await loadSignerFromKeypairPath(request.payerKeypairPath);

  const txSignature = await sendGatewayInstruction({
    rpcUrl: request.rpcUrl,
    wsUrl: request.wsUrl,
    payerKeypairPath: request.payerKeypairPath,
    instructions: [
      buildSetComputeUnitLimitInstruction(request.computeUnits ?? 1_000_000),
      {
        programAddress: request.gatewayProgramId,
        accounts: [
          { address: payer.address, role: 3 },
          { address: request.recipient, role: 1 },
          { address: request.stateAccount, role: 0 },
          { address: request.verifierProgramId, role: 0 },
          { address: SYSTEM_PROGRAM_ADDRESS, role: 0 }
        ],
        data: new Uint8Array([
          2, // instruction::PAY_AUTHORIZED
          ...buildPayAuthorizedData({
            authIdHex: request.authIdHex,
            amountLamports: request.amountLamports,
            authExpiryUnix: request.authExpiryUnix,
            proof: request.proof,
            publicWitness: request.publicWitness
          })
        ])
      }
    ]
  });

  return { txSignature };
}
