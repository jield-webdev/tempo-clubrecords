import { afterEach, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deployment({
  first = false,
  broken = false,
  wrongDirectory = false,
  response = '{"ok":true}',
  port = '3001',
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tempo-deploy-')));
  dirs.push(root);
  for (const dir of ['bin', 'repository', 'releases/previous', 'fixture'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, '.env'), `HOST=127.0.0.1\n${port ? `PORT="${port}"` : ''}\n`);
  writeFileSync(join(root, 'fixture/.keep'), '');
  if (broken) symlinkSync(join(root, 'current'), join(root, 'current'));
  else if (!first) symlinkSync(join(root, 'releases/previous'), join(root, 'current'));
  // Exercise the actual deploy script; isolate external services and builds.
  const dispatcher = join(root, 'bin/dispatch');
  writeFileSync(
    dispatcher,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.env.TEST_DEPLOY_ROOT;
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
if (command === 'systemctl') console.log(process.env.TEST_WORKING_DIRECTORY);
if (command === 'git' && args[0] === 'archive') process.stdout.write(execFileSync('tar', ['-cf', '-', '-C', path.join(root, 'fixture'), '.']));
if (command === 'mv') fs.renameSync(args[1], args[2]);
if (command === 'sudo' && !args.includes('-l')) fs.appendFileSync(path.join(root, 'actions'), args.join(' ') + '\\n');
if (command === 'curl') {
  fs.appendFileSync(path.join(root, 'urls'), args.at(-1) + '\\n');
  console.log(process.env.TEST_RESPONSE);
}
`,
  );
  chmodSync(dispatcher, 0o755);
  for (const command of ['systemctl', 'sudo', 'flock', 'git', 'npm', 'mv', 'curl', 'sleep'])
    symlinkSync(dispatcher, join(root, 'bin', command));
  const script = readFileSync(new URL('../deploy/git-deploy.sh', import.meta.url), 'utf8').replace(
    'root=/opt/tempo-clubrecords',
    `root='${root}'`,
  );
  const result = spawnSync('bash', ['-c', script, 'tempo-deploy', 'a'.repeat(40)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      TEST_DEPLOY_ROOT: root,
      TEST_WORKING_DIRECTORY: wrongDirectory ? root : join(root, 'current'),
      TEST_RESPONSE: response,
      // The SSH user's environment must not override the production EnvironmentFile.
      PORT: '9999',
    },
  });
  return { root, result, output: result.stdout + result.stderr };
}

it('checks the configured production port and activates a new release', () => {
  const { root, result, output } = deployment();
  expect(result.status, output).toBe(0);
  expect(readFileSync(join(root, 'urls'), 'utf8')).toBe('http://127.0.0.1:3001/api/health\n');
  expect(realpathSync(join(root, 'current'))).not.toBe(join(root, 'releases/previous'));
});

it('uses the application default on a first deployment without PORT', () => {
  const { root, result, output } = deployment({ first: true, port: '' });
  expect(result.status, output).toBe(0);
  expect(readFileSync(join(root, 'urls'), 'utf8')).toBe('http://127.0.0.1:3000/api/health\n');
});

it('rejects an unrelated HTTP 200 and restores the canonical previous release', () => {
  const { root, result, output } = deployment({ response: '<html>Different app</html>' });
  expect(result.status, output).toBe(1);
  expect(realpathSync(join(root, 'current'))).toBe(join(root, 'releases/previous'));
  expect(output).toContain(`restoring ${join(root, 'releases/previous')}`);
}, 20000);

it('removes current after a failed first deployment instead of creating a self-link', () => {
  const { root, result, output } = deployment({ first: true, response: '{"ok":false}' });
  expect(result.status, output).toBe(1);
  expect(existsSync(join(root, 'current'))).toBe(false);
  expect(readFileSync(join(root, 'actions'), 'utf8')).toContain('stop tempo-clubrecords.service');
}, 20000);

it('rejects a self-link before switching or restarting', () => {
  const { root, result, output } = deployment({ broken: true });
  expect(result.status, output).toBe(1);
  expect(output).toContain('current must point to an existing release directory');
  expect(existsSync(join(root, 'actions'))).toBe(false);
});

it('rejects a stale service working directory before switching or restarting', () => {
  const { root, result, output } = deployment({ wrongDirectory: true });
  expect(result.status, output).toBe(1);
  expect(output).toContain(`Set WorkingDirectory=${root}/current`);
  expect(existsSync(join(root, 'actions'))).toBe(false);
});
