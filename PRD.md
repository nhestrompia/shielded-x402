⸻

Shielded x402 — PRD

Fully Anonymous Agent Payment Rail using Noir + x402 + ERC-8004

⸻

1. Overview

Shielded x402 is a privacy-preserving payment rail for the agentic web.

It extends the x402 HTTP payment standard by replacing transparent wallet-to-wallet transfers with fully shielded, unlinkable zero-knowledge payments similar to Zcash.

The system enables:
• Agents to pay for APIs and services
• Merchants to receive payment
• No public link between payer and merchant
• No onchain financial trail revealing strategy
• Full anonymity with optional selective disclosure

The architecture combines:
• Noir for zero-knowledge proof circuits
• x402 for HTTP-native payment negotiation
• ERC-8004 for decentralized agent discovery and trust
• A shielded pool contract for anonymous settlement

This is a privacy-first settlement layer for autonomous agents.

⸻

2. Problem Statement

Standard x402 payments are transparent.

Each API call leaves a public trail:

Agent Wallet → Amount → Merchant Wallet

This enables:
• Strategy leakage
• Competitive intelligence mapping
• Financial deanonymization
• Agent profiling
• Behavioral inference

For autonomous agents operating at scale, this is unacceptable.

Shielded x402 solves the privacy paradox of the agentic web:

Agents must pay — but their strategy must remain hidden.

⸻

3. Goals
   • Fully anonymous per-request payments
   • Unlinkable payer identity
   • No public wallet trail
   • x402-compatible HTTP flow
   • ZK-based double-spend prevention
   • Merchant verifiability of payment
   • Agent-native discovery using ERC-8004
   • Selective disclosure optional but not required

⸻

4. Non-Goals
   • Not a compliance-focused rail
   • Not KYC-integrated
   • Not a custodial system
   • Not a mixing service
   • Not a centralized privacy API

⸻

5. System Architecture

5.1 High-Level Layers

Layer 1 — Shielded Pool (Onchain)
• Deposit stablecoin (e.g., USDC)
• Mint shielded note
• Spend via zero-knowledge proof
• Prevent double-spend via nullifiers
• Allow merchant withdrawal

Layer 2 — x402 Payment Flow
• HTTP 402 challenge
• Merchant returns price + public key + challenge
• Client retries with shielded proof
• Merchant verifies proof + onchain inclusion

Layer 3 — ERC-8004 Identity Layer
• Agent identity registry
• Capability metadata
• Reputation scoring
• Optional validator attestations

⸻

6. Payment Flow

6.1 Funding Phase 1. Agent deposits stablecoin into shielded pool. 2. Pool emits commitment. 3. Agent receives secret note:
• amount
• randomness
• commitment index

No public link to agent identity beyond deposit.

⸻

6.2 API Request Phase 1. Agent calls API endpoint. 2. Server responds:

HTTP 402 Payment Required

Includes:
• price
• merchant_pubkey
• challenge_nonce
• rail: shielded-usdc

⸻

6.3 Shielded Payment Generation

Client generates:
• Zero-knowledge proof of note ownership
• Nullifier
• Merchant output commitment
• Encrypted memo binding payment to challenge

Proof verifies:
• Note exists in pool
• Note not previously spent
• Amount matches price
• Merchant output created

⸻

6.4 Retry Request

Agent retries API call with header:

X-PAYMENT: {
proof,
public_inputs,
nullifier,
merchant_commitment,
encrypted_receipt
}

⸻

6.5 Verification

Merchant: 1. Verifies ZK proof. 2. Checks nullifier uniqueness. 3. Confirms inclusion in shielded pool. 4. Validates challenge binding. 5. Serves API response.

⸻

6.6 Merchant Withdrawal

Merchant uses secret key to:
• Decrypt received note
• Withdraw funds from pool
• Maintain privacy

⸻

7. Privacy Model

Shielded x402 provides:
• Payer anonymity
• Unlinkable transactions
• Hidden balances
• Hidden merchant relationships
• No transaction graph visibility

Design modeled after:
• Zcash-style note commitments
• Nullifier sets
• Encrypted outputs

No public payment trail.

⸻

8. Zero-Knowledge Layer (Noir)

8.1 Circuits

spend.circuit

Inputs:
• note secret
• merkle proof
• nullifier key
• merchant public key
• amount
• challenge

Public outputs:
• nullifier hash
• merchant output commitment
• amount
• challenge hash

Constraints:
• Valid note
• Correct Merkle inclusion
• Nullifier correctly derived
• Not double-spent
• Output correctly formed

⸻

8.2 Double-Spend Prevention
• Nullifiers stored onchain
• Reuse invalidates proof
• Strict uniqueness enforcement

⸻

9. ERC-8004 Integration

9.1 Agent Identity Registry

Agents publish:
• Endpoint
• Public encryption key
• Capabilities
• Supported payment rails

9.2 Reputation Layer

Reputation can track:
• Successful settlements
• Disputes
• Service uptime
• Validator attestations

No identity deanonymization required.

⸻

10. Security Model

10.1 Threat Model

Strategy Surveillance

Prevented by:
• No wallet linkage
• No public recipient

Replay Attacks

Prevented by:
• Challenge binding
• Nullifier uniqueness

Double Spending

Prevented by:
• Nullifier registry

Merchant Fraud

Mitigated by:
• Receipt binding
• Optional attestation validators

⸻

10.2 Selective Disclosure (Optional)

Optional features:
• View keys
• Auditor keys
• Revenue proof export
• Dispute resolution proofs

Default mode is fully anonymous.

⸻

11. Chain Requirements
    • EVM-compatible
    • Cheap proof verification
    • Efficient calldata
    • Stablecoin support

Preferred:
• L2 with low gas for ZK verify

⸻

12. SDK Requirements

12.1 Client SDK

Functions:
• deposit()
• generateProof()
• pay()
• fetchWithShieldedPayment()

12.2 Merchant SDK

Functions:
• issue402()
• verifyProof()
• confirmSettlement()
• decryptAndWithdraw()

⸻

13. MVP Scope

MVP v0
• Shielded pool contract
• Noir spend circuit
• Proof generation
• Basic Express middleware
• Demo paid API endpoint

MVP v1
• Merchant withdrawal flow
• Receipt binding
• ERC-8004 integration
• Documentation + SDK

⸻

14. Risks
    • Regulatory scrutiny
    • ZK proving latency
    • Merchant UX friction
    • Proof verification cost
    • Early ecosystem adoption

⸻

15. Success Criteria
    • Agent can pay anonymously
    • Merchant verifies without knowing payer
    • No public wallet linkage
    • No double-spend
    • API integration simple
    • SDK adoption by agent builders

⸻

16. Future Extensions
    • Batch payments
    • Multi-call pre-funding
    • Cross-chain settlement
    • ZK-recursive proofs
    • Reputation-weighted merchant trust
    • Shielded subscription model
    • Private pay-per-inference for AI models

⸻

17. Positioning

Shielded x402 is:
• The privacy layer for the agent economy
• The Zcash of HTTP payments
• A drop-in shielded rail for x402
• The missing piece of autonomous financial privacy

⸻

If you want next step:

I can now give you:
• Contract architecture layout
• Noir circuit structure
• Folder layout for repo
• 8-week build roadmap
• Or brutally honest feasibility analysis
