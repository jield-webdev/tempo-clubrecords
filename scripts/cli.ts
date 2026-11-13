import { readFileSync, existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { openDb, one, transaction } from '../src/server/db.ts';
import { importExcel } from '../src/server/importers/excel.ts';
import { importLenex } from '../src/server/importers/lenex.ts';
import { rebuildRecords } from '../src/server/domain.ts';
import { setPassword } from '../src/server/auth.ts';
import { migrateSqlite } from '../src/server/migrate.ts';
import { meta } from '../src/server/queries.ts';

if (existsSync('.env')) loadEnvFile('.env');
const db = await openDb();
const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'db:migrate-sqlite':
      if (!args[0]) throw new Error('Usage: npm run cli -- db:migrate-sqlite <source.sqlite>');
      console.log(JSON.stringify(await migrateSqlite(db, args[0]), null, 2));
      break;
    case 'seed':
      console.log(
        JSON.stringify(
          await importExcel(
            db,
            readFileSync(args[0] || 'Tempo clubrecords 2026.xlsx'),
            args[0] || 'Tempo clubrecords 2026.xlsx',
          ),
          null,
          2,
        ),
      );
      break;
    case 'reset': {
      if (!args.includes('--yes'))
        throw new Error(
          'Reset verwijdert alle sportgegevens en uploads. Voeg --yes toe om dit te bevestigen. Beheerwachtwoord en clubcode blijven bewaard.',
        );
      const path = args.find((a) => a !== '--yes') || 'Tempo clubrecords 2026.xlsx';
      // Read/validate first; clear + seed share one transaction and roll back together on error.
      console.log(
        JSON.stringify(await importExcel(db, readFileSync(path), path, { reset: true }), null, 2),
      );
      break;
    }
    case 'import': {
      if (!args.length)
        throw new Error('Gebruik: npm run cli -- import <bestand.lxf> [meer bestanden]');
      for (const file of args)
        console.log(
          JSON.stringify({ file, ...(await importLenex(db, readFileSync(file), file)) }, null, 2),
        );
      break;
    }
    case 'records:rebuild':
      await transaction(db, async () => await rebuildRecords(db));
      console.log('Recordhistorie opnieuw berekend.');
      break;
    case 'stats':
      console.log(JSON.stringify(await meta(db), null, 2));
      break;
    case 'settings:team': {
      if (!/^\d{2}-\d{3}$/.test(args[0] || ''))
        throw new Error('Gebruik: npm run cli -- settings:team 13-036');
      await transaction(db, async () => {
        await db.prepare("UPDATE settings SET value=? WHERE key='team_code'").run(args[0]);
      });
      console.log(`Clubcode voor volgende imports: ${args[0]}`);
      break;
    }
    case 'admin:set-password': {
      // Read a password from stdin for automation. Interactive entry hides characters in terminals.
      let password = process.env.TEMPO_ADMIN_PASSWORD;
      if (!password && process.stdin.isTTY) {
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        const stdin = process.stdin;
        process.stdout.write('Nieuw beheerwachtwoord (minimaal 12 tekens): ');
        readline.close();
        stdin.setRawMode(true);
        stdin.resume();
        password = await new Promise<string>((resolve, reject) => {
          let value = '';
          const onData = (chunk: Buffer) => {
            for (const char of chunk.toString()) {
              if (char === '\u0003') {
                stdin.off('data', onData);
                stdin.setRawMode(false);
                stdin.pause();
                reject(new Error('Geannuleerd.'));
                return;
              }
              if (char === '\r' || char === '\n') {
                stdin.off('data', onData);
                stdin.setRawMode(false);
                stdin.pause();
                process.stdout.write('\n');
                resolve(value);
                return;
              }
              if (char === '\u007f') value = value.slice(0, -1);
              else value += char;
            }
          };
          stdin.on('data', onData);
        });
      } else if (!password) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        password = Buffer.concat(chunks).toString().trimEnd();
      }
      await setPassword(db, password!);
      console.log('Beheerwachtwoord opgeslagen. Bestaande sessies zijn uitgelogd.');
      break;
    }
    default:
      console.log(
        `Tempo clubrecords CLI\n\n  seed [workbook.xlsx]\n  reset --yes [workbook.xlsx]\n  import <file.lxf|file.lef|file.xml> [...]\n  stats\n  records:rebuild\n  settings:team 13-036\n  admin:set-password\n\ndb:migrate-sqlite <source.sqlite>\n\nDATABASE_URL=mysql://user:password@host:3306/database voor MySQL; anders DATABASE_PATH (standaard ./data/tempo.sqlite).`,
      );
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
