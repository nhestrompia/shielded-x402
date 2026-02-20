import type { CreditChannelStatus, CreditState, Hex } from '@shielded-x402/shared-types';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { CreditSettlementAdapter } from './types.js';

const creditStateTupleComponents = [
  { name: 'channelId', type: 'bytes32' },
  { name: 'seq', type: 'uint64' },
  { name: 'available', type: 'uint256' },
  { name: 'cumulativeSpent', type: 'uint256' },
  { name: 'lastDebitDigest', type: 'bytes32' },
  { name: 'updatedAt', type: 'uint64' },
  { name: 'agentAddress', type: 'address' },
  { name: 'relayerAddress', type: 'address' }
] as const;

const signedCreditStateTupleComponents = [
  {
    name: 'state',
    type: 'tuple',
    components: creditStateTupleComponents
  },
  { name: 'agentSignature', type: 'bytes' },
  { name: 'relayerSignature', type: 'bytes' }
] as const;

const creditSettlementAbi = [
  {
    type: 'function',
    name: 'openOrTopup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'agent', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'startClose',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'signedState',
        type: 'tuple',
        components: signedCreditStateTupleComponents
      }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'challengeClose',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'signedState',
        type: 'tuple',
        components: signedCreditStateTupleComponents
      }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'finalizeClose',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'channels',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'exists', type: 'bool' },
      { name: 'closing', type: 'bool' },
      { name: 'agent', type: 'address' },
      { name: 'relayer', type: 'address' },
      { name: 'escrowed', type: 'uint256' },
      { name: 'closeSeq', type: 'uint64' },
      { name: 'challengeDeadline', type: 'uint64' },
      { name: 'closeAvailable', type: 'uint256' },
      { name: 'closeCumulativeSpent', type: 'uint256' },
      { name: 'closeLastDebitDigest', type: 'bytes32' },
      { name: 'closeUpdatedAt', type: 'uint64' }
    ]
  }
] as const;

const closeStartedEvent = parseAbiItem(
  'event CloseStarted(bytes32 indexed channelId, uint64 seq, uint64 challengeDeadline, uint256 available)'
);
const closeChallengedEvent = parseAbiItem(
  'event CloseChallenged(bytes32 indexed channelId, uint64 seq, uint64 challengeDeadline, uint256 available)'
);
const closeFinalizedEvent = parseAbiItem(
  'event CloseFinalized(bytes32 indexed channelId, uint64 seq, uint256 paidToAgent, uint256 paidToRelayer)'
);

export interface OnchainCreditSettlementConfig {
  rpcUrl: string;
  contractAddress: Hex;
  relayerPrivateKey: Hex;
}

function findContractEventArgs<TArgs>(
  receipt: { logs: ReadonlyArray<{ address: string; data: Hex; topics: readonly Hex[] }> },
  contractAddress: Hex,
  event: ReturnType<typeof parseAbiItem>
): TArgs | undefined {
  const expectedAddress = contractAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expectedAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: [event],
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]]
      });
      return decoded.args as TArgs;
    } catch {
      // ignore unrelated log
    }
  }
  return undefined;
}

function toSignedStateArg(state: {
  state: CreditState;
  agentSignature: Hex;
  relayerSignature: Hex;
}) {
  return {
    state: {
      channelId: state.state.channelId,
      seq: BigInt(state.state.seq),
      available: BigInt(state.state.available),
      cumulativeSpent: BigInt(state.state.cumulativeSpent),
      lastDebitDigest: state.state.lastDebitDigest,
      updatedAt: BigInt(state.state.updatedAt),
      agentAddress: state.state.agentAddress,
      relayerAddress: state.state.relayerAddress
    },
    agentSignature: state.agentSignature,
    relayerSignature: state.relayerSignature
  };
}

function assertTxSuccess(
  receipt: {
    status: string;
  },
  action: string,
  txHash: Hex
): void {
  if (receipt.status !== 'success') {
    throw new Error(`${action} reverted: ${txHash}`);
  }
}

export function createOnchainCreditSettlement(config: OnchainCreditSettlementConfig): CreditSettlementAdapter {
  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createPublicClient({
    transport: http(config.rpcUrl)
  });
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl)
  });

  return {
    openOrTopup: async ({ channelId, agentAddress, amount }) => {
      const txHash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: creditSettlementAbi,
        functionName: 'openOrTopup',
        chain: null,
        account,
        args: [channelId, agentAddress, amount]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertTxSuccess(receipt, 'openOrTopup', txHash);
      return { txHash };
    },
    startClose: async ({ signedState }) => {
      const txHash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: creditSettlementAbi,
        functionName: 'startClose',
        chain: null,
        account,
        args: [toSignedStateArg(signedState)]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertTxSuccess(receipt, 'startClose', txHash);
      const closeStartedArgs = findContractEventArgs<{ challengeDeadline: bigint }>(
        receipt,
        config.contractAddress,
        closeStartedEvent
      );
      const challengeDeadline = closeStartedArgs?.challengeDeadline ?? 0n;
      return { txHash, challengeDeadline };
    },
    challengeClose: async ({ signedState }) => {
      const txHash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: creditSettlementAbi,
        functionName: 'challengeClose',
        chain: null,
        account,
        args: [toSignedStateArg(signedState)]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertTxSuccess(receipt, 'challengeClose', txHash);
      const closeChallengedArgs = findContractEventArgs<{ challengeDeadline: bigint }>(
        receipt,
        config.contractAddress,
        closeChallengedEvent
      );
      const challengeDeadline = closeChallengedArgs?.challengeDeadline ?? 0n;
      return { txHash, challengeDeadline };
    },
    finalizeClose: async ({ channelId }) => {
      const txHash = await walletClient.writeContract({
        address: config.contractAddress,
        abi: creditSettlementAbi,
        functionName: 'finalizeClose',
        chain: null,
        account,
        args: [channelId]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertTxSuccess(receipt, 'finalizeClose', txHash);
      const closeFinalizedArgs = findContractEventArgs<{ paidToAgent: bigint; paidToRelayer: bigint }>(
        receipt,
        config.contractAddress,
        closeFinalizedEvent
      );
      return {
        txHash,
        paidToAgent: closeFinalizedArgs?.paidToAgent ?? 0n,
        paidToRelayer: closeFinalizedArgs?.paidToRelayer ?? 0n
      };
    },
    getChannel: async ({ channelId }) => {
      const raw = (await publicClient.readContract({
        address: config.contractAddress,
        abi: creditSettlementAbi,
        functionName: 'channels',
        args: [channelId]
      })) as readonly [
        boolean,
        boolean,
        Hex,
        Hex,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        Hex,
        bigint
      ];

      const [
        exists,
        closing,
        agent,
        relayer,
        escrowed,
        closeSeq,
        challengeDeadline,
        closeAvailable,
        closeCumulativeSpent,
        closeLastDebitDigest,
        closeUpdatedAt
      ] = raw;

      if (!exists) {
        return {
          channelId,
          exists: false,
          closing: false
        };
      }
      return {
        channelId,
        exists: true,
        closing,
        agentAddress: agent.toLowerCase() as Hex,
        relayerAddress: relayer.toLowerCase() as Hex,
        escrowed: escrowed.toString(),
        closeSeq: closeSeq.toString(),
        challengeDeadline: challengeDeadline.toString(),
        closeAvailable: closeAvailable.toString(),
        closeCumulativeSpent: closeCumulativeSpent.toString(),
        closeLastDebitDigest,
        closeUpdatedAt: closeUpdatedAt.toString()
      };
    }
  };
}
