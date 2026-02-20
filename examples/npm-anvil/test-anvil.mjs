import {
  ShieldedClientSDK,
  buildWitnessFromCommitments,
  createNoirJsProofProviderFromDefaultCircuit,
  deriveCommitment,
} from "@shielded-x402/client";
import { X402_HEADERS, parsePaymentRequiredHeader } from "@shielded-x402/shared-types";
import { privateKeyToAccount } from "viem/accounts";

const toWord = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

const gateway = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
const usePrefetch = process.env.PREFETCH_REQUIREMENT !== "false";
const payerPk =
  process.env.PAYER_PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const note = {
  amount: 100n,
  rho: toWord(42),
  pkHash: toWord(11),
  commitment: deriveCommitment(100n, toWord(42), toWord(11)),
  leafIndex: 0,
};

console.log("[1/5] Building witness");
const witness = buildWitnessFromCommitments([note.commitment], 0);
const account = privateKeyToAccount(payerPk);

console.log("[2/5] Initializing NoirJS proof provider (first run may take time)");
console.time("proofProviderInit");
const proofProvider = await createNoirJsProofProviderFromDefaultCircuit();
console.timeEnd("proofProviderInit");

console.log("[3/5] Creating SDK");
const sdk = new ShieldedClientSDK({
  endpoint: gateway,
  signer: (message) => account.signMessage({ message }),
  proofProvider,
});

console.log("[4/5] Preparing payment context");
let requirement;
if (usePrefetch) {
  console.log("Prefetch mode enabled: proof is prepared before the paid request");
  const requirementRes = await fetch(`${gateway}/x402/requirement`, { method: "GET" });
  if (!requirementRes.ok) {
    throw new Error(`prefetch failed: ${requirementRes.status}`);
  }
  const parsed = await requirementRes.json();
  requirement = parsed.requirement ?? null;
}

console.log(`[5/5] Requesting paid endpoint via ${gateway}/paid/data`);
const first = await fetch(`${gateway}/paid/data`, { method: "GET" });
if (first.status !== 402) {
  throw new Error(`expected 402, got ${first.status}`);
}
if (!requirement) {
  const header = first.headers.get(X402_HEADERS.paymentRequired);
  if (!header) {
    throw new Error(`missing ${X402_HEADERS.paymentRequired} header`);
  }
  requirement = parsePaymentRequiredHeader(header);
}
const prepared = await sdk.prepare402Payment(requirement, note, witness, toWord(9));
console.time("shieldedFetch");
const res = await fetch(`${gateway}/paid/data`, {
  method: "GET",
  headers: prepared.headers
});
console.timeEnd("shieldedFetch");
const body = await res.text();

console.log("status:", res.status);
console.log("body:", body);

if (res.status !== 200) {
  process.exit(1);
}
