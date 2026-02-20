import {
  CREDIT_EIP712_TYPES,
  buildCreditDebitIntentTypedDataPayload,
  buildCreditStateTypedDataPayload,
  type CreditDebitIntent,
  type CreditDomainResponse,
  type CreditState,
  type Hex
} from '@shielded-x402/shared-types';
import { recoverTypedDataAddress } from 'viem';

export interface CreditTypedDataSigner {
  signTypedData: (args: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Hex;
    };
    types: typeof CREDIT_EIP712_TYPES;
    primaryType: 'CreditState' | 'CreditDebitIntent';
    message:
      | ReturnType<typeof buildCreditStateTypedDataPayload>['message']
      | ReturnType<typeof buildCreditDebitIntentTypedDataPayload>['message'];
  }) => Promise<Hex>;
}

export async function signAgentCreditState(
  domain: CreditDomainResponse,
  state: CreditState,
  signer: CreditTypedDataSigner
): Promise<Hex> {
  const signature = await signer.signTypedData(buildCreditStateTypedDataPayload(domain, state));
  return signature.toLowerCase() as Hex;
}

export async function signDebitIntent(
  domain: CreditDomainResponse,
  intent: CreditDebitIntent,
  signer: CreditTypedDataSigner
): Promise<Hex> {
  const signature = await signer.signTypedData(
    buildCreditDebitIntentTypedDataPayload(domain, intent)
  );
  return signature.toLowerCase() as Hex;
}

export async function recoverCreditStateSigner(
  domain: CreditDomainResponse,
  state: CreditState,
  signature: Hex
): Promise<Hex> {
  const recovered = await recoverTypedDataAddress({
    ...buildCreditStateTypedDataPayload(domain, state),
    signature
  });
  return recovered.toLowerCase() as Hex;
}
