# Security and automated checks

## Dependency remediation

On 5 November 2026, the upstream lockfile reported nine npm audit findings
(one critical, five high, one moderate and two low, including affected parent
packages). Targeted overrides reduce the reported total to zero while keeping
Express 4 and `stremio-addon-sdk` 1.6.10. The SDK downgrade suggested by
`npm audit fix --force` is deliberately avoided.

| Consuming dependency | Override | Reason |
|---|---|---|
| Express | `proxy-addr` 2.0.8 | [IPv6 trust ranges accepting unrelated IPv4 peers](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| Express | `body-parser` 1.20.9 | [Compressed request bodies causing an unhandled stream error](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| Express | `qs` 6.17.1 | [Comma serialization crashing on a shadowed `toString`](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) |
| SDK's router 1 | `path-to-regexp` 0.1.13 | [Multi-parameter route regular expression denial of service](https://github.com/advisories/GHSA-37ch-88jc-xwx2) |
| SDK's external-editor 3 | `tmp` 0.2.7 | [Temporary-file path traversal](https://github.com/advisories/GHSA-ph9p-34f9-6g65) |

Regression tests resolve the dependencies through their actual consuming
packages, including nested SDK copies. Potentially crashing or slow probes run
in separate processes with timeouts. The `tmp` override crosses a minor-version
boundary in a pre-1.0 package: a fixture checks the external editor's temporary
file creation, content and cleanup API. Interactive editor execution is not
covered. Remove overrides when upstream dependencies include the fixes, after
rerunning the checks.

An empty audit is a snapshot of known registry advisories, not proof that every
code path is secure or reachable. The audit job fails on registry errors as well
as advisories; inspect its output before changing dependency versions.

## Reverse-proxy migration

The server previously trusted forwarded headers from every peer. It now trusts
only loopback peers by default, using Express's proxy trust function for both
protocol and forwarded-host handling.

- Direct clients cannot override generated origins through forwarded headers.
- For a reverse proxy on another machine or a container network, set
  `TRUST_PROXY` to its actual IP address or CIDR. Comma-separated entries are
  supported by Express. Avoid trusting networks where arbitrary clients can
  connect directly to the addon.
- The trusted proxy must replace incoming forwarded headers. Trusting a proxy
  that passes attacker-controlled values through still permits spoofing.
- Set `BASE_URL` to the canonical public HTTPS origin when appropriate. It takes
  precedence when generating links. Restrict direct backend access at the
  firewall/reverse proxy; this change does not add authentication or a Host
  header allowlist.
- Restart after changing environment settings. Test subtitle links through the
  actual deployment proxy; local tests cannot establish its configuration.

## Local checks

Use Node.js 22 or newer; the package engine now matches the documented minimum.
Node.js 20 has reached end of life according to the
[official release table](https://nodejs.org/en/about/previous-releases).

```sh
npm ci --ignore-scripts
REQUIRE_MEDIA_TESTS=true npm run check
npm run audit
```

`check` runs typechecking, compilation, all test files and a smoke test of the
compiled server's `/health` and `/manifest.json` endpoints. The smoke server
uses an ephemeral loopback port and a small explicit environment with a dummy
provider key; it does not load `.env` or call a provider. It is stopped afterward.
Ordinary `npm test` can skip media fixtures when FFmpeg/ffprobe are unavailable;
`REQUIRE_MEDIA_TESTS=true` makes missing tools a failure.

## GitHub automation

- Pushes, pull requests and manual dispatches run checks on Node.js 22, 24 and
  26 on Ubuntu 24.04. FFmpeg and ffprobe are installed and required.
- A separate job audits all locked dependencies, including development tools,
  with failure at low severity or above.
- Both jobs install with `npm ci --ignore-scripts`. Actions are pinned to commit
  SHAs, permissions are read-only, checkout does not persist Git credentials,
  and there are no provider secrets or privileged `pull_request_target` jobs.
- A weekly default-branch run catches newly published advisories after merge.
  Dependabot proposes npm and GitHub Actions updates weekly; there is no
  automatic merge. Repository settings may require maintainers to enable or
  approve workflows and Dependabot.

The first Linux run exposed an existing 429 retry failure with Ubuntu's FFmpeg.
Probes now capture warning-level stderr: FFmpeg 6.1 logs the numeric HTTP status
at [warning level](https://github.com/FFmpeg/FFmpeg/blob/n6.1.1/libavformat/http.c#L764),
while error-only output can collapse 429 into a generic 4XX message. Existing
real-HTTP fixture tests require both retry success and persistent-refusal failure.
Successful command stderr is not logged; failed-command messages retain the
existing URL-query redaction. Generic 4XX failures are not treated as 429.

These checks use generated fixtures and local HTTP servers. They do not prove
live provider/model quality, TV behavior, Windows service behavior, NAS
performance, deployment durability or correct production proxy configuration.
