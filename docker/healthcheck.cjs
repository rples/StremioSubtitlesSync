// Local process health only: never consume subtitle/model quotas here.
async function check() {
  const port = process.env.PORT || '7000';
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || (await response.json()).ok !== true) {
    throw new Error('Unhealthy response');
  }
}

check().catch(() => { process.exitCode = 1; });
