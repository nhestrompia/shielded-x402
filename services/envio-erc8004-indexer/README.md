# Envio ERC-8004 Indexer

Indexes ERC-8004 Identity + Reputation registries into a single queryable `AgentIndexProfile` model.

## What this indexes

- Identity:
  - `Transfer` (owner changes)
  - `Registered` (token URI + owner)
  - `URIUpdated` (token URI updates)
  - `MetadataSet` (selected key updates like `agentWallet`, `x402Support`, `name`)
- Reputation:
  - `NewFeedback`
  - `FeedbackRevoked`

The handler also parses inline `data:application/json;base64,...` token URIs to extract:
- `name`, `description`, `image`, `active`, `x402Support`, `supportedTrust`
- service endpoints (`a2a`, `mcp`, `web`, `oasf`, `did`, `ens`, `email`)

## Run locally

```bash
cd /Users/nhestrompia/Projects/shielded-402/services/envio-erc8004-indexer
pnpm install
pnpm codegen
pnpm dev
```

`pnpm codegen` now also installs dependencies for the generated Envio runtime package (`./generated`) so `ts-node` is available when the indexer starts.

GraphQL Playground typically runs at `http://localhost:8080`.

## Hosted deployment

Use Envio hosted deployment and set:
- `Indexer Directory`: `services/envio-erc8004-indexer`
- `Config File`: `config.yaml`

## Example GraphQL query

```graphql
query Agent($chainId: BigInt!, $tokenId: BigInt!) {
  agentIndexProfiles(
    where: { chainId: { _eq: $chainId }, tokenId: { _eq: $tokenId } }
    limit: 1
  ) {
    chainId
    tokenId
    owner
    agentWallet
    tokenURI
    name
    description
    imageUrl
    x402Supported
    supportedTrust
    a2aEndpoint
    mcpEndpoint
    webEndpoint
    oasfEndpoint
    didIdentifier
    ensIdentifier
    emailIdentifier
    feedbackCount
    feedbackScoreSum
    feedbackRevokedCount
    validationCount
    successfulValidationCount
    updatedAt
  }
}
```

## Notes

- This scaffold is currently configured for Base Sepolia only (`chainId=84532`).
- If your registry addresses differ, update `config.yaml`.
- Validation registry events are intentionally not indexed here yet because implementations vary more across deployments.
