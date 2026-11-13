import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { openDb } from './db.ts';
import { createApp } from './app.ts';

if (existsSync('.env')) loadEnvFile('.env');
const db = await openDb();
const app = await createApp(db, { frontend: true, logger: true });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });

async function close() {
  await app.close();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
