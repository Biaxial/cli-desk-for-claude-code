const { spawn } = require('node:child_process');

if (process.argv[2] === 'grandchild') {
  setInterval(() => {}, 1000);
} else {
  const grandchild = spawn(process.execPath, [__filename, 'grandchild'], {
    stdio: 'ignore', windowsHide: true
  });
  process.stdout.write(JSON.stringify({ type: 'descendant', detail: grandchild.pid }) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (chunk.includes('exit')) process.exit(0);
  });
}
