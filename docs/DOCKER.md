# Docker and automatic container checks

## Build and run

Use a current Docker Engine with the Compose plugin. The image uses the official
Node.js 24 Debian Trixie slim image, pinned to a multi-platform index digest. It
supports Linux AMD64 and ARM64. No prebuilt registry image is published by this
PR: build from the branch containing these files.

```sh
cp .env.example .env
chmod 600 .env
# Edit .env and set your provider credentials before starting.
docker compose build --pull
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:7000/health
```

The default binding is loopback only. Set `SUBTITLE_SYNC_PORT` in `.env` to change
the host port; the container always listens on 7000. Compose forces stdout logs
and the installed ffprobe path even if an older `.env` contains file logging or
a blank `FFPROBE_PATH`. No real account is needed to check health or the manifest;
actual subtitle operations need configured provider access.

For TV access, route an existing HTTPS reverse proxy to the published port. A
proxy container cannot reach the host's loopback port through its own loopback:
connect it to the Compose network and proxy to `subtitle-sync:7000`, or configure
an appropriate private host binding/network. Set `BASE_URL` to the canonical
HTTPS origin and `TRUST_PROXY` to the actual immediate proxy IP/CIDR. Never use
trust-all. Alternatively, deliberately change the port binding to the NAS's
private LAN IP and allow only the intended local clients at the firewall.
The default Compose file does not configure DNS, TLS or deploy a reverse proxy.

Inspect logs with `docker compose logs --tail=100 subtitle-sync`. Rebuild and
recreate after updating code, the base digest or configuration:

```sh
docker compose build --pull
docker compose up -d --wait
```

## Runtime boundaries

- Runtime UID/GID is 1000:1000 (`node`), with all capabilities dropped, privilege
  escalation disabled, a read-only root filesystem and a 64 MiB temporary mount.
- The build installs locked dependencies without lifecycle scripts, compiles
  source, then removes development dependencies. The runtime includes ffprobe,
  ffmpeg, CA certificates and Tini for signal forwarding and child reaping.
  Bundled npm, Corepack and Yarn are removed from the runtime; use the compiled
  Node commands for maintenance. Build-stage npm remains available for installs.
- The allowlist in `.dockerignore` keeps `.env`, keys, Git history, local
  dependencies, tests and data outside the build context. Configuration is
  supplied at runtime; never add credentials as build arguments or image layers.
- Compose environment values are visible to administrators through container
  inspection. For the feature stack's supported secret-file settings, mount
  read-only secret files instead. Docker is not a boundary against its host
  administrator. Do not mount the Docker socket into the addon.
- Defaults cap memory at 512 MiB, CPU at 2 and PIDs at 128. These are starting
  limits, not NAS performance measurements. Adjust them for actual workloads;
  monitor memory/CPU with `docker stats` and check for OOM exits.

The [official Node image guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)
and [Compose secrets documentation](https://docs.docker.com/compose/how-tos/use-secrets/)
describe the underlying runtime mechanisms.

## Persistent storage and the optional feature stack

Compose mounts a named volume at `/data`, initially owned by UID/GID 1000. A
restart/recreation keeps it; `docker compose down` keeps it too. **`down -v`
deletes it.** NAS bind mounts must already be writable by UID/GID 1000; the
container never starts as root to change host permissions.

This Docker PR is based on the security PR, without bundling the feature PRs.
After merging the credential and library features, explicitly enable their
paths in `.env`; a mounted directory alone does not enable either feature:

```dotenv
PROFILE_DIR=/data/profiles
TRANSLATION_LIBRARY_DIR=/data/translations
```

For personal credentials, also choose `CREDENTIAL_MODE=user` and mount a stable
32-byte hex encryption-key file using `PROFILE_ENCRYPTION_KEY_FILE`. In a
Compose override, for example:

```yaml
services:
  subtitle-sync:
    environment:
      PROFILE_ENCRYPTION_KEY_FILE: /run/secrets/profile_key
    secrets:
      - profile_key
secrets:
  profile_key:
    file: ./secrets/profile_key
```

Create and protect that file outside Git and ensure UID 1000 can read the mounted
file. Run with both Compose files. Loss of the encryption key makes saved
profiles unusable; never store it in the translation library or print it during
diagnostics. The feature stack supports only one writer per library volume.
Stop that writer before filesystem snapshots; retain the profile/library data
and encryption key in separately protected backups. Restore permissions before
starting again. Refer to the feature PRs' credential/library documentation for
their backup/export commands. Compiled CLI invocation is
`docker compose exec subtitle-sync node dist/src/library/cli.js ...`; `tsx` is
intentionally absent from the image.

Current upstream still supports credential-bearing installation URLs. Packaging
does not replace that mechanism: use the credential-policy feature before
offering personal profiles and do not treat Docker as application authentication.

## Health and automation

The image's health check calls only local `/health` with a three-second request
deadline. It checks the process response, not provider availability, timing
quality or quotas. It runs every 30 seconds after the startup grace period.
Docker marks a container unhealthy after three failures; **this alone does not
restart it**. `restart: unless-stopped` handles process exits and Docker restarts.
The Compose logging driver rotates local container logs.

To repeat the automated runtime checks on an existing local image:

```sh
docker build -t subtitle-sync:test .
node scripts/container-check.cjs subtitle-sync:test
```

The script creates its own container, ephemeral loopback port and temporary
named volume, uses only a dummy key, then removes its resources. It verifies
non-root execution, read-only application files, writable scratch/storage,
absence of dev tooling/config/Git/test files, media binaries, manifest/CORS,
health failure and recovery, restart and replacement persistence, and shutdown
without forced killing. No subtitle/provider/model endpoints are called.

GitHub CI builds and runs these checks natively on AMD64 and ARM64, then starts
the actual Compose service with fixture credentials and checks its health. A pinned
Trivy action scans runtime OS and application packages and fails on high/critical
findings with fixes available. Unfixed findings and lower severities are outside
that gate; it is not a zero-CVE guarantee. Registry/database failures also fail
the job. There is no blanket CVE ignore list. The npm audit from the security PR
continues to cover all severities in the lockfile separately.

Weekly default-branch checks rebuild against current Debian package indexes,
and Dependabot proposes Docker base/digest updates. The digest and npm lockfile
are pinned; apt repositories remain moving inputs, so builds are not claimed
bit-for-bit reproducible. Checks do not publish images, spend provider quota,
upload subtitles, update running installations or deploy to a NAS. Automatic
checks are not automatic production updates. Branch protection and Actions
approval remain repository-administrator settings.
