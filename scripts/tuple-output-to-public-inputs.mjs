#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const [tupleText, outputPath] = process.argv.slice(2);
if (!tupleText || !outputPath) {
  console.error('Usage: node scripts/tuple-output-to-public-inputs.mjs "<tuple output>" <output-file>');
  process.exit(1);
}

function splitTopLevelTuple(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw new Error(`expected tuple syntax "(...)", got: ${trimmed}`);
  }
  const inner = trimmed.slice(1, -1);
  const parts = [];
  let depth = 0;
  let token = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(token.trim());
      token = '';
      continue;
    }
    token += ch;
  }
  if (token.trim()) parts.push(token.trim());
  return parts;
}

function bytesArrayToWord(value) {
  const arr = JSON.parse(value);
  if (!Array.isArray(arr) || arr.length !== 32) {
    throw new Error(`expected [u8;32], got: ${value}`);
  }
  const bytes = arr.map((n) => {
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`invalid byte value ${n}`);
    }
    return n;
  });
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function scalarToWord(value) {
  const v = value.trim();
  const amount = v.startsWith('0x') ? BigInt(v) : BigInt(v);
  return `0x${amount.toString(16).padStart(64, '0')}`;
}

const parts = splitTopLevelTuple(tupleText);
if (parts.length !== 6) {
  throw new Error(`expected 6 tuple members, got ${parts.length}`);
}

const publicInputs = [
  bytesArrayToWord(parts[0]),
  bytesArrayToWord(parts[1]),
  bytesArrayToWord(parts[2]),
  bytesArrayToWord(parts[3]),
  bytesArrayToWord(parts[4]),
  scalarToWord(parts[5])
];

writeFileSync(outputPath, `${JSON.stringify(publicInputs, null, 2)}\n`);
