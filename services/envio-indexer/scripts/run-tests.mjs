import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function hasEthers() {
  try {
    require.resolve("ethers");
    return true;
  } catch {
    return false;
  }
}

if (!hasEthers()) {
  console.warn("[envio-indexer] skipping tests: missing optional dependency 'ethers'");
  process.exit(0);
}

const result = spawnSync("pnpm", ["mocha"], {
  stdio: "inherit",
  shell: true
});

process.exit(result.status ?? 1);
