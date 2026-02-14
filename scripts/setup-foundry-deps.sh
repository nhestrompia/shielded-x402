#!/usr/bin/env bash
set -euo pipefail

cd contracts

if [[ ! -d lib/solady ]]; then
  forge install Vectorized/solady --no-git
else
  echo "solady already installed"
fi
