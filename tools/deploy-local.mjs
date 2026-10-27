import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { businessDay } from '../src/daily-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, 'config/scheduler.local.json');
try { await access(local); }
catch {
  const config = JSON.parse(await readFile(resolve(root, 'config/scheduler.example.json'), 'utf8'));
  const today = businessDay(new Date(), config.timezone);
  config.start_date = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  await writeFile(local, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
const appPath = resolve(root, 'config/app.local.json');
try { await access(appPath); }
catch { await writeFile(appPath, await readFile(resolve(root, 'config/app.example.json')), { mode: 0o600, flag: 'wx' }); }
execFileSync(process.execPath, ['--env-file=' + resolve(root, '.env'), resolve(root, 'src/scheduler-cli.mjs'), 'check', local],
  { cwd: root, stdio: 'inherit' });
execFileSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'inherit' });
const directory = resolve(homedir(), '.config/systemd/user');
await mkdir(directory, { recursive: true });
const unitQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const render = async (template, args) => (await readFile(resolve(root, template), 'utf8'))
  .replace('WorkingDirectory=@ROOT@', 'WorkingDirectory=' + root.replaceAll('%', '%%'))
  .replace(/^ExecStart=.*$/m, 'ExecStart=' + [process.execPath, ...args].map(unitQuote).join(' '));
await writeFile(resolve(directory, 'bbns-scheduler.service'), await render('deploy/bbns-scheduler.service.in',
  ['--env-file=' + resolve(root, '.env'), resolve(root, 'src/scheduler-cli.mjs'), 'tick', local]));
await writeFile(resolve(directory, 'bbns-app.service'), await render('deploy/bbns-app.service.in', [resolve(root, 'src/app.mjs')]));
for (const name of ['bbns-scheduler.timer', 'bbns.target'])
  await writeFile(resolve(directory, name), await readFile(resolve(root, 'deploy', name)));
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemd-analyze', ['--user', 'verify', ...['bbns.target', 'bbns-app.service', 'bbns-scheduler.service', 'bbns-scheduler.timer'].map(name => resolve(directory, name))], { stdio: 'inherit' });
// Remove the old standalone boot hook. The application target now owns the timer.
execFileSync('systemctl', ['--user', 'disable', 'bbns-scheduler.timer'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'bbns.target'], { stdio: 'inherit' });
const config = JSON.parse(await readFile(appPath, 'utf8'));
const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
const url = 'http://' + host + ':' + config.port;
let ready = false;
for (let attempt = 0; attempt < 50; attempt++) {
  try { const response = await fetch(url + '/health'); if (response.ok && (await response.json()).application === 'bbns') { ready = true; break; } }
  catch {}
  await delay(100);
}
if (!ready) throw new Error('Application did not become ready; inspect bbns-app.service');
console.log('BBNS application ready: ' + url);
execFileSync('systemctl', ['--user', 'list-timers', 'bbns-scheduler.timer'], { stdio: 'inherit' });
