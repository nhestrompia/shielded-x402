import {
  CREDIT_EIP712_NAME,
  CREDIT_EIP712_VERSION,
  RELAYER_ROUTES,
  type CreditDomainResponse,
  type RelayerCreditCloseChallengeRequest,
  type RelayerCreditCloseFinalizeRequest,
  type RelayerCreditCloseStartRequest,
  type RelayerCreditPayRequest,
  type RelayerCreditTopupRequest,
} from "@shielded-x402/shared-types";
import { privateKeyToAccount } from "viem/accounts";
import { FileCreditChannelHeadStore } from "./creditHeadStore.js";
import { createCreditRelayerProcessor } from "./creditProcessor.js";
import { createOnchainCreditSettlement } from "./creditSettlement.js";
import {
  createForwardPayoutAdapter,
  createNoopPayoutAdapter,
  createPayaiX402ProviderAdapter,
  createX402PayoutAdapter,
} from "./payout.js";
import { createNoopSettlement, createOnchainSettlement } from "./settlement.js";
import { createAllowAllVerifier, createOnchainVerifier } from "./verifier.js";

function parseStaticHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("RELAYER_PAYOUT_HEADERS_JSON must be an object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapResultHandler<
  TBody,
  TResult extends { status: "DONE" | "FAILED" },
>(
  invalidMessage: string,
  handler: (body: TBody) => Promise<TResult>,
): express.RequestHandler {
  return async (req, res) => {
    try {
      const result = await handler(req.body as TBody);
      res.status(result.status === "DONE" ? 200 : 422).json(result);
    } catch (error) {
      res.status(400).json({
        error: invalidMessage,
        detail: errorDetail(error),
      });
    }
  };
}

function wrapJsonHandler(
  invalidMessage: string,
  handler: (req: express.Request) => Promise<unknown>,
): express.RequestHandler {
  return async (req, res) => {
    try {
      const result = await handler(req);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: invalidMessage,
        detail: errorDetail(error),
      });
    }
  };
}

const app = express();
app.use(express.json({ limit: "512kb" }));

const rpcUrl = process.env.RELAYER_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
const shieldedPoolAddress = process.env.SHIELDED_POOL_ADDRESS as
  | `0x${string}`
  | undefined;
const verifyingContractAddress = (process.env.RELAYER_VERIFYING_CONTRACT ??
  process.env.PAYMENT_VERIFYING_CONTRACT ??
  process.env.ULTRA_VERIFIER_ADDRESS) as `0x${string}` | undefined;
const relayerPrivateKey =
  (process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined) ??
  (process.env.PAYMENT_RELAYER_PRIVATE_KEY as `0x${string}` | undefined);
const payoutMode = process.env.RELAYER_PAYOUT_MODE ?? "forward";
const staticPayoutHeaders = parseStaticHeaders(
  process.env.RELAYER_PAYOUT_HEADERS_JSON,
);
const relayerX402RpcUrl =
  process.env.RELAYER_X402_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL;
const relayerX402PrivateKey =
  (process.env.RELAYER_X402_PRIVATE_KEY as `0x${string}` | undefined) ??
  relayerPrivateKey;
const relayerX402Chain = (process.env.RELAYER_X402_CHAIN ?? "base-sepolia") as
  | "base-sepolia"
  | "sepolia";
const disablePreverify =
  (process.env.RELAYER_DISABLE_PREVERIFY ?? "false").toLowerCase() === "true";
const relayerChainId = Number(process.env.RELAYER_CHAIN_ID ?? "84532");
const creditSettlementRpcUrl = process.env.CREDIT_SETTLEMENT_RPC_URL ?? rpcUrl;
const creditSettlementContract = process.env.CREDIT_SETTLEMENT_CONTRACT as
  | `0x${string}`
  | undefined;
const creditHeadStorePath =
  process.env.RELAYER_CREDIT_HEAD_STORE_PATH ??
  "/tmp/shielded-x402-credit-heads.json";
const relayerShieldedVerifyingContract = (creditSettlementContract ??
  process.env.RELAYER_SHIELDED_VERIFYING_CONTRACT ??
  shieldedPoolAddress ??
  "0x2222222222222222222222222222222222222222") as `0x${string}`;

if (!relayerPrivateKey) {
  throw new Error(
    "RELAYER_PRIVATE_KEY (or PAYMENT_RELAYER_PRIVATE_KEY) is required for credit mode",
  );
}
if (!Number.isFinite(relayerChainId)) {
  throw new Error("RELAYER_CHAIN_ID must be a finite number");
}

const verifier =
  !disablePreverify && rpcUrl && shieldedPoolAddress && verifyingContractAddress
    ? createOnchainVerifier({
        rpcUrl,
        shieldedPoolAddress,
        ultraVerifierAddress: verifyingContractAddress,
      })
    : createAllowAllVerifier();

const settlement =
  rpcUrl && shieldedPoolAddress && relayerPrivateKey
    ? createOnchainSettlement({
        rpcUrl,
        shieldedPoolAddress,
        relayerPrivateKey,
      })
    : createNoopSettlement();

const payout =
  payoutMode === "noop"
    ? createNoopPayoutAdapter()
    : payoutMode === "x402"
      ? (() => {
          if (!relayerX402RpcUrl || !relayerX402PrivateKey) {
            throw new Error(
              "RELAYER_PAYOUT_MODE=x402 requires RELAYER_X402_RPC_URL(or BASE_SEPOLIA_RPC_URL) and RELAYER_X402_PRIVATE_KEY(or RELAYER_PRIVATE_KEY)",
            );
          }
          return createX402PayoutAdapter({
            rpcUrl: relayerX402RpcUrl,
            privateKey: relayerX402PrivateKey,
            chain: relayerX402Chain,
            staticHeaders: staticPayoutHeaders,
            providerAdapters: [createPayaiX402ProviderAdapter()],
          });
        })()
      : createForwardPayoutAdapter({
          staticHeaders: staticPayoutHeaders,
        });

const creditDomain: CreditDomainResponse = {
  name: CREDIT_EIP712_NAME,
  version: CREDIT_EIP712_VERSION,
  chainId: relayerChainId,
  verifyingContract: relayerShieldedVerifyingContract,
  relayerAddress: privateKeyToAccount(
    relayerPrivateKey,
  ).address.toLowerCase() as `0x${string}`,
};

const creditProcessor = createCreditRelayerProcessor({
  verifier,
  settlement,
  payout,
  headStore: new FileCreditChannelHeadStore(creditHeadStorePath),
  ...(creditSettlementRpcUrl && creditSettlementContract
    ? {
        creditSettlement: createOnchainCreditSettlement({
          rpcUrl: creditSettlementRpcUrl,
          contractAddress: creditSettlementContract,
          relayerPrivateKey,
        }),
      }
    : {}),
  creditDomain,
  relayerPrivateKey,
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    onchainVerifierEnabled: Boolean(
      !disablePreverify &&
      rpcUrl &&
      shieldedPoolAddress &&
      verifyingContractAddress,
    ),
    preverifyDisabled: disablePreverify,
    verifierContractAddress: verifyingContractAddress ?? null,
    onchainSettlementEnabled: Boolean(
      rpcUrl && shieldedPoolAddress && relayerPrivateKey,
    ),
    payoutMode,
    x402PayoutEnabled: payoutMode === "x402",
    creditEnabled: true,
    creditDomain,
    creditSettlementEnabled: Boolean(
      creditSettlementRpcUrl && creditSettlementContract,
    ),
    creditSettlementContract: creditSettlementContract ?? null,
    creditHeadStorePath,
  });
});

app.post(RELAYER_ROUTES.creditDomain, async (_req, res) => {
  res.json(creditProcessor.domain());
});

app.post(
  RELAYER_ROUTES.creditTopup,
  wrapResultHandler<
    RelayerCreditTopupRequest,
    Awaited<ReturnType<typeof creditProcessor.handleTopup>>
  >("invalid credit topup request", (body) =>
    creditProcessor.handleTopup(body),
  ),
);

app.post(
  RELAYER_ROUTES.creditPay,
  wrapResultHandler<
    RelayerCreditPayRequest,
    Awaited<ReturnType<typeof creditProcessor.handlePay>>
  >("invalid credit pay request", (body) => creditProcessor.handlePay(body)),
);

app.post(
  RELAYER_ROUTES.creditCloseStart,
  wrapResultHandler<
    RelayerCreditCloseStartRequest,
    Awaited<ReturnType<typeof creditProcessor.handleCloseStart>>
  >("invalid credit close start request", (body) =>
    creditProcessor.handleCloseStart(body),
  ),
);

app.post(
  RELAYER_ROUTES.creditCloseChallenge,
  wrapResultHandler<
    RelayerCreditCloseChallengeRequest,
    Awaited<ReturnType<typeof creditProcessor.handleCloseChallenge>>
  >("invalid credit close challenge request", (body) =>
    creditProcessor.handleCloseChallenge(body),
  ),
);

app.post(
  RELAYER_ROUTES.creditCloseFinalize,
  wrapResultHandler<
    RelayerCreditCloseFinalizeRequest,
    Awaited<ReturnType<typeof creditProcessor.handleCloseFinalize>>
  >("invalid credit close finalize request", (body) =>
    creditProcessor.handleCloseFinalize(body),
  ),
);

app.get(
  `${RELAYER_ROUTES.creditCloseStatusPrefix}/:channelId`,
  wrapJsonHandler("invalid credit close status request", async (req) => {
    const channelId = req.params.channelId as `0x${string}`;
    return creditProcessor.getCloseStatus(channelId);
  }),
);

const port = Number(process.env.RELAYER_PORT ?? 3100);
app.listen(port, () => {
  console.log(`payment-relayer listening on ${port}`);
});
