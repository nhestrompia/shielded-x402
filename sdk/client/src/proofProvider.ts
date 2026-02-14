import { pad, type Hex } from 'viem';
import type { ProofProvider, ProofProviderRequest, ProofProviderResult } from './types.js';

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const toHexWord = (value: bigint): Hex => (`0x${value.toString(16).padStart(64, '0')}` as Hex);

const normalizeHex = (value: string): Hex => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) {
    return (`0x${BigInt(trimmed).toString(16)}` as Hex);
  }
  return (trimmed as Hex);
};

const hexToBytes32 = (value: Hex): number[] => {
  const hex = value.slice(2).padStart(64, '0');
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
};

const fieldHexToDecimal = (value: Hex, label: string): string => {
  const scalar = BigInt(value);
  if (scalar >= BN254_FIELD_MODULUS) {
    throw new Error(`${label} exceeds BN254 field modulus; provide a field-safe value`);
  }
  return scalar.toString(10);
};

const normalizePublicInputWord = (value: unknown): Hex => {
  if (typeof value === 'string') {
    return toHexWord(BigInt(normalizeHex(value)));
  }
  if (typeof value === 'bigint') {
    return toHexWord(value);
  }
  if (typeof value === 'number') {
    return toHexWord(BigInt(value));
  }
  throw new Error(`unsupported public input value type: ${typeof value}`);
};

const collapseExpandedPublicInputs = (publicInputs: Hex[]): Hex[] | null => {
  if (publicInputs.length < 161) return null;
  const readWord = (start: number): Hex => {
    const bytes: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      const item = publicInputs[start + i];
      if (!item) throw new Error('invalid expanded public input');
      const n = BigInt(item);
      if (n < 0n || n > 255n) throw new Error('expanded public input byte out of range');
      bytes.push(Number(n));
    }
    return (`0x${Buffer.from(bytes).toString('hex')}` as Hex);
  };
  return [
    readWord(0),
    readWord(32),
    readWord(64),
    readWord(96),
    readWord(128),
    toHexWord(BigInt(publicInputs[160] ?? '0x0'))
  ];
};

const normalizePublicInputs = (values: unknown): Hex[] => {
  if (!Array.isArray(values)) return [];
  const words = values.map((value) => normalizePublicInputWord(value));
  if (words.length === 6) return words;
  const collapsed = collapseExpandedPublicInputs(words);
  return collapsed ?? words;
};

const normalizeProofHex = (value: unknown): Hex => {
  if (typeof value === 'string') {
    return normalizeHex(value);
  }
  if (value instanceof Uint8Array) {
    return (`0x${Buffer.from(value).toString('hex')}` as Hex);
  }
  if (value && typeof value === 'object' && 'proof' in value) {
    return normalizeProofHex((value as { proof: unknown }).proof);
  }
  throw new Error('unsupported proof value');
};

const toNoirInput = (request: ProofProviderRequest): Record<string, unknown> => {
  const pathBytes = request.witness.path.map((value) => hexToBytes32(value));
  const merklePath = [...pathBytes];
  while (merklePath.length < 32) {
    merklePath.push(new Array<number>(32).fill(0));
  }

  const indexBits = request.witness.indexBits.slice(0, 32);
  while (indexBits.length < 32) {
    indexBits.push(0);
  }
  const normalizedIndexBits = indexBits.map((bit) => {
    if (bit !== 0 && bit !== 1) {
      throw new Error('merkle witness indexBits must be 0/1');
    }
    return bit;
  });

  return {
    note_amount: request.note.amount.toString(10),
    note_rho: fieldHexToDecimal(request.note.rho, 'note.rho'),
    note_pk_hash: fieldHexToDecimal(request.note.pkHash, 'note.pkHash'),
    nullifier_secret: fieldHexToDecimal(request.nullifierSecret, 'nullifierSecret'),
    merkle_path: merklePath,
    index_bits: normalizedIndexBits,
    merchant_pk_hash: fieldHexToDecimal(request.merchantPubKey, 'merchantPubKey'),
    merchant_rho: fieldHexToDecimal(request.merchantRho, 'merchantRho'),
    change_pk_hash: fieldHexToDecimal(request.changePkHash, 'changePkHash'),
    change_rho: fieldHexToDecimal(request.changeRho, 'changeRho'),
    pay_amount: request.amount.toString(10),
    challenge_nonce: hexToBytes32(request.challengeNonce),
    merchant_address_word: hexToBytes32(pad(request.merchantAddress, { size: 32 }))
  };
};

const equalPublicInputs = (left: readonly Hex[], right: readonly Hex[]): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if ((left[i] ?? '').toLowerCase() !== (right[i] ?? '').toLowerCase()) {
      return false;
    }
  }
  return true;
};

export interface NoirJsProgramExecutor {
  execute: (input: Record<string, unknown>) => Promise<{ witness: unknown }>;
}

export interface NoirJsBackend {
  generateProof: (witness: unknown) => Promise<{ proof: unknown; publicInputs?: unknown }>;
}

export interface NoirJsProofProviderConfig {
  noir: NoirJsProgramExecutor;
  backend: NoirJsBackend;
  enforcePublicInputsMatch?: boolean;
}

export interface NoirCircuitArtifact {
  bytecode: string;
  [key: string]: unknown;
}

const isNoirCircuitArtifact = (value: unknown): value is NoirCircuitArtifact => {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { bytecode?: unknown }).bytecode === 'string'
  );
};

const loadBundledSpendChangeCircuit = async (): Promise<NoirCircuitArtifact> => {
  const dynamicImport = new Function('m', 'return import(m)') as (moduleName: string) => Promise<any>;

  // Node-safe path: avoid JSON module import-attribute issues by reading raw file.
  try {
    const fs = await dynamicImport('node:fs/promises');
    const raw = await fs.readFile(new URL('./circuits/spend_change.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    if (isNoirCircuitArtifact(parsed)) return parsed;
  } catch {
    // Fall through to runtime module import fallback.
  }

  const module = await dynamicImport('./circuits/spend_change.json');
  const candidate = module.default ?? module;
  if (!isNoirCircuitArtifact(candidate)) {
    throw new Error('bundled spend_change circuit artifact is invalid');
  }
  return candidate;
};

export function createNoirJsProofProvider(config: NoirJsProofProviderConfig): ProofProvider {
  return {
    async generateProof(request: ProofProviderRequest): Promise<ProofProviderResult> {
      const noirInput = toNoirInput(request);
      const { witness } = await config.noir.execute(noirInput);
      const generated = await config.backend.generateProof(witness);
      const proof = normalizeProofHex(generated.proof);

      const normalized = normalizePublicInputs(generated.publicInputs);
      const useNormalized = normalized.length > 0;
      const finalPublicInputs = useNormalized ? normalized : request.expectedPublicInputs;

      if ((config.enforcePublicInputsMatch ?? true) && !equalPublicInputs(finalPublicInputs, request.expectedPublicInputs)) {
        throw new Error('proof provider public inputs mismatch with SDK-computed values');
      }

      return {
        proof,
        publicInputs: finalPublicInputs
      };
    }
  };
}

/**
 * Convenience factory for Node agent apps:
 * instantiates Noir + UltraHonkBackend from a compiled Noir circuit artifact.
 */
export async function createNoirJsProofProviderFromCircuit(
  circuit: NoirCircuitArtifact,
  config?: Omit<NoirJsProofProviderConfig, 'noir' | 'backend'>
): Promise<ProofProvider> {
  const dynamicImport = new Function('m', 'return import(m)') as (moduleName: string) => Promise<any>;
  const noirPkg = await dynamicImport('@noir-lang/noir_js');
  const bbPkg = await dynamicImport('@aztec/bb.js');

  const Noir = noirPkg.Noir as new (artifact: NoirCircuitArtifact) => NoirJsProgramExecutor;
  const UltraHonkBackend = bbPkg.UltraHonkBackend as new (bytecode: string) => NoirJsBackend;

  const noir = new Noir(circuit);
  const backend = new UltraHonkBackend(circuit.bytecode);
  const providerConfig: NoirJsProofProviderConfig = {
    noir,
    backend
  };
  if (config?.enforcePublicInputsMatch !== undefined) {
    providerConfig.enforcePublicInputsMatch = config.enforcePublicInputsMatch;
  }
  return createNoirJsProofProvider({
    ...providerConfig
  });
}

/**
 * Highest-level convenience for agent apps:
 * loads the bundled spend_change artifact from this package.
 */
export async function createNoirJsProofProviderFromDefaultCircuit(
  config?: Omit<NoirJsProofProviderConfig, 'noir' | 'backend'>
): Promise<ProofProvider> {
  const circuit = await loadBundledSpendChangeCircuit();
  return createNoirJsProofProviderFromCircuit(circuit, config);
}
