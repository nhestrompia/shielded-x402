import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  await runner({
    databaseUrl,
    direction: 'up',
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    createSchema: true,
    createMigrationsSchema: true,
    singleTransaction: true,
    noLock: false
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.SEQUENCER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('SEQUENCER_DATABASE_URL (or DATABASE_URL) is required');
  }
  await runMigrations(databaseUrl);
  console.log('[credit-sequencer] migrations up complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
