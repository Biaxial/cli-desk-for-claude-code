const esbuild = require('esbuild');
const { mkdirSync, copyFileSync, existsSync, cpSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
mkdirSync(path.join(dist, 'renderer'), { recursive: true });

/** Footer mark only. The 256px file stays in resources/ and is not what the chat UI loads. */
const BRAND_MARKS = ['biaxial-studio-mark-64.png', 'biaxial-studio-mark-128.png'];
const RENDERER_MARK = 'brand/biaxial-studio-mark-128.png';

/** Approved chat status pair only. Loaded from dist/renderer/brand/status/. */
const STATUS_SPRITES = ['assistant-idle.png', 'working-cerebrating.gif'];

function stageStatusSprites() {
  const sourceDir = path.join(root, 'resources', 'brand', 'status');
  const destinations = [
    path.join(dist, 'renderer', 'brand', 'status'),
    path.join(dist, 'resources', 'brand', 'status')
  ];
  for (const name of STATUS_SPRITES) {
    const source = path.join(sourceDir, name);
    if (!existsSync(source)) throw new Error(`Status sprite missing: resources/brand/status/${name}`);
    const bytes = statSync(source).size;
    if (bytes < 32 || bytes > 400000) throw new Error(`Refusing status sprite ${name} (${bytes} bytes)`);
    for (const destDir of destinations) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(source, path.join(destDir, name));
    }
  }
}

function stageBrandMarks() {
  const sourceDir = path.join(root, 'resources', 'brand');
  const destinations = [
    path.join(dist, 'renderer', 'brand'),
    path.join(dist, 'resources', 'brand')
  ];
  for (const name of BRAND_MARKS) {
    const source = path.join(sourceDir, name);
    if (!existsSync(source)) throw new Error(`Brand mark missing: resources/brand/${name}`);
    const bytes = statSync(source).size;
    if (bytes < 32 || bytes > 100000) throw new Error(`Refusing brand file ${name} (${bytes} bytes); use the small marks, not a master PNG`);
    for (const destDir of destinations) {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(source, path.join(destDir, name));
    }
  }
}

function stageRenderer() {
  const htmlPath = path.join(root, 'src/renderer/index.html');
  const html = readFileSync(htmlPath, 'utf8');
  if (!html.includes(RENDERER_MARK)) throw new Error(`Renderer HTML must reference ${RENDERER_MARK}`);
  if (html.includes('biaxial-studio-logo.png') || html.includes('biaxial-studio-mark-256')) {
    throw new Error('Renderer HTML references a missing logo or the 256px mark');
  }
  copyFileSync(htmlPath, path.join(dist, 'renderer/index.html'));
  copyFileSync(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'), path.join(dist, 'renderer/xterm.css'));
  if (existsSync(path.join(root, 'resources'))) {
    cpSync(path.join(root, 'resources'), path.join(dist, 'resources'), { recursive: true });
    cpSync(path.join(root, 'resources'), path.join(dist, 'renderer/resources'), { recursive: true });
  }
  stageBrandMarks();
  stageStatusSprites();
  const packaged = path.join(dist, 'renderer', RENDERER_MARK);
  if (!existsSync(packaged)) throw new Error(`Packaged brand mark missing: ${packaged}`);
}

Promise.all([
  esbuild.build({ entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(dist, 'main.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', 'node-pty'] }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/pty-helper.ts')], outfile: path.join(dist, 'pty-helper.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['node-pty'] }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/chat/chat-helper.ts')], outfile: path.join(dist, 'chat-helper.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/persistence/project-repository.ts')], outfile: path.join(dist, 'project-repository.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/persistence/session-repository.ts')], outfile: path.join(dist, 'session-repository.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/persistence/user-data-location.ts')], outfile: path.join(dist, 'user-data-location.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/single-instance.ts')], outfile: path.join(dist, 'single-instance.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/chat/chat-session.ts')], outfile: path.join(dist, 'chat-session.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/cli/validate-cli.ts')], outfile: path.join(dist, 'validate-cli.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/cli/health-check.ts')], outfile: path.join(dist, 'health-check.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/resume-plan.ts')], outfile: path.join(dist, 'resume-plan.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/model-catalog.ts')], outfile: path.join(dist, 'model-catalog.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/dropped-paths.ts')], outfile: path.join(dist, 'dropped-paths.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/attachments.ts')], outfile: path.join(dist, 'attachments.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/attachments/docx-extract.ts')], outfile: path.join(dist, 'docx-extract.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/error-hints.ts')], outfile: path.join(dist, 'error-hints.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/shared/i18n.ts')], outfile: path.join(dist, 'i18n.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/cli/claude-settings.ts')], outfile: path.join(dist, 'claude-settings.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/main/chat/byte-lines.ts')], outfile: path.join(dist, 'byte-lines.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
  esbuild.build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(dist, 'preload.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] }),
  esbuild.build({ entryPoints: [path.join(root, 'src/renderer/index.ts')], outfile: path.join(dist, 'renderer/app.js'), bundle: true, platform: 'browser', target: 'chrome130', format: 'iife', charset: 'utf8' })
]).then(() => {
  stageRenderer();
}).catch((error) => { console.error(error); process.exitCode = 1; });
