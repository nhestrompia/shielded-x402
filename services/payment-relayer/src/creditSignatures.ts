import {
  buildCreditDebitIntentTypedDataPayload,
  buildCreditStateTypedDataPayload,
  type CreditDebitIntent,
  type CreditDomainResponse,
  type CreditState,
  type Hex
} from '@shielded-x402/shared-types';
import { hashMessage, recoverAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export async function recoverPayloadSigner(payloadJson: string, signature: Hex): Promise<Hex> {
  const hash = hashMessage(payloadJson);
  const recovered = await recoverAddress({
    hash,
    signature
  });
  return recovered.toLowerCase() as Hex;
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

export async function recoverCreditDebitSigner(
  domain: CreditDomainResponse,
  intent: CreditDebitIntent,
  signature: Hex
): Promise<Hex> {
  const recovered = await recoverTypedDataAddress({
    ...buildCreditDebitIntentTypedDataPayload(domain, intent),
    signature
  });
  return recovered.toLowerCase() as Hex;
}

export async function signCreditState(
  domain: CreditDomainResponse,
  state: CreditState,
  privateKey: Hex
): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData(buildCreditStateTypedDataPayload(domain, state));
  return signature.toLowerCase() as Hex;
}
