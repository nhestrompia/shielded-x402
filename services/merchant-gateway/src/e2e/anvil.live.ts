import {
  ShieldedClientSDK,
  buildWitnessFromCommitments,
  createShieldedFetch,
  deriveCommitment,
  deriveNullifier,
} from "@shielded-x402/client";
import { type Hex } from "@shielded-x402/shared-types";
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
  {
    type: "function",
    name: "isNullifierUsed",
    stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
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
  if (!gatewayUrl || !rpcUrl || !poolAddress || !payerPrivateKey) {
    throw new Error(
      "Missing E2E env: E2E_GATEWAY_URL, ANVIL_RPC_URL(or SEPOLIA_RPC_URL), SHIELDED_POOL_ADDRESS, E2E_PAYER_PRIVATE_KEY",
    );
  }

  const toWord = (value: bigint): Hex =>
    (`0x${value.toString(16).padStart(64, "0")}` as Hex);

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
  const note = {
    amount: 100n,
    rho: toWord(42n),
    pkHash: toWord(11n),
    commitment: deriveCommitment(100n, toWord(42n), toWord(11n)),
    leafIndex: 0,
  } as const;
  const witness = buildWitnessFromCommitments([note.commitment], 0);
  const nullifierSecret = toWord(9n);
  const expectedNullifier = deriveNullifier(nullifierSecret, note.commitment);
  if (latestRoot.toLowerCase() !== witness.root.toLowerCase()) {
    throw new Error(
      `fixture root mismatch: chain latestRoot=${latestRoot} witnessRoot=${witness.root}. ` +
        "Seed pool with fixture commitment before running anvil live test.",
    );
  }

  const account = privateKeyToAccount(payerPrivateKey);
  const sdk = new ShieldedClientSDK({
    endpoint: gatewayUrl.replace(/\/$/, ""),
    signer: async (message: string): Promise<string> =>
      account.signMessage({ message }),
  });
  const shieldedFetch = createShieldedFetch({
    sdk,
    resolveContext: async () => ({
      note,
      witness,
      nullifierSecret,
    }),
  });
  const retry = await shieldedFetch(`${gatewayUrl.replace(/\/$/, "")}/paid/data`, {
    method: "GET",
  });

  if (retry.status !== 200) {
    const body = await retry.text();
    throw new Error(`expected paid response 200, got ${retry.status}: ${body}`);
  }

  const body = await retry.json();
  if (!body.ok) {
    throw new Error("paid response body missing ok=true");
  }
  const nullifierUsed = await client.readContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: "isNullifierUsed",
    args: [expectedNullifier],
  });
  if (!nullifierUsed) {
    throw new Error("expected nullifier to be used after paid request settlement");
  }

  console.log("anvil live e2e passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
