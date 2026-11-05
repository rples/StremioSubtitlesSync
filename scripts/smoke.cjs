const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function smoke() {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  // Never inherit real provider keys, profile/library volumes or deployment settings.
  const env = {
    PATH: process.env.PATH || '',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    PORT: String(port), BASE_URL: origin, OS_API_KEY: 'owned-smoke-fixture',
    LOG_FILE: 'off', NODE_ENV: 'test',
  };
  const child = spawn(process.execPath, [path.resolve('dist/src/index.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
  let stopped = false;
  const closed = new Promise((resolve) => child.once('close', () => { stopped = true; resolve(); }));
  try {
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !stopped) {
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).ok === true) { ready = true; break; }
      } catch { /* The child may still be starting. */ }
      await delay(100);
    }
    assert.ok(ready, `Compiled server did not become ready: ${output}`);
    const response = await fetch(`${origin}/manifest.json`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.id, 'org.subtitlesync.reference');
    assert.ok(manifest.resources.includes('subtitles'));
    console.log('Compiled server health and manifest smoke test passed. No provider calls made.');
  } finally {
    if (!stopped) child.kill('SIGTERM');
    await Promise.race([closed, delay(2000)]);
    if (!stopped) { child.kill('SIGKILL'); await closed; }
  }
}
smoke().catch((error) => { console.error(error.message); process.exitCode = 1; });
