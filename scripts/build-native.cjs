const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('Skipping NativeSupervisor.exe build: the Job Object supervisor is Windows-only.');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'dist', 'native');
mkdirSync(destination, { recursive: true });
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(destination, 'NativeSupervisor.exe')}`, path.join(root, 'src', 'native', 'windows', 'NativeSupervisor.cs')], { stdio: 'inherit' });
