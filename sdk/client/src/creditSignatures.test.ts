import {
  CREDIT_EIP712_TYPES,
  toCreditDebitIntentTypedData,
  toEip712Domain,
  type CreditDebitIntent,
  type CreditDomainResponse,
  type CreditState,
  type Hex
} from '@shielded-x402/shared-types';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  recoverCreditStateSigner,
  signAgentCreditState,
  signDebitIntent,
  type CreditTypedDataSigner
} from './creditSignatures.js';

const agentPrivateKey =
  '0x8b3a350cf5c34c9194ca3a545d83a16b5d2d1f8f907f4f7b2f5f1f5a8e8e8e8e' as Hex;

const domain: CreditDomainResponse = {
  name: 'shielded-x402-credit',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x0000000000000000000000000000000000000002',
  relayerAddress: '0x0000000000000000000000000000000000000003'
};

describe('creditSignatures', () => {
  it('signAgentCreditState and recoverCreditStateSigner match', async () => {
    const account = privateKeyToAccount(agentPrivateKey);
    const signer: CreditTypedDataSigner = {
      signTypedData: (args) => account.signTypedData(args)
    };
    const state: CreditState = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      seq: '7',
      available: '55',
      cumulativeSpent: '45',
      lastDebitDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updatedAt: '1700000000',
      agentAddress: account.address.toLowerCase() as Hex,
      relayerAddress: domain.relayerAddress
    };

    const signature = await signAgentCreditState(domain, state, signer);
    const recovered = await recoverCreditStateSigner(domain, state, signature);
    expect(recovered).toBe(account.address.toLowerCase());
  });

  it('signDebitIntent produces recoverable EIP-712 signature', async () => {
    const account = privateKeyToAccount(agentPrivateKey);
    const signer: CreditTypedDataSigner = {
      signTypedData: (args) => account.signTypedData(args)
    };

    const intent: CreditDebitIntent = {
      channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      prevStateHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      nextSeq: '8',
      amount: '10',
      merchantRequestHash:
        '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      deadline: '1700000200',
      requestId: 'credit-signatures-1'
    };

    const signature = await signDebitIntent(domain, intent, signer);
    const recovered = await recoverTypedDataAddress({
      domain: toEip712Domain(domain),
      types: CREDIT_EIP712_TYPES,
      primaryType: 'CreditDebitIntent',
      message: toCreditDebitIntentTypedData(intent),
      signature
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
