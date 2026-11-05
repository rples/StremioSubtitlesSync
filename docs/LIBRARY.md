# Persistent translation library and reviewed publishing

Completed translations can now survive application/container restarts and be
reused without another AI call. This feature is opt-in. It adds no public
library endpoint, automatic community uploads, Docker image or new dependency.

## Enable persistent storage

Set `TRANSLATION_LIBRARY_DIR` to a **dedicated persistent volume**, for example
`/data/translations`. The process must have read/write access and the filesystem
must support same-filesystem atomic directory rename and fsync. Keep the volume
and backups private: they contain plaintext subtitle text, model/profile metadata,
source references and release information. API/upload credentials are not written
into library records. Keep mounted secret files outside this directory.

Without this setting, the previous bounded one-hour memory cache remains in use.
With it, completed records have no expiry and are not automatically evicted.
Default capacity is 1 GiB / 10,000 text artifacts, configurable with
`TRANSLATION_LIBRARY_MAX_BYTES` and `TRANSLATION_LIBRARY_MAX_ITEMS`. New paid work
reserves conservative worst-case space before starting; this can require more
free space than the final files use. A full library returns HTTP 507 rather than
deleting saved translations. Existing matching records remain readable. If a
new timing variant cannot be stored, free space explicitly or increase capacity.
A volume disappearing or failing after an AI call can still prevent persistence.

**Deployment boundary:** the filesystem store supports one writer process and
one upload worker, not horizontally scaled replicas. Concurrent HTTP requests
within that process share a translation job. Stop the addon and upload workers
before CLI operations that mutate, back up or restore the library. Quota scans
traverse the volume; performance at large library sizes has not been benchmarked.

## Identity, privacy and timing

Text identity includes the exact ordered source-text revision, language pair,
endpoint/model, prompt version, generation/batching settings and
`AI_PROFILE_REVISION`. It excludes timestamps, title-only guesses, API keys and
secret headers. Update the profile revision when model aliases or opaque
header/gateway routing change; the addon cannot infer those semantic changes.

The normal scopes are `server` for server-credential installations and an opaque
`user-<hash>` scope for each personal profile. Personal profiles do not read each
other's records. `TRANSLATION_LIBRARY_SHARED=true` explicitly selects the
`instance` scope for server mode and consenting personal profiles, allowing intended users with identical source text and profile
to reuse completed text. Previously private records are not automatically moved.
Personal users must also explicitly consent in the setup form; existing
profiles without consent stay private. Revoking consent does not retract shared
copies already stored; the operator must delete those separately.
Source retrieval and timing resolution still use the current request's provider
credentials before library lookup. This shares saved output, not keys or provider
entitlements. Only enable sharing where source/content rights permit it.

Text and release-specific timing are separate immutable records. Each timing
variant includes exact cue intervals, source/release provenance, available
client-provided video hash/size and an SRT file. These hints retain their original
evidence level; storing them is not independent verification.
Reusing text with another offset/release produces its own variant; an old timing
variant is never imposed on the current source. AI provenance is retained.
Structural validation is not semantic translation review or proof of timing.

A complete artifact is fsynced into a temporary directory and atomically renamed.
Partial/temp directories never count as reusable output. After a crash, an
unfinished job may need to start again and incur another charge; exactly-once
billing across crashes is not promised. Corrupt records fail closed and do not
silently start a new paid translation. Repair from a trusted backup or explicitly
delete the broken artifact. Abandoned `.tmp-*` directories may occupy capacity;
remove those only with all writers stopped after checking the interruption.
Revoking a personal profile denies HTTP access but does not delete its files or
cancel an in-flight task. Delete retained records separately when appropriate.

## Inspect, export, delete and back up

Use the source checkout with development tools installed:

```sh
npm run library -- list
npm run library -- usage
npm run library -- export SCOPE ARTIFACT_ID VARIANT_ID /new/export-directory
npm run library -- delete SCOPE ARTIFACT_ID
npm run library -- backup /new/backup-directory
npm run library -- restore /existing/backup-directory
```

For a compiled deployment, use `node dist/src/library/cli.js` with the same
arguments and environment. The volume is configured by `TRANSLATION_LIBRARY_DIR`.
The `list` output supplies scopes and IDs. These IDs are references, not login
credentials. Export contains the exact SRT variant and provenance for review.
Exports/backups must use new destination directories. Backup is outside the
library and writes its completion manifest last; restore requires that manifest,
valid records and an empty destination library. Restore only trusted backups.
Do not use API keys or install URLs in command arguments.

Deletion removes a specific artifact and its timing variants. It is explicit,
not TTL eviction. Cancel/reconcile active publication records first; final receipts remain after
local artifact deletion. Keep
backups separately: deleting live data does not delete an existing backup.

## Reviewed SubDL publication

Publishing is **off by default** and is an operator-controlled workflow. No upload
runs when a translation finishes, during playback, or in automated tests.
There is no Addic7ed adapter.

The [official SubDL upload documentation](https://subdl.com/api-doc), checked
5 November 2026, describes three calls: `getNId`, `uploadSingleSubtitle`, then
`uploadSubtitle`, followed by moderation. Its examples differ on the final
`token` header format. This adapter therefore requires explicit `raw` or
`bearer-final` mode selection; both shapes are covered by mocked tests. Real
account authentication and session/response behavior remain unverified. Do not
enable live upload until those details are confirmed for the upload account.

Configure `SUBDL_PUBLISHING_ENABLED=true` only when ready. Supply a separate
`SUBDL_UPLOAD_TOKEN_FILE` (preferred) or `SUBDL_UPLOAD_TOKEN`, and
`SUBDL_UPLOAD_HEADER_MODE=raw|bearer-final`. A search/download key is not used as
an implicit upload token. The adapter uses fixed HTTPS SubDL endpoints, refuses
redirects, limits responses and performs no automatic retries.

Export the selected timing variant, review the full text and timing against the
specified release, and create an English metadata JSON file, for example:

```json
{
  "type": "movie",
  "tmdbId": 123,
  "imdbId": "tt1234567",
  "name": "Reviewed title and release",
  "releases": ["Exact.Playback.Release"],
  "quality": "web",
  "framerate": 0,
  "season": 0,
  "episode": 0,
  "hearingImpaired": false,
  "credits": "Original source attribution and permission information",
  "reviewNote": "What was checked against this exact release",
  "rightsConfirmed": true,
  "qualityReviewed": true,
  "accountOwnerConsent": true
}
```

Use real reviewed identifiers, not the example values. For an episode, use
`type: "tv"` and its explicit season/episode. Source identity/release conflicts
are refused. TMDB and IMDb are both required conservatively; their association
must be checked by the reviewer. Regional/three-letter language upload mappings
are not guessed. Each item is one movie/episode, never an inferred season pack.
The uploader forces machine-translation provenance (`production_type=3`) and
retains source credits/model/prompt/timing notes. Confirmation flags record the
operator's review; software cannot establish copyright permission or fluency.

```sh
npm run library -- queue SCOPE ARTIFACT_ID VARIANT_ID /private/reviewed-metadata.json
npm run library -- outbox
npm run library -- approve PUBLICATION_ID
npm run library -- submit PUBLICATION_ID
```

`queue` deduplicates the selected variant; repeating it does not overwrite
already reviewed metadata. `approve` binds a review hash to the artifact,
variant and metadata. Changed approved metadata is rejected. Concurrent upload
attempts are locked, with a state recheck under the lock. A successful final
response records **submitted**, not publicly available. Rejected uploads keep
the local translation. Unknown network/HTTP/response outcomes record
**uncertain** and block resubmission, including after restart. Maximum three
manually initiated attempts per queue item; no background retry loop.

After a crash, a leftover lock or `uploading` record also requires reconciliation.
Stop all workers, inspect the account remotely, then choose the actual outcome:

```sh
npm run library -- reconcile PUBLICATION_ID submitted --workers-stopped
# Only after confirming it was NOT accepted remotely:
npm run library -- reconcile PUBLICATION_ID not-submitted --workers-stopped
npm run library -- approve PUBLICATION_ID
```

An incorrect "not submitted" assertion can still cause a duplicate; there is no
documented idempotency/status endpoint for this adapter to prove remote state.
A human can record a separately checked public page:

```sh
npm run library -- confirm-public PUBLICATION_ID https://subdl.com/subtitle/REVIEWED-PAGE
```

A separately checked moderation rejection can be recorded with
`npm run library -- record-rejection PUBLICATION_ID "Reviewed moderation note"`.
It is stored as **moderation-rejected**, keeps local data and triggers no retry.

The public-page confirmation state is explicitly **published-manual**. The addon does not fetch or
independently verify that page, and never infers publication from HTTP success.
Do not cancel, reconcile, delete or operate on the same item concurrently with
a live worker. `cancel` is available for draft/approved items before upload.

## Validation and remaining checks

Generated/owned fixtures cover fresh-process reuse without AI, content/profile
revisions, shared/private scopes, independent timing variants, immutable output,
checksums, incomplete work, full storage, backup/restore/export/delete, HTTP
reuse, personal-profile revocation, both header formats, exact episode metadata,
review consent, duplicate suppression, rejection, interrupted workers and
uncertainty after a simulated accepted-but-disconnected submission.

No real provider/model calls, community uploads, real credentials or user media
are needed. Live upload authentication/moderation, NAS/Docker volume durability,
performance, gateway quality/cost and Stremio/TV behavior remain separate checks.
The existing dependency-audit findings remain outside this change.
