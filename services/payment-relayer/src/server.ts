import dns from 'node:dns/promises';
import express from 'express';
import {
  RELAYER_ROUTES_V1,
  SEQUENCER_ROUTES_V1,
  type ExecutionReportV1,
  type Hex,
  type RelayPayRequestV1,
  type RelayPayResponseV1
} from '@shielded-x402/shared-types';
import { normalizeHex } from '@shielded-x402/shared-types';
import { deriveExecutionTxHash, isPrivateIp, isRelayCallerAuthorized } from './lib.js';
import { parseRelayPayRequest } from './validation.js';
import {
  createEd25519PrivateKeyFromSeed,
  createExecutionReport,
  parsePrivateSeed,
  parseSequencerKeyMap,
  verifySequencerSignature
} from './crypto.js';

const ZERO_HASH = (`0x${'00'.repeat(32)}` as Hex);

interface RelayMetrics {
  relayPayRequestsTotal: number;
  relayPayFailuresTotal: number;
  sequencerReportRetriesTotal: number;
  startedAtSeconds: number;
}

const metrics: RelayMetrics = {
  relayPayRequestsTotal: 0,
  relayPayFailuresTotal: 0,
  sequencerReportRetriesTotal: 0,
  startedAtSeconds: Math.floor(Date.now() / 1000)
};

async function runtimeImport(moduleName: string): Promise<any> {
  return import(moduleName);
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function formatFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const contextLogs = (error as Error & { context?: { logs?: string[] } }).context?.logs;
    if (Array.isArray(contextLogs) && contextLogs.length > 0) {
      return `${error.message}; logs=${contextLogs.slice(-3).join(' | ')}`;
    }
    return error.message;
  }
  return String(error);
}

function sanitizeEvmPrivateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isValidEvmPrivateKey(raw: string | undefined): boolean {
  const sanitized = sanitizeEvmPrivateKey(raw);
  if (!sanitized) return false;
  return /^0x[0-9a-fA-F]{64}$/.test(sanitized);
}

function keyPreview(value: string | undefined): string {
  if (!value) return 'none';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parseStaticHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RELAYER_PAYOUT_HEADERS_JSON must be an object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function parseAllowedHosts(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
  );
}

async function assertSafeMerchantUrl(urlRaw: string, allowedHosts: Set<string>): Promise<void> {
  const parsed = new URL(urlRaw);
  if (parsed.protocol.toLowerCase() !== 'https:') {
    throw new Error('merchant URL must use https');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) {
    throw new Error('merchant URL hostname is not allowed');
  }
  if (allowedHosts.size > 0 && !allowedHosts.has(host)) {
    throw new Error('merchant hostname not in allowlist');
  }

  const resolved = await dns.lookup(host, { all: true });
  if (resolved.length === 0) {
    throw new Error('merchant hostname failed DNS resolution');
  }
  for (const entry of resolved) {
    if (isPrivateIp(entry.address)) {
      throw new Error('merchant hostname resolves to private/internal IP');
    }
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error('merchant response exceeded max allowed size');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function executeMerchantRequest(input: {
  request: RelayPayRequestV1['merchantRequest'];
  staticHeaders: Record<string, string>;
  payoutMode: 'forward' | 'noop' | 'solana' | 'evm';
  allowedHosts: Set<string>;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<{ status: number; headers: Record<string, string>; bodyBase64: string }> {
  if (input.payoutMode === 'noop') {
    const payload = Buffer.from(JSON.stringify({ ok: true, mode: 'noop' }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyBase64: payload.toString('base64')
    };
  }

  if (input.payoutMode === 'solana') {
    if (!input.request.bodyBase64) {
      throw new Error('solana payout mode requires merchantRequest.bodyBase64 payload');
    }
    const payload = JSON.parse(Buffer.from(input.request.bodyBase64, 'base64').toString('utf8')) as {
      rpcUrl: string;
      wsUrl: string;
      gatewayProgramId: string;
      verifierProgramId: string;
      stateAccount: string;
      recipient: string;
      amountLamports: string;
      computeUnits?: string | number;
      authIdHex: Hex;
      authExpiryUnix: string;
      proofBase64: string;
      publicWitnessBase64: string;
      payerKeypairPath: string;
    };
    const required = [
      'rpcUrl',
      'wsUrl',
      'gatewayProgramId',
      'verifierProgramId',
      'stateAccount',
      'recipient',
      'amountLamports',
      'authIdHex',
      'authExpiryUnix',
      'proofBase64',
      'publicWitnessBase64',
      'payerKeypairPath'
    ] as const;
    for (const field of required) {
      const value = payload[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`solana merchant payload missing field: ${field}`);
      }
    }

    const computeUnits =
      payload.computeUnits === undefined
        ? Number(process.env.SOLANA_COMPUTE_UNITS_LIMIT ?? 1_000_000)
        : Number(payload.computeUnits);
    if (!Number.isFinite(computeUnits) || computeUnits <= 0) {
      throw new Error('solana computeUnits must be a positive number');
    }

    const adapterModule = await runtimeImport('../../../chains/solana/client/adapter.ts');
    const result = await adapterModule.submitPayAuthorized({
      rpcUrl: payload.rpcUrl,
      wsUrl: payload.wsUrl,
      gatewayProgramId: payload.gatewayProgramId,
      verifierProgramId: payload.verifierProgramId,
      stateAccount: payload.stateAccount,
      recipient: payload.recipient,
      amountLamports: BigInt(payload.amountLamports),
      computeUnits,
      authIdHex: payload.authIdHex,
      authExpiryUnix: BigInt(payload.authExpiryUnix),
      proof: Uint8Array.from(Buffer.from(payload.proofBase64, 'base64')),
      publicWitness: Uint8Array.from(Buffer.from(payload.publicWitnessBase64, 'base64')),
      payerKeypairPath: payload.payerKeypairPath
    });

    const responseBody = Buffer.from(JSON.stringify({ txSignature: result.txSignature }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyBase64: responseBody.toString('base64')
    };
  }

  if (input.payoutMode === 'evm') {
    if (!input.request.bodyBase64) {
      throw new Error('evm payout mode requires merchantRequest.bodyBase64 payload');
    }
    const payload = JSON.parse(Buffer.from(input.request.bodyBase64, 'base64').toString('utf8')) as {
      rpcUrl: string;
      recipient: string;
      amountWei: string;
      chainId?: string | number;
      privateKey?: string;
    };
    const required = ['rpcUrl', 'recipient', 'amountWei'] as const;
    for (const field of required) {
      const value = payload[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`evm merchant payload missing field: ${field}`);
      }
    }

    const payloadPrivateKey = sanitizeEvmPrivateKey(payload.privateKey);
    const envPrivateKey = sanitizeEvmPrivateKey(process.env.RELAYER_EVM_PRIVATE_KEY);
    const payloadKeyValid = isValidEvmPrivateKey(payload.privateKey);
    const envKeyValid = isValidEvmPrivateKey(process.env.RELAYER_EVM_PRIVATE_KEY);

    let privateKey: string | undefined;
    let keySource: 'payload' | 'env' | 'none' = 'none';
    if (payloadPrivateKey && payloadKeyValid) {
      privateKey = payloadPrivateKey;
      keySource = 'payload';
    } else if (envPrivateKey && envKeyValid) {
      privateKey = envPrivateKey;
      keySource = 'env';
    }

    if (!privateKey) {
      throw new Error(
        `evm private key unavailable/invalid (payloadValid=${payloadKeyValid} payloadLen=${payloadPrivateKey?.length ?? 0} payloadPreview=${keyPreview(payloadPrivateKey)} envValid=${envKeyValid} envLen=${envPrivateKey?.length ?? 0} envPreview=${keyPreview(envPrivateKey)})`
      );
    }

    const chainId =
      payload.chainId === undefined ? undefined : Number(typeof payload.chainId === 'string' ? payload.chainId.trim() : payload.chainId);
    if (chainId !== undefined && (!Number.isInteger(chainId) || chainId <= 0)) {
      throw new Error('evm chainId must be a positive integer');
    }

    const adapterModule = await runtimeImport('../../../chains/base/client/adapter.ts');
    let result: { txHash: string };
    try {
      result = await adapterModule.submitEvmNativeTransfer({
        rpcUrl: payload.rpcUrl,
        privateKey,
        recipient: payload.recipient,
        amountWei: BigInt(payload.amountWei),
        chainId
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `evm transfer failed (keySource=${keySource} keyLen=${privateKey.length} keyPreview=${keyPreview(privateKey)} chainId=${chainId ?? 'none'} rpcUrl=${payload.rpcUrl}): ${reason}`
      );
    }

    const responseBody = Buffer.from(JSON.stringify({ txHash: result.txHash }));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyBase64: responseBody.toString('base64')
    };
  }

  await assertSafeMerchantUrl(input.request.url, input.allowedHosts);

  const method = input.request.method.toUpperCase();
  if (method.length === 0) {
    throw new Error('merchantRequest.method is required');
  }
  const unsafeHeaderKeys = new Set(['host', 'connection', 'content-length']);
  const sanitizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.request.headers ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (unsafeHeaderKeys.has(normalized)) continue;
    sanitizedHeaders[normalized] = value;
  }
  for (const [key, value] of Object.entries(input.staticHeaders)) {
    sanitizedHeaders[key.toLowerCase()] = value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('merchant request timeout'), input.timeoutMs);
  try {
    const init: RequestInit = {
      method,
      headers: sanitizedHeaders,
      signal: controller.signal
    };
    if (method !== 'GET' && method !== 'HEAD' && input.request.bodyBase64) {
      init.body = Buffer.from(input.request.bodyBase64, 'base64');
    }
    const response = await fetch(input.request.url, init);
    const body = await readLimitedBody(response, input.maxResponseBytes);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return {
      status: response.status,
      headers: responseHeaders,
      bodyBase64: Buffer.from(body).toString('base64')
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function reportExecution(input: {
  sequencerUrl: string;
  report: ExecutionReportV1;
}): Promise<void> {
  const response = await fetch(`${input.sequencerUrl}${SEQUENCER_ROUTES_V1.executions}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.report)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `sequencer execution report failed (${response.status}) chainRef=${input.report.chainRef} relayerKeyId=${input.report.relayerKeyId}: ${text}`
    );
  }
}

function createRateLimiter(maxPerMinute: number): express.RequestHandler {
  const counters = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    const now = Date.now();
    const current = counters.get(ip);
    if (!current || now > current.resetAt) {
      counters.set(ip, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (current.count >= maxPerMinute) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }
    current.count += 1;
    counters.set(ip, current);
    next();
  };
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const port = Number(process.env.RELAYER_PORT ?? '3100');
  const chainRef = process.env.RELAYER_CHAIN_REF;
  const sequencerUrl = process.env.RELAYER_SEQUENCER_URL;
  const payoutMode = (process.env.RELAYER_PAYOUT_MODE ?? 'forward') as
    | 'forward'
    | 'noop'
    | 'solana'
    | 'evm';
  const staticHeaders = parseStaticHeaders(process.env.RELAYER_PAYOUT_HEADERS_JSON);
  const sequencerKeyMap = parseSequencerKeyMap(process.env.RELAYER_SEQUENCER_KEYS_JSON);
  const relayerKeyId = process.env.RELAYER_KEY_ID ?? 'relayer-key-1';
  const relayerPrivateKey = createEd25519PrivateKeyFromSeed(
    parsePrivateSeed(process.env.RELAYER_REPORTING_PRIVATE_KEY)
  );
  const allowedHosts = parseAllowedHosts(process.env.RELAYER_ALLOWED_HOSTS);
  const timeoutMs = Number(process.env.RELAYER_MERCHANT_TIMEOUT_MS ?? '5000');
  const maxResponseBytes = Number(process.env.RELAYER_MAX_RESPONSE_BYTES ?? '1048576');
  const rateLimitPerMinute = Number(process.env.RELAYER_RATE_LIMIT_PER_MINUTE ?? '180');
  const callerAuthToken = process.env.RELAYER_CALLER_AUTH_TOKEN;
  const evmPrivateKeyValid = isValidEvmPrivateKey(process.env.RELAYER_EVM_PRIVATE_KEY);
  const evmPrivateKeySanitized = sanitizeEvmPrivateKey(process.env.RELAYER_EVM_PRIVATE_KEY);

  if (!chainRef) throw new Error('RELAYER_CHAIN_REF is required');
  if (!sequencerUrl) throw new Error('RELAYER_SEQUENCER_URL is required');
  if (
    payoutMode !== 'forward' &&
    payoutMode !== 'noop' &&
    payoutMode !== 'solana' &&
    payoutMode !== 'evm'
  ) {
    throw new Error('RELAYER_PAYOUT_MODE must be forward|noop|solana|evm');
  }
  if (payoutMode === 'evm' && !evmPrivateKeyValid) {
    throw new Error('RELAYER_EVM_PRIVATE_KEY missing or invalid for evm payout mode');
  }
  app.use(createRateLimiter(Math.max(rateLimitPerMinute, 1)));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      chainRef,
      sequencerUrl,
      payoutMode,
      knownSequencerKeyIds: Object.keys(sequencerKeyMap),
      evmKeyConfigured: Boolean(sanitizeEvmPrivateKey(process.env.RELAYER_EVM_PRIVATE_KEY)),
      evmKeyValid: evmPrivateKeyValid
    });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      const health = await fetch(`${sequencerUrl}/health`, { method: 'GET' });
      const ready = health.ok;
      res.status(ready ? 200 : 503).json({
        ok: ready,
        chainRef,
        sequencerReachable: health.ok
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        chainRef,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/metrics', (_req, res) => {
    const uptimeSeconds = Math.floor(Date.now() / 1000) - metrics.startedAtSeconds;
    res.json({
      relay_pay_requests_total: metrics.relayPayRequestsTotal,
      relay_pay_failures_total: metrics.relayPayFailuresTotal,
      sequencer_report_retries_total: metrics.sequencerReportRetriesTotal,
      uptime_seconds: uptimeSeconds
    });
  });

  app.post(RELAYER_ROUTES_V1.pay, async (req, res) => {
    metrics.relayPayRequestsTotal += 1;
    let payload: RelayPayRequestV1 | null = null;
    try {
      const callerToken = req.header('x-relayer-auth-token') ?? undefined;
      if (!isRelayCallerAuthorized(callerAuthToken, callerToken)) {
        metrics.relayPayFailuresTotal += 1;
        res.status(401).json({ error: 'unauthorized caller' });
        return;
      }
      payload = parseRelayPayRequest(req.body);
      verifySequencerSignature({
        authorization: payload.authorization,
        sequencerSig: normalizeHex(payload.sequencerSig),
        keyMap: sequencerKeyMap
      });

      if (payload.authorization.chainRef !== chainRef) {
        throw new Error(
          `authorization chainRef mismatch: expected ${chainRef}, got ${payload.authorization.chainRef}`
        );
      }
      if (nowSeconds() > BigInt(payload.authorization.expiresAt)) {
        throw new Error('authorization expired');
      }

      const merchantResult = await executeMerchantRequest({
        request: payload.merchantRequest,
        staticHeaders,
        payoutMode,
        allowedHosts,
        timeoutMs,
        maxResponseBytes
      });

      const executionTxHash = deriveExecutionTxHash({
        authId: normalizeHex(payload.authorization.authId),
        chainRef,
        payoutMode,
        merchantResult
      });

      const reportStatus = merchantResult.status < 400 ? 'SUCCESS' : 'FAILED';
      const report = createExecutionReport({
        authId: normalizeHex(payload.authorization.authId),
        chainRef,
        executionTxHash,
        status: reportStatus,
        relayerKeyId,
        privateKey: relayerPrivateKey
      });

      let reportAttempts = 0;
      while (true) {
        try {
          await reportExecution({
            sequencerUrl,
            report
          });
          break;
        } catch (error) {
          reportAttempts += 1;
          metrics.sequencerReportRetriesTotal += 1;
          if (reportAttempts >= 3) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * reportAttempts));
        }
      }

      const response: RelayPayResponseV1 = {
        executionTxHash,
        authId: normalizeHex(payload.authorization.authId),
        status: merchantResult.status < 400 ? 'DONE' : 'FAILED',
        ...(merchantResult.status < 400
          ? { merchantResult }
          : { failureReason: `merchant status ${merchantResult.status}` })
      };
      res.status(response.status === 'DONE' ? 200 : 422).json(response);
    } catch (error) {
      metrics.relayPayFailuresTotal += 1;
      const failure: RelayPayResponseV1 = {
        executionTxHash: ZERO_HASH,
        authId: payload ? normalizeHex(payload.authorization.authId) : ZERO_HASH,
        status: 'FAILED',
        failureReason: formatFailureReason(error)
      };
      res.status(422).json(failure);
    }
  });

  const server = app.listen(port, () => {
    console.log(`[payment-relayer] listening on ${port} chainRef=${chainRef}`);
    if (payoutMode === 'evm') {
      console.log(
        `[payment-relayer] evm key configured=${Boolean(evmPrivateKeySanitized)} valid=${evmPrivateKeyValid} len=${evmPrivateKeySanitized?.length ?? 0} preview=${keyPreview(evmPrivateKeySanitized)}`
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[payment-relayer] ${signal} received, shutting down`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void main();
