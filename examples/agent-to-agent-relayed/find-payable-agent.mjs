import 'dotenv/config';
import {
  createErc8004DirectoryClient,
  createEnvioGraphqlProvider,
  createOnchainRegistryProvider,
  createScanApiProvider
} from '@shielded-x402/erc8004-adapter';

const env = process.env;

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function toHttpsUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
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

async function fetchA2ACard(url) {
  try {
    const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    const parsed = await response.json().catch(() => undefined);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function extractX402PaymentsFromCardRaw(rawCard) {
  const payments = Array.isArray(rawCard?.payments) ? rawCard.payments : [];
  const out = [];
  for (const payment of payments) {
    if (!payment || typeof payment !== 'object') continue;
    const method = typeof payment.method === 'string' ? payment.method : undefined;
    if (!method || method.toLowerCase() !== 'x402') continue;
    const endpoint = typeof payment.endpoint === 'string' ? payment.endpoint : undefined;
    if (endpoint) out.push(endpoint);
    const facilitator = payment?.extensions?.x402?.facilitatorUrl;
    if (typeof facilitator === 'string') out.push(facilitator);
  }
  return out;
}

function deriveA2AInvokeCandidates(cardUrl, cardRaw) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  const base = toHttpsUrl(cardRaw?.url) ?? toHttpsUrl(cardUrl);
  if (!base) return candidates;
  push(base);

  const entrypoints = cardRaw?.entrypoints;
  if (entrypoints && typeof entrypoints === 'object' && !Array.isArray(entrypoints)) {
    for (const key of Object.keys(entrypoints)) {
      try {
        push(new URL(`/entrypoints/${key}/invoke`, base).toString());
      } catch {}
    }
  }

  const skills = cardRaw?.skills;
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== 'object') continue;
      const id = typeof skill.id === 'string' ? skill.id.trim() : '';
      if (!id) continue;
      try {
        push(new URL(`/entrypoints/${id}/invoke`, base).toString());
      } catch {}
    }
  }

  for (const maybe of extractX402PaymentsFromCardRaw(cardRaw)) {
    const normalized = toHttpsUrl(maybe);
    if (normalized) push(normalized);
  }
  return candidates;
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
    } catch {}
  }
  return { kind: 'none' };
}

const providers = [];
if (env.ERC8004_ENVIO_GRAPHQL_URL) {
  providers.push(createEnvioGraphqlProvider({ endpointUrl: env.ERC8004_ENVIO_GRAPHQL_URL }));
}
if (env.ERC8004_REGISTRY_ADDRESS && env.ERC8004_RPC_URL && env.ERC8004_CHAIN_ID) {
  providers.push(
    createOnchainRegistryProvider({
      registryByChain: { [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_REGISTRY_ADDRESS },
      rpcUrlByChain: { [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_RPC_URL }
    })
  );
}
if (env.ERC8004_SCAN_API_URL) {
  providers.push(createScanApiProvider({ baseUrl: env.ERC8004_SCAN_API_URL }));
}

if (providers.length === 0) {
  throw new Error('Set at least one provider env (ERC8004_ENVIO_GRAPHQL_URL / ERC8004_SCAN_API_URL / onchain)');
}

const directoryClient = createErc8004DirectoryClient({ providers });
const chainId = Number(env.ERC8004_CHAIN_ID ?? '84532');
const isTestnet = parseBoolean(env.ERC8004_IS_TESTNET, true);
const limit = Number(env.DISCOVERY_LIMIT ?? '100');
const rows = await directoryClient.search({ chainId, isTestnet, limit, offset: 0 });
const ranked = rows.filter((p) => p.x402Supported === true);

console.log(`[scan] candidates=${ranked.length} (x402Supported=true)`);

for (const profile of ranked) {
  for (const service of profile.services) {
    const url = toHttpsUrl(service.url);
    if (!url) continue;
    let candidates = [url];
    if (service.protocol === 'a2a') {
      const card = await fetchA2ACard(url);
      candidates = card ? deriveA2AInvokeCandidates(url, card) : [url];
    }
    for (const candidate of candidates) {
      const result = await probeCandidate(candidate);
      if (result.kind === 'x402') {
        console.log(
          `[found] tokenId=${profile.tokenId} protocol=${service.protocol} url=${candidate} method=${result.method} status=${result.status}`
        );
        process.exit(0);
      }
    }
  }
}

console.log('[found] none (no discovered endpoint returned a 402 x402 challenge)');
process.exit(1);
