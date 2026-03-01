export function authIdToBytes(authIdHex: `0x${string}`): Uint8Array {
  const trimmed = authIdHex.slice(2);
  if (trimmed.length !== 64) {
    throw new Error('authIdHex must be 32-byte hex');
  }
  return Uint8Array.from(Buffer.from(trimmed, 'hex'));
}

export function u64ToLeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, value, true);
  return out;
}

export function buildPayAuthorizedData(input: {
  authIdHex: `0x${string}`;
  amountLamports: bigint;
  authExpiryUnix: bigint;
  proof: Uint8Array;
  publicWitness: Uint8Array;
}): Uint8Array {
  const authId = authIdToBytes(input.authIdHex);
  const amount = u64ToLeBytes(input.amountLamports);
  const expiry = u64ToLeBytes(input.authExpiryUnix);
  const out = new Uint8Array(32 + 8 + 8 + input.proof.length + input.publicWitness.length);

  out.set(authId, 0);
  out.set(amount, 32);
  out.set(expiry, 40);
  out.set(input.proof, 48);
  out.set(input.publicWitness, 48 + input.proof.length);
  return out;
}
