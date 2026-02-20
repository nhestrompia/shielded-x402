import {
  createCreditChannelClient,
  createCreditShieldedFetch,
  createProofProvider,
  FileBackedWalletState,
  ShieldedClientSDK,
} from "@shielded-x402/client";
import {
  createIndexerProvider,
  createErc8004DirectoryClient,
  createOnchainRegistryProvider,
  createScanApiProvider,
} from "@shielded-x402/erc8004-adapter";
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const relayerEndpoint = env.RELAYER_ENDPOINT ?? "http://127.0.0.1:3100";
const creditRelayerEndpoint = env.CREDIT_RELAYER_ENDPOINT ?? relayerEndpoint;
const payerPrivateKey = env.PAYER_PRIVATE_KEY;
if (!payerPrivateKey || !payerPrivateKey.startsWith("0x")) {
  throw new Error("PAYER_PRIVATE_KEY is required");
}

const account = privateKeyToAccount(payerPrivateKey);

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseBigInt(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim();
  if (normalized.length === 0) return fallback;
  return BigInt(normalized);
}

function hasX402Challenge(status, headers, bodyText) {
  const paymentRequiredHeader =
    headers.get("payment-required") ??
    headers.get("PAYMENT-REQUIRED") ??
    headers.get("x-payment-required") ??
    headers.get("X-PAYMENT-REQUIRED");
  if (status === 402 && paymentRequiredHeader) return true;
  if (status !== 402) return false;
  try {
    const parsed = JSON.parse(bodyText);
    return (
      parsed &&
      typeof parsed === "object" &&
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
    if (url.protocol === "http:") {
      url.protocol = "https:";
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
  if (
    entrypoints &&
    typeof entrypoints === "object" &&
    !Array.isArray(entrypoints)
  ) {
    for (const key of Object.keys(entrypoints)) {
      try {
        push(new URL(`/entrypoints/${key}/invoke`, base).toString());
      } catch {}
    }
  }

  const skills = card.raw?.skills;
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const id =
        typeof skill.id === "string" && skill.id.trim()
          ? skill.id.trim()
          : undefined;
      if (!id) continue;
      try {
        push(new URL(`/entrypoints/${id}/invoke`, base).toString());
      } catch {}
    }
  }

  for (const profile of card.x402Payments) {
    if (typeof profile.endpoint === "string") {
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
    if (!payment || typeof payment !== "object") continue;
    const method =
      typeof payment.method === "string" ? payment.method : undefined;
    if (!method || method.toLowerCase() !== "x402") continue;
    const extensions =
      payment.extensions && typeof payment.extensions === "object"
        ? payment.extensions
        : {};
    const x402 =
      extensions.x402 && typeof extensions.x402 === "object"
        ? extensions.x402
        : {};
    out.push({
      method,
      payee: typeof payment.payee === "string" ? payment.payee : undefined,
      network:
        typeof payment.network === "string" ? payment.network : undefined,
      endpoint:
        typeof payment.endpoint === "string" ? payment.endpoint : undefined,
      facilitatorUrl:
        typeof x402.facilitatorUrl === "string"
          ? x402.facilitatorUrl
          : undefined,
    });
  }
  return out;
}

async function fetchA2ACard(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const parsed = await response.json().catch(() => undefined);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function probeCandidate(url) {
  const attempts = [
    { method: "GET" },
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ input: { question: "x402 probe" } }),
    },
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(url, attempt);
      const body = await response.text();
      if (hasX402Challenge(response.status, response.headers, body)) {
        return {
          kind: "x402",
          method: attempt.method,
          status: response.status,
        };
      }
      if (response.ok) {
        return {
          kind: "free",
          method: attempt.method,
          status: response.status,
        };
      }
    } catch {}
  }

  return { kind: "unreachable" };
}

async function discoverPayableRouteForProfile(profile) {
  const orderedProtocols = ["a2a", "web", "mcp", "oasf"];
  const services = [...profile.services].sort((a, b) => {
    const ai = orderedProtocols.indexOf(a.protocol);
    const bi = orderedProtocols.indexOf(b.protocol);
    return (
      (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
      (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
    );
  });

  for (const service of services) {
    const serviceUrl = service.url ? toHttpsUrl(service.url) : undefined;
    if (!serviceUrl) continue;

    if (service.protocol === "a2a") {
      const cardRaw = await fetchA2ACard(serviceUrl);
      if (!cardRaw) continue;
      const cardLike = {
        raw: cardRaw,
        x402Payments: extractX402PaymentsFromCardRaw(cardRaw),
      };
      const candidates = deriveA2AInvokeCandidates({
        card: cardLike,
        selectedEndpoint: { protocol: "a2a", url: serviceUrl },
      });
      for (const candidate of candidates) {
        const probe = await probeCandidate(candidate);
        console.log(
          `[discovery-probe] token=${profile.tokenId} protocol=a2a url=${candidate} kind=${probe.kind}${probe.status ? ` status=${probe.status}` : ""}`,
        );
        if (probe.kind === "x402") {
          return { invokeUrl: candidate, protocol: "a2a" };
        }
      }
      continue;
    }

    const probe = await probeCandidate(serviceUrl);
    console.log(
      `[discovery-probe] token=${profile.tokenId} protocol=${service.protocol} url=${serviceUrl} kind=${probe.kind}${probe.status ? ` status=${probe.status}` : ""}`,
    );
    if (probe.kind === "x402") {
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
  discoveredRouteByTokenId,
) {
  const batch = await directoryClient.search({
    chainId,
    isTestnet,
    limit: 100,
    offset: 0,
  });

  const ranked = batch
    .filter((profile) => profile.x402Supported === true)
    .filter((profile) => profile.services.some((service) => service.url))
    .sort((a, b) => {
      const aHasA2A = a.services.some(
        (service) => service.protocol === "a2a" && service.url,
      )
        ? 1
        : 0;
      const bHasA2A = b.services.some(
        (service) => service.protocol === "a2a" && service.url,
      )
        ? 1
        : 0;
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
      `[discovery] selected payable token=${profile.tokenId} protocol=${payable.protocol} invoke=${payable.invokeUrl}`,
    );
    return profile.tokenId;
  }

  return undefined;
}

const wallet = await FileBackedWalletState.create({
  filePath: env.WALLET_STATE_PATH ?? "./wallet-state.json",
  shieldedPoolAddress: env.SHIELDED_POOL_ADDRESS,
  ...(env.WALLET_INDEXER_URL
    ? { indexerGraphqlUrl: env.WALLET_INDEXER_URL }
    : {}),
  ...(env.POOL_RPC_URL ? { rpcUrl: env.POOL_RPC_URL } : {}),
  ...(env.POOL_FROM_BLOCK ? { startBlock: BigInt(env.POOL_FROM_BLOCK) } : {}),
});

const providers = [];
if (env.ERC8004_ENVIO_GRAPHQL_URL) {
  providers.push(
    createIndexerProvider({
      endpointUrl: env.ERC8004_ENVIO_GRAPHQL_URL,
    }),
  );
}
if (
  env.ERC8004_REGISTRY_ADDRESS &&
  env.ERC8004_RPC_URL &&
  env.ERC8004_CHAIN_ID
) {
  providers.push(
    createOnchainRegistryProvider({
      registryByChain: {
        [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_REGISTRY_ADDRESS,
      },
      rpcUrlByChain: {
        [Number(env.ERC8004_CHAIN_ID)]: env.ERC8004_RPC_URL,
      },
    }),
  );
}
if (env.ERC8004_SCAN_API_URL) {
  providers.push(
    createScanApiProvider({
      baseUrl: env.ERC8004_SCAN_API_URL,
    }),
  );
}

const directoryClient =
  providers.length > 0
    ? createErc8004DirectoryClient({ providers })
    : undefined;
const chainId = Number(env.ERC8004_CHAIN_ID ?? "84532");
const isTestnet = parseBoolean(env.ERC8004_IS_TESTNET, chainId !== 8453);
const discoveryRequirePayable = parseBoolean(
  env.DISCOVERY_REQUIRE_PAYABLE,
  true,
);
let discoveredTokenId = env.ERC8004_TOKEN_ID;
const discoveredRouteByTokenId = new Map();

if (!env.TARGET_URL && !discoveredTokenId && directoryClient) {
  discoveredTokenId = await discoverTokenIdFromDirectory(
    directoryClient,
    chainId,
    isTestnet,
    discoveryRequirePayable,
    discoveredRouteByTokenId,
  );
  if (discoveredTokenId) {
    console.log(
      `[discovery] auto-selected ERC8004_TOKEN_ID=${discoveredTokenId}`,
    );
  }
}

const discoveredRoute =
  !env.TARGET_URL && discoveredTokenId
    ? discoveredRouteByTokenId.get(discoveredTokenId)
    : undefined;

const target = env.TARGET_URL
  ? { type: "url", url: env.TARGET_URL }
  : discoveredRoute?.invokeUrl
    ? { type: "url", url: discoveredRoute.invokeUrl }
    : {
        type: "erc8004",
        chainId,
        tokenId: discoveredTokenId,
      };

if (discoveredRoute?.invokeUrl) {
  console.log(
    `[discovery] using payable invoke URL discovered via ERC-8004 token=${discoveredTokenId} protocol=${discoveredRoute.protocol}`,
  );
}

if (!target.url && !target.tokenId) {
  throw new Error("Set TARGET_URL or ERC8004_TOKEN_ID");
}

if (!target.url) {
  throw new Error(
    "Credit flow requires a resolved URL target (set TARGET_URL or discover payable invoke URL)",
  );
}
const configuredChannelId = env.CREDIT_CHANNEL_ID?.trim();
if (configuredChannelId && !/^0x[0-9a-fA-F]{64}$/.test(configuredChannelId)) {
  throw new Error("If set, CREDIT_CHANNEL_ID must be a bytes32 hex string");
}

const shouldAutoTopup = parseBoolean(env.CREDIT_TOPUP_IF_MISSING, true);
const topupAmountMicros = parseBigInt(env.CREDIT_TOPUP_AMOUNT_MICROS, 1000000n);
const topupChallengeTtlSeconds = Number(
  env.CREDIT_TOPUP_CHALLENGE_TTL_SECONDS ?? "600",
);
const creditNetwork =
  env.CREDIT_NETWORK ?? `eip155:${env.ERC8004_CHAIN_ID ?? "84532"}`;
const creditAsset =
  env.CREDIT_ASSET ??
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const creditPayTo = env.CREDIT_PAY_TO ?? env.SHIELDED_POOL_ADDRESS;
const creditMerchantPubKey =
  env.CREDIT_MERCHANT_PUBKEY ??
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const creditVerifyingContract =
  env.CREDIT_VERIFYING_CONTRACT ?? env.SHIELDED_POOL_ADDRESS;

function isFieldSafeHex(value) {
  const BN254_FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  try {
    const n = BigInt(value);
    return n >= 0n && n < BN254_FIELD_MODULUS;
  } catch {
    return false;
  }
}

function parsePaymentSignatureHeader(rawHeader) {
  const decoded = Buffer.from(rawHeader, "base64").toString("utf8");
  const envelope = JSON.parse(decoded);
  if (
    !envelope ||
    envelope.x402Version !== 2 ||
    typeof envelope.signature !== "string"
  ) {
    throw new Error("invalid PAYMENT-SIGNATURE envelope");
  }
  return envelope;
}

async function ensureCreditState(creditClient) {
  const resolvedChannelId = await creditClient.getChannelId();
  console.log(
    `[credit] channelId=${resolvedChannelId}${configuredChannelId ? " (configured)" : " (derived)"}`,
  );
  const latest = creditClient.getLatestState();
  if (latest) {
    console.log(
      `[credit] existing channel state found seq=${latest.state.seq} available=${latest.state.available}`,
    );
    return resolvedChannelId;
  }

  if (!shouldAutoTopup) {
    throw new Error(
      "No existing credit state found and CREDIT_TOPUP_IF_MISSING=false. Top up manually first.",
    );
  }
  if (!creditPayTo || !creditPayTo.startsWith("0x")) {
    throw new Error(
      "CREDIT_PAY_TO (or SHIELDED_POOL_ADDRESS) is required for credit topup",
    );
  }
  if (!creditVerifyingContract || !creditVerifyingContract.startsWith("0x")) {
    throw new Error(
      "CREDIT_VERIFYING_CONTRACT (or SHIELDED_POOL_ADDRESS) is required for credit topup",
    );
  }

  const spendable = wallet
    .getNotes()
    .filter(
      (note) =>
        note.leafIndex >= 0 &&
        !note.spent &&
        note.amount >= topupAmountMicros &&
        isFieldSafeHex(note.rho) &&
        isFieldSafeHex(note.pkHash) &&
        isFieldSafeHex(note.nullifierSecret),
    )
    .sort((a, b) => b.leafIndex - a.leafIndex)[0];

  if (!spendable) {
    throw new Error(
      `No spendable note available for topup amount ${topupAmountMicros.toString()} micros. Run seed-note and sync wallet state.`,
    );
  }

  console.log(
    `[credit] no channel state found, topping up ${topupAmountMicros.toString()} micros from note ${spendable.commitment}`,
  );

  const sdk = new ShieldedClientSDK({
    endpoint: creditRelayerEndpoint,
    signer: (message) => account.signMessage({ message }),
    proofProvider: await createProofProvider({
      backendProofOptions: { verifierTarget: "evm" },
    }),
  });

  const spendContext = wallet.getSpendContextByCommitment(spendable.commitment);
  const challengeNonce = `0x${randomBytes(32).toString("hex")}`;
  const prepared = await sdk.prepare402Payment(
    {
      x402Version: 2,
      scheme: "exact",
      network: creditNetwork,
      asset: creditAsset,
      payTo: creditPayTo,
      rail: "shielded-usdc",
      amount: topupAmountMicros.toString(),
      challengeNonce,
      challengeExpiry: String(
        Math.floor(Date.now() / 1000) + topupChallengeTtlSeconds,
      ),
      merchantPubKey: creditMerchantPubKey,
      verifyingContract: creditVerifyingContract,
    },
    spendContext.note,
    spendContext.witness,
    spendContext.nullifierSecret,
  );

  const paymentHeader = prepared.headers.get("PAYMENT-SIGNATURE");
  if (!paymentHeader) {
    throw new Error("failed to build PAYMENT-SIGNATURE for topup");
  }
  const paymentEnvelope = parsePaymentSignatureHeader(paymentHeader);
  const topupResult = await creditClient.topup({
    requestId: `credit-topup-${Date.now()}`,
    paymentPayload: prepared.response,
    paymentPayloadSignature: paymentEnvelope.signature,
  });
  if (topupResult.status !== "DONE") {
    throw new Error(topupResult.failureReason ?? "credit topup failed");
  }

  await wallet.markNoteSpent(spendContext.note.commitment);
  await wallet.addOrUpdateNote(
    prepared.changeNote,
    prepared.changeNullifierSecret,
  );
  console.log(
    `[credit] topup complete seq=${topupResult.nextState?.seq ?? "n/a"} available=${topupResult.nextState?.available ?? "n/a"}`,
  );
  return resolvedChannelId;
}

const creditClient = createCreditChannelClient({
  relayerEndpoint: creditRelayerEndpoint,
  ...(configuredChannelId ? { channelId: configuredChannelId } : {}),
  agentAddress: account.address,
  signer: {
    signTypedData: (args) => account.signTypedData(args),
  },
  stateStore: wallet,
});
const resolvedChannelId = await ensureCreditState(creditClient);
const creditFetch = createCreditShieldedFetch({
  creditClient,
});
const response = await creditFetch(target.url, { method: "GET" });
const text = await response.text();
console.log(`[result] status=${response.status}`);
console.log(
  `[result] relayer-settlement-id=${response.headers.get("x-relayer-settlement-id") ?? "n/a"} channelId=${resolvedChannelId}`,
);
console.log(text);
