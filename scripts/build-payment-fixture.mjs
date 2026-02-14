#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [proofPath, publicInputsPath, outputPath] = process.argv.slice(2);
if (!proofPath || !publicInputsPath || !outputPath) {
  console.error('Usage: node scripts/build-payment-fixture.mjs <proof_file> <public_inputs_file> <output_file>');
  process.exit(1);
}

const normalizeHex = (value) => {
  if (!value) return null;
  const trimmed = value.trim().replace(/[",\[\]]/g, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase();
  if (/^[0-9a-fA-F]+$/.test(trimmed)) return `0x${trimmed.toLowerCase()}`;
  return null;
};

const parsePublicInputsFromText = (raw) => {
  const maybeJson = raw.trim();
  if (!maybeJson) return [];

  try {
    const parsed = JSON.parse(maybeJson);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeHex(String(item))).filter(Boolean);
    }
  } catch {
    // fall through to token parser
  }

  return raw
    .split(/[\s,]+/)
    .map((token) => normalizeHex(token))
    .filter(Boolean);
};

const parsePublicInputs = (rawBuffer) => {
  const textParsed = parsePublicInputsFromText(rawBuffer.toString('utf8'));
  if (textParsed.length > 0) return textParsed;

  // Newer bb versions emit raw field elements as contiguous 32-byte words.
  if (rawBuffer.length > 0 && rawBuffer.length % 32 === 0) {
    const words = [];
    for (let i = 0; i < rawBuffer.length; i += 32) {
      words.push(`0x${rawBuffer.subarray(i, i + 32).toString('hex')}`);
    }
    return words;
  }

  return [];
};

const hexToByte = (value) => {
  const n = BigInt(value);
  if (n < 0n || n > 255n) {
    throw new Error(`Expected byte-sized field element, got ${value}`);
  }
  return Number(n);
};

const toBytes32Word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

const collapseExpandedInputs = (publicInputs) => {
  if (publicInputs.length < 161) return null;
  const readWord = (start) => {
    const bytes = [];
    for (let i = 0; i < 32; i += 1) {
      bytes.push(hexToByte(publicInputs[start + i]));
    }
    return `0x${Buffer.from(bytes).toString('hex')}`;
  };

  return {
    nullifier: readWord(0),
    root: readWord(32),
    merchantCommitment: readWord(64),
    changeCommitment: readWord(96),
    challengeHash: readWord(128),
    amountWord: toBytes32Word(publicInputs[160])
  };
};

const parseProof = (path) => {
  const proofBytes = readFileSync(path);
  const asText = proofBytes.toString('utf8').trim();
  const parsedText = normalizeHex(asText);
  if (parsedText) return parsedText;

  if (proofBytes.length === 0) {
    throw new Error(`Empty proof file: ${path}`);
  }
  return `0x${proofBytes.toString('hex')}`;
};

const proof = parseProof(proofPath);

const publicRaw = readFileSync(publicInputsPath);
const publicInputs = parsePublicInputs(publicRaw);
if (publicInputs.length < 6) {
  throw new Error(`Expected at least 6 public inputs, got ${publicInputs.length}`);
}

const expanded = collapseExpandedInputs(publicInputs);
const nullifier = expanded?.nullifier ?? publicInputs[0];
const root = expanded?.root ?? publicInputs[1];
const merchantCommitment = expanded?.merchantCommitment ?? publicInputs[2];
const changeCommitment = expanded?.changeCommitment ?? publicInputs[3];
const challengeHash = expanded?.challengeHash ?? publicInputs[4];
const amountWord = expanded?.amountWord ?? toBytes32Word(publicInputs[5]);

const payload = {
  proof,
  publicInputs: [nullifier, root, merchantCommitment, changeCommitment, challengeHash, amountWord],
  rawPublicInputs: publicInputs,
  nullifier,
  root,
  merchantCommitment,
  changeCommitment,
  challengeHash,
  encryptedReceipt: '0x',
  txHint: 'generated-by-bb'
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote fixture to ${outputPath}`);
