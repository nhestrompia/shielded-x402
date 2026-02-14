import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export interface WithdrawalSigner {
  address: Hex;
  signDigest: (digest: Hex) => Promise<Hex>;
}

export function createLocalWithdrawalSigner(privateKey: Hex): WithdrawalSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signDigest: async (digest) => {
      const signature = await account.signMessage({ message: { raw: digest } });
      return signature as Hex;
    }
  };
}
