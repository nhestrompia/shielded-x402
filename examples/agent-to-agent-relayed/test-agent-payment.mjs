import 'dotenv/config';
import {
  FileBackedWalletState,
  ShieldedClientSDK,
  createAgentPaymentFetch,
  createNoirJsProofProviderFromDefaultCircuit
} from '@shielded-x402/client';
import {
  createErc8004DirectoryClient,
  createEnvioGraphqlProvider,
  createOnchainRegistryProvider,
  createScanApiProvider
} from '@shielded-x402/erc8004-adapter';
import { privateKeyToAccount } from 'viem/accounts';

const env = process.env;
const relayerEndpoint = env.RELAYER_ENDPOINT ?? 'http://127.0.0.1:3100';
const payerPrivateKey = env.PAYER_PRIVATE_KEY;
if (!payerPrivateKey || !payerPrivateKey.startsWith('0x')) {
  throw new Error('PAYER_PRIVATE_KEY is required');
}

const account = privateKeyToAccount(payerPrivateKey);

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function hasX402Challenge(status, headers, bodyText) {
  const paymentRequiredHeader =
    headers.get('payment-required') ??
    headers.get('PAYMENT-REQUIRED') ??
    headers.get('x-payment-required') ??
    headers.get('X-PAYMENT-REQUIRED');
  if (status === 402 && paymentRequiredHeader) return true;
  if (status !== 402) return false;
  try {
    const parsed = JSON.parse(bodyText);
    return (
      parsed &&
      typeof parsed === 'object' &&
      Number(parsed.x402Version) >= 1 &&
      Array.isArray(parsed.accepts)
    );
  } catch {
    return false;
  }
}

function toHttpsUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function deriveA2AInvokeCandidates({ card, selectedEndpoint }) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  const base = toHttpsUrl(card.raw?.url) ?? toHttpsUrl(selectedEndpoint.url);
  if (!base) return candidates;

  push(base);

  const entrypoints = card.raw?.entrypoints;
  if (entrypoints && typeof entrypoints === 'object' && !Array.isArray(entrypoints)) {
    for (const key of Object.keys(entrypoints)) {
      try {
        push(new URL(`/entrypoints/${key}/invoke`, base).toString());
      } catch {}
    }
  }

  const skills = card.raw?.skills;
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object') continue;
      const id = typeof skill.id === 'string' && skill.id.trim() ? skill.id.trim() : undefined;
      if (!id) continue;
      try {
        push(new URL(`/entrypoints/${id}/invoke`, base).toString());
      } catch {}
    }
  }

  for (const profile of card.x402Payments) {
    if (typeof profile.endpoint === 'string') {
      const maybe = toHttpsUrl(profile.endpoint);
      if (maybe) push(maybe);
    }
  }

  return candidates;
}

function extractX402PaymentsFromCardRaw(rawCard) {
  const payments = Array.isArray(rawCard?.payments) ? rawCard.payments : [];
  const out = [];
  for (const payment of payments) {
    if (!payment || typeof payment !== 'object') continue;
    const method = typeof payment.method === 'string' ? payment.method : undefined;
    if (!method || method.toLowerCase() !== 'x402') continue;
    const extensions = payment.extensions && typeof payment.extensions === 'object' ? payment.extensions : {};
    const x402 = extensions.x402 && typeof extensions.x402 === 'object' ? extensions.x402 : {};
    out.push({
      method,
      payee: typeof payment.payee === 'string' ? payment.payee : undefined,
      network: typeof payment.network === 'string' ? payment.network : undefined,
      endpoint: typeof payment.endpoint === 'string' ? payment.endpoint : undefined,
      facilitatorUrl: typeof x402.facilitatorUrl === 'string' ? x402.facilitatorUrl : undefined
    });
  }
  return out;
}

async function fetchA2ACard(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return undefined;
    const parsed = await response.json().catch(() => undefined);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function probeCandidate(url) {
  const attempts = [
    { method: 'GET' },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ input: { question: 'x402 probe' } })
    }
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(url, attempt);
      const body = await response.text();
      if (hasX402Challenge(response.status, response.headers, body)) {
        return { kind: 'x402', method: attempt.method, status: response.status };
      }
      if (response.ok) {
        return { kind: 'free', method: attempt.method, status: response.status };
      }
    } catch {}
  }

  return { kind: 'unreachable' };
}

async function discoverPayableRouteForProfile(profile) {
  const orderedProtocols = ['a2a', 'web', 'mcp', 'oasf'];
  const services = [...profile.services].sort((a, b) => {
    const ai = orderedProtocols.indexOf(a.protocol);
    const bi = orderedProtocols.indexOf(b.protocol);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });

  for (const service of services) {
    const serviceUrl = service.url ? toHttpsUrl(service.url) : undefined;
    if (!serviceUrl) continue;

    if (service.protocol === 'a2a') {
      const cardRaw = await fetchA2ACard(serviceUrl);
      if (!cardRaw) continue;
      const cardLike = {
        raw: cardRaw,
        x402Payments: extractX402PaymentsFromCardRaw(cardRaw)
      };
      const candidates = deriveA2AInvokeCandidates({
        card: cardLike,
        selectedEndpoint: { protocol: 'a2a', url: serviceUrl }
      });
      for (const candidate of candidates) {
        const probe = await probeCandidate(candidate);
        console.log(
          `[discovery-probe] token=${profile.tokenId} protocol=a2a url=${candidate} kind=${probe.kind}${probe.status ? ` status=${probe.status}` : ''}`
        );
        if (probe.kind === 'x402') {
          return { invokeUrl: candidate, protocol: 'a2a' };
        }
      }
      continue;
    }

    const probe = await probeCandidate(serviceUrl);
    console.log(
      `[discovery-probe] token=${profile.tokenId} protocol=${service.protocol} url=${serviceUrl} kind=${probe.kind}${probe.status ? ` status=${probe.status}` : ''}`
    );
    if (probe.kind === 'x402') {
      return { invokeUrl: serviceUrl, protocol: service.protocol };
    }
  }

  return undefined;
}

async function discoverTokenIdFromDirectory(
  directoryClient,
  chainId,
  isTestnet,
  requirePayable,
  discoveredRouteByTokenId
) {
  const batch = await directoryClient.search({
    chainId,
    isTestnet,
    limit: 100,
    offset: 0
  });

  const ranked = batch
    .filter((profile) => profile.x402Supported === true)
    .filter((profile) => profile.services.some((service) => service.url))
    .sort((a, b) => {
      const aHasA2A = a.services.some((service) => service.protocol === 'a2a' && service.url) ? 1 : 0;
      const bHasA2A = b.services.some((service) => service.protocol === 'a2a' && service.url) ? 1 : 0;
      if (aHasA2A !== bHasA2A) return bHasA2A - aHasA2A;
      const aTrust = a.trust?.score ?? 0;
      const bTrust = b.trust?.score ?? 0;
      if (aTrust !== bTrust) return bTrust - aTrust;
      return String(a.tokenId).localeCompare(String(b.tokenId));
    });

  const chosen = ranked[0];
  if (!chosen) {
    return undefined;
  }

  if (!requirePayable) {
    return chosen.tokenId;
  }

  for (const profile of ranked) {
    const payable = await discoverPayableRouteForProfile(profile);
    if (!payable) continue;
    discoveredRouteByTokenId.set(profile.tokenId, payable);
    console.log(
      `[discovery] selected payable token=${profile.tokenId} protocol=${payable.protocol} invoke=${payable.invokeUrl}`
    );
    return profile.tokenId;
  }

  return undefined;
}

const sdk = new ShieldedClientSDK({
  endpoint: relayerEndpoint,
  signer: async (message) => account.signMessage({ message }),
  proofProvider: await createNoirJsProofProviderFromDefaultCircuit()
});

const wallet = await FileBackedWalletState.create({
  filePath: env.WALLET_STATE_PATH ?? './wallet-state.json',
  shieldedPoolAddress: env.SHIELDED_POOL_ADDRESS,
  ...(env.WALLET_INDEXER_URL ? { indexerGraphqlUrl: env.WALLET_INDEXER_URL } : {}),
  ...(env.POOL_RPC_URL ? { rpcUrl: env.POOL_RPC_URL } : {}),
  ...(env.POOL_FROM_BLOCK ? { startBlock: BigInt(env.POOL_FROM_BLOCK) } : {})
});

const providers = [];
if (env.ERC8004_ENVIO_GRAPHQL_URL) {
  providers.push(
    createEnvioGraphqlProvider({
      endpointUrl: env.ERC8004_ENVIO_GRAPHQL_URL
    })
  );
}
if (env.ERC8004_REGISTRY_ADDRESS && env.ERC8004_RPC_URL && env.ERC8004_CHAIN_ID) {
  providers.push(
    createOnchainRegistryProvider({
      registryByChain: {
        [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_REGISTRY_ADDRESS
      },
      rpcUrlByChain: {
        [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_RPC_URL
      }
    })
  );
}
if (env.ERC8004_SCAN_API_URL) {
  providers.push(
    createScanApiProvider({
      baseUrl: env.ERC8004_SCAN_API_URL
    })
  );
}

const directoryClient = providers.length > 0 ? createErc8004DirectoryClient({ providers }) : undefined;
const a2aInvokeUrl = env.A2A_INVOKE_URL;
const chainId = Number(env.ERC8004_CHAIN_ID ?? '84532');
const isTestnet = parseBoolean(env.ERC8004_IS_TESTNET, chainId !== 8453);
const requireA2AX402 = parseBoolean(env.A2A_REQUIRE_X402, true);
const discoveryRequirePayable = parseBoolean(env.DISCOVERY_REQUIRE_PAYABLE, true);
let discoveredTokenId = env.ERC8004_TOKEN_ID;
const discoveredRouteByTokenId = new Map();
let settlementApplied = false;
const agentPaymentFetch = createAgentPaymentFetch({
  sdk,
  relayerEndpoint,
  ...(directoryClient ? { directoryClient } : {}),
  onA2ACardResolved: async ({ selectedEndpoint, card }) => {
    console.log(
      `[a2a-card] endpoint=${selectedEndpoint.url ?? 'n/a'} name=${card.name ?? 'unknown'} x402Profiles=${card.x402Payments.length}`
    );
    for (const [index, payment] of card.x402Payments.entries()) {
      console.log(
        `[a2a-card:x402:${index}] payee=${payment.payee ?? 'n/a'} network=${payment.network ?? 'n/a'} facilitator=${payment.facilitatorUrl ?? payment.endpoint ?? 'n/a'}`
      );
    }
  },
  resolveA2AInvokeTarget: async ({ target, selectedEndpoint, card }) => {
    if (a2aInvokeUrl) return a2aInvokeUrl;
    const discovered = discoveredRouteByTokenId.get(target.tokenId);
    if (discovered?.invokeUrl && discovered.protocol === 'a2a') {
      return discovered.invokeUrl;
    }

    const candidates = deriveA2AInvokeCandidates({ selectedEndpoint, card });
    for (const candidate of candidates) {
      const probe = await probeCandidate(candidate);
      console.log(
        `[a2a-probe] url=${candidate} kind=${probe.kind}${probe.method ? ` method=${probe.method}` : ''}${probe.status ? ` status=${probe.status}` : ''}`
      );
      if (probe.kind === 'x402') {
        return candidate;
      }
    }

    if (requireA2AX402) {
      throw new Error(
        'discovered A2A endpoint did not expose an x402 challenge on tested invoke candidates'
      );
    }

    return undefined;
  },
  resolveContext: async ({ requirement }) => {
    const sync = await wallet.sync();
    const spendable = wallet
      .getNotes()
      .filter((note) => !note.spent && note.amount >= BigInt(requirement.amount))
      .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
    if (!spendable) {
      throw new Error(
        `no spendable note found | requirement.amount=${requirement.amount} | syncedTo=${sync.toBlock}`
      );
    }
    return wallet.getSpendContextByCommitment(spendable.commitment);
  },
  onRelayerSettlement: async ({ relayResponse, prepared }) => {
    await wallet.applyRelayerSettlement({
      settlementDelta: relayResponse.settlementDelta,
      changeNote: prepared.changeNote,
      changeNullifierSecret: prepared.changeNullifierSecret
    });
    settlementApplied = true;
    console.log(
      `[settlement] status=${relayResponse.status} settlementId=${relayResponse.settlementId} tx=${relayResponse.settlementTxHash ?? 'n/a'}`
    );
  }
});

if (!env.TARGET_URL && !discoveredTokenId && directoryClient) {
  discoveredTokenId = await discoverTokenIdFromDirectory(
    directoryClient,
    chainId,
    isTestnet,
    discoveryRequirePayable,
    discoveredRouteByTokenId
  );
  if (discoveredTokenId) {
    console.log(`[discovery] auto-selected ERC8004_TOKEN_ID=${discoveredTokenId}`);
  }
}

const discoveredRoute =
  !env.TARGET_URL && discoveredTokenId ? discoveredRouteByTokenId.get(discoveredTokenId) : undefined;

const target = env.TARGET_URL
  ? { type: 'url', url: env.TARGET_URL }
  : discoveredRoute?.invokeUrl
    ? { type: 'url', url: discoveredRoute.invokeUrl }
  : {
      type: 'erc8004',
      chainId,
      tokenId: discoveredTokenId
    };

if (discoveredRoute?.invokeUrl) {
  console.log(
    `[discovery] using payable invoke URL discovered via ERC-8004 token=${discoveredTokenId} protocol=${discoveredRoute.protocol}`
  );
}

if (!target.url && !target.tokenId) {
  throw new Error('Set TARGET_URL or ERC8004_TOKEN_ID');
}

const response = await agentPaymentFetch(target, { method: 'GET' });
const text = await response.text();
console.log(`[result] status=${response.status}`);
console.log(`[result] settlement-applied=${settlementApplied}`);
console.log(
  `[result] relayer-settlement-id=${response.headers.get('x-relayer-settlement-id') ?? 'n/a'}`
);
console.log(text);
