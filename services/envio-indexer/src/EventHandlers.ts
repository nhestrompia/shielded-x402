/*
 * Please refer to https://docs.envio.dev for a thorough guide on all Envio indexer features
 */
import {
  ShieldedPool,
  ShieldedPool_Deposited,
  ShieldedPool_Spent,
  ShieldedPool_Withdrawn,
} from "generated";

ShieldedPool.Deposited.handler(async ({ event, context }) => {
  const entity: ShieldedPool_Deposited = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    commitment: event.params.commitment,
    leafIndex: event.params.leafIndex,
    root: event.params.root,
    amount: event.params.amount,
  };

  context.ShieldedPool_Deposited.set(entity);
});

ShieldedPool.Spent.handler(async ({ event, context }) => {
  const entity: ShieldedPool_Spent = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    nullifier: event.params.nullifier,
    merchantCommitment: event.params.merchantCommitment,
    changeCommitment: event.params.changeCommitment,
    amount: event.params.amount,
    challengeHash: event.params.challengeHash,
    merchantLeafIndex: event.params.merchantLeafIndex,
    changeLeafIndex: event.params.changeLeafIndex,
    newRoot: event.params.newRoot,
  };

  context.ShieldedPool_Spent.set(entity);
});

ShieldedPool.Withdrawn.handler(async ({ event, context }) => {
  const entity: ShieldedPool_Withdrawn = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    nullifier: event.params.nullifier,
    recipient: event.params.recipient,
    amount: event.params.amount,
    challengeNonce: event.params.challengeNonce,
  };

  context.ShieldedPool_Withdrawn.set(entity);
});
