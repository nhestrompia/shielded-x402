import {
  X402_HEADERS,
  type ShieldedPaymentResponse,
} from "@shielded-x402/shared-types";
import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

const poolAbi = [
  {
    type: "function",
    name: "latestRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

async function main(): Promise<void> {
  const gatewayUrl = process.env.E2E_GATEWAY_URL;
  const rpcUrl = process.env.ANVIL_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
  const poolAddress = process.env.SHIELDED_POOL_ADDRESS as
    | `0x${string}`
    | undefined;
  const payerPrivateKey = process.env.E2E_PAYER_PRIVATE_KEY as
    | `0x${string}`
    | undefined;
  const fixedNonce = process.env.FIXED_CHALLENGE_NONCE;
  const fixtureFile =
    process.env.E2E_PAYMENT_RESPONSE_FILE ??
    "/shielded-402/ops/fixtures/sepolia-payment-response.json";

  if (!gatewayUrl || !rpcUrl || !poolAddress || !payerPrivateKey) {
    throw new Error(
      "Missing E2E env: E2E_GATEWAY_URL, ANVIL_RPC_URL(or SEPOLIA_RPC_URL), SHIELDED_POOL_ADDRESS, E2E_PAYER_PRIVATE_KEY",
    );
  }

  const fixtureRaw = await readFile(fixtureFile, "utf8");
  const paymentResponse = JSON.parse(fixtureRaw) as ShieldedPaymentResponse;

  const client = createPublicClient({
    chain: anvil,
    transport: http(rpcUrl),
  });
  const latestRoot = await client.readContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: "latestRoot",
  });
  if (!latestRoot.startsWith("0x")) {
    throw new Error("invalid latestRoot response from chain");
  }
  if (latestRoot.toLowerCase() !== paymentResponse.root.toLowerCase()) {
    throw new Error(
      `fixture root mismatch: chain latestRoot=${latestRoot} fixtureRoot=${paymentResponse.root}. ` +
        "Seed pool with fixture commitment before running anvil live test.",
    );
  }

  const first = await fetch(`${gatewayUrl.replace(/\/$/, "")}/paid/data`);
  if (first.status !== 402) {
    throw new Error(`expected first status 402, got ${first.status}`);
  }

  const requirementHeader = first.headers.get(X402_HEADERS.paymentRequirement);
  if (!requirementHeader) {
    throw new Error(`missing ${X402_HEADERS.paymentRequirement} header`);
  }
  const requirement = JSON.parse(requirementHeader) as {
    challengeNonce: string;
  };

  if (
    fixedNonce &&
    requirement.challengeNonce.toLowerCase() !== fixedNonce.toLowerCase()
  ) {
    throw new Error(
      "challenge nonce mismatch; set FIXED_CHALLENGE_NONCE to fixture nonce",
    );
  }

  const account = privateKeyToAccount(payerPrivateKey);
  const payload = JSON.stringify(paymentResponse);
  const signature = await account.signMessage({ message: payload });

  const retry = await fetch(`${gatewayUrl.replace(/\/$/, "")}/paid/data`, {
    method: "GET",
    headers: {
      [X402_HEADERS.paymentResponse]: payload,
      [X402_HEADERS.paymentSignature]: signature,
      [X402_HEADERS.challengeNonce]: requirement.challengeNonce,
    },
  });

  if (retry.status !== 200) {
    const body = await retry.text();
    throw new Error(`expected paid response 200, got ${retry.status}: ${body}`);
  }

  const body = await retry.json();
  if (!body.ok) {
    throw new Error("paid response body missing ok=true");
  }

  console.log("anvil live e2e passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
