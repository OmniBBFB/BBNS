import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const [command = 'status'] = process.argv.slice(2);
if (!['start','stop','restart','status'].includes(command)) throw new Error('Unsupported application command');
try {
  const args = command === 'status'
    ? ['--user', 'status', 'bbns.target', 'bbns-app.service', 'bbns-scheduler.timer', '--no-pager']
    : ['--user', command, 'bbns.target'];
  execFileSync('systemctl', args, { stdio: 'inherit' });
  if (command === 'start' || command === 'restart') {
    let config = { host: '127.0.0.1', port: 3080 };
    try { config = { ...config, ...JSON.parse(await readFile('config/app.local.json', 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log('BBNS: http://' + config.host + ':' + config.port);
  }
} catch (error) { process.exitCode = typeof error.status === 'number' ? error.status : 1; }
