const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/container-check.cjs IMAGE');
const name = `subsync-check-${randomUUID()}`;
const volume = `${name}-data`;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
}

async function waitForHealth(expected) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Running, true, 'Container exited before becoming healthy');
    if (state.Health.Status === expected) return;
    await delay(1000);
  }
  throw new Error(`Container did not become ${expected}`);
}

function startContainer() {
  docker('run', '--detach', '--name', name, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=128', '--memory=512m',
    '--cpus=2', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--mount', `type=volume,source=${volume},target=/data`,
    '--publish', '127.0.0.1::7000', '--health-interval=2s', '--health-start-period=2s',
    '--env', 'OS_API_KEY=owned-container-fixture', image);
}

async function check() {
  docker('volume', 'create', volume);
  try {
    startContainer();
    await waitForHealth('healthy');

    const address = docker('port', name, '7000/tcp');
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const response = await fetch(`http://${address}/manifest.json`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const manifest = await response.json();
    assert.equal(manifest.id, 'org.subtitlesync.reference');
    assert.ok(manifest.resources.includes('subtitles'));

    docker('exec', name, 'node', '-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.equal(process.getuid(), 1000);
      assert.equal(process.env.NODE_ENV, 'production');
      assert.throws(() => require.resolve('tsx'), { code: 'MODULE_NOT_FOUND' });
      assert.equal(fs.existsSync('/app/.env'), false);
      assert.equal(fs.existsSync('/app/.git'), false);
      assert.equal(fs.existsSync('/app/dist/test'), false);
      assert.equal(fs.existsSync('/usr/local/lib/node_modules/npm'), false);
      assert.equal(fs.existsSync('/usr/local/bin/npm'), false);
      assert.throws(() => fs.writeFileSync('/app/readonly-check', 'fixture'), { code: 'EROFS' });
      fs.writeFileSync('/tmp/scratch-check', 'temporary');
      fs.writeFileSync('/data/persistence-check', 'owned fixture');
    `);
    docker('exec', name, 'ffprobe', '-v', 'quiet', '-version');
    docker('exec', name, 'ffmpeg', '-v', 'quiet', '-version');

    // The helper must reject failed health responses; stop the app via SIGSTOP
    // so the init process stays alive and Docker can observe failed checks.
    docker('exec', name, 'node', '-e', `
      const fs = require('node:fs');
      const processes = fs.readdirSync('/proc').filter(id => /^[0-9]+$/.test(id));
      const app = processes.find(id => {
        try { return fs.readFileSync('/proc/' + id + '/cmdline', 'utf8').startsWith('node\\0dist/src/index.js\\0'); }
        catch { return false; }
      });
      if (!app) throw new Error('App process not found');
      process.kill(Number(app), 'SIGSTOP');
    `);
    await waitForHealth('unhealthy');
    docker('exec', name, 'node', '-e', `
      const fs = require('node:fs');
      for (const id of fs.readdirSync('/proc').filter(id => /^[0-9]+$/.test(id))) {
        try {
          if (fs.readFileSync('/proc/' + id + '/cmdline', 'utf8').startsWith('node\\0dist/src/index.js\\0')) process.kill(Number(id), 'SIGCONT');
        } catch {}
      }
    `);
    await waitForHealth('healthy');

    docker('restart', '--time', '5', name);
    await waitForHealth('healthy');
    docker('exec', name, 'node', '-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.equal(fs.readFileSync('/data/persistence-check', 'utf8'), 'owned fixture');
      assert.equal(fs.existsSync('/tmp/scratch-check'), false);
    `);
    docker('stop', '--time', '5', name);
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Running, false);
    assert.equal(state.OOMKilled, false);
    assert.notEqual(state.ExitCode, 137, 'Server required SIGKILL to stop');
    docker('rm', name);
    startContainer();
    await waitForHealth('healthy');
    docker('exec', name, 'node', '-e', `
      const assert = require('node:assert/strict');
      assert.equal(require('node:fs').readFileSync('/data/persistence-check', 'utf8'), 'owned fixture');
    `);
    console.log('Container checks passed: non-root, read-only, media tools, manifest/CORS, health failure/recovery, restart/recreation persistence and shutdown.');
  } catch (error) {
    try { console.error(docker('logs', '--tail', '40', name)); } catch {}
    throw error;
  } finally {
    try { docker('rm', '--force', name); } finally { docker('volume', 'rm', volume); }
  }
}

check().catch((error) => { console.error(error.message); process.exitCode = 1; });
