# Host-controlled credentials — English

The **person running the Docker container/server**, rather than the image
publisher or addon user, selects exactly one policy at runtime:

| `CREDENTIAL_MODE` | Which credentials are used? |
|---|---|
| `server` (default) | Only administrator environment keys. User keys cannot override them. |
| `user` | Each user must create a personal profile. No fallback to any administrator credential. |

There is no hybrid mode, automatic account switching or quota pooling. The
policy currently covers OpenSubtitles, SubDL and TorBox. AI translation is not
implemented by this PR; its later implementation must follow the same policy.

## Server mode

Set `CREDENTIAL_MODE=server` and the provider credentials in the container's
runtime environment. At least `OS_API_KEY` or `SUBDL_API_KEY` is needed. TorBox
is optional. Configure language preferences normally; personal key entry is
disabled. Anyone able to reach this instance can use the administrator's
configured accounts and quotas, including TorBox account access for references.
Restrict access to the intended users. Keys must not be baked into an image.

## Mandatory personal mode

Set `CREDENTIAL_MODE=user`. Also configure:

- `PROFILE_DIR`: persistent profile volume, for example `/data/profiles`.
- `PROFILE_ENCRYPTION_KEY_FILE`: a mounted secret file containing a random
  **32-byte key encoded as 64 hex characters**. Alternatively set
  `PROFILE_ENCRYPTION_KEY` to that value. A file takes precedence.
- `BASE_URL`: the externally reachable HTTPS origin, recommended behind a proxy.
- `TRUST_PROXY`: only actual proxy IPs/CIDRs. Default is `loopback`; a Docker
  bridge proxy usually requires its explicit address/CIDR. Never trust all
  clients or expose the backend directly with a broadly trusted proxy range.

A key can be generated once with `openssl rand -hex 32`. Keep it stable and
separate from the profile volume; back up both securely. Startup refuses a
missing/malformed key or inaccessible profile directory. Losing/changing the
key makes existing profiles unreadable; this PR does not implement key rotation.
A Docker secret mount is supported, but this PR does not publish a Docker image
or supply a Dockerfile. Apply these settings to the image/deployment you build.

Users visit `/configure`, submit their own credentials and receive a manifest
URL containing a random, revocable profile token. The form submits keys in a
JSON POST over HTTPS, not in query strings or install URLs. Plain HTTP is
allowed only for direct loopback development. Users can paste their installation
URL/token into the form to revoke it. Replacing credentials means creating a
new installation and revoking the old one.

Provider search/file caches and TorBox signed-link caches are scoped to the
full account credentials rather than shared file IDs or key suffixes.

Profiles use AES-256-GCM, random nonces, authenticated profile identity and token-hashed filenames, with restrictive
file permissions. Provider keys and non-secret settings are stored together in
encrypted files. A new process can read them using the same volume and key.
There is a 32 KiB submission limit, a maximum of 1,000 profiles and a global
100 registration-attempts/hour/process limit. JSON input, unknown fields and
per-field sizes are validated. These bounds are basic abuse protection; an
exposed service still needs an appropriate proxy/access policy. The file store
and registration limit target one writer process, not multiple replicas.

**Trust model:** encryption protects stored files without their key. The host
operator can decrypt personal credentials because the service needs to use them.
The installation token is itself a bearer secret: anyone possessing it can use
that profile. Keep it private; redact tokens in reverse-proxy logs and disable
shared caching. Profile responses enforce `private, no-store`, including SDK
resources. Revocation is checked before server caches; it cannot erase subtitles
already downloaded or prevent a request that was already in progress.

## Migration and scope

This changes the earlier per-install credential behavior. Old install URLs
containing raw provider keys are rejected with a reinstall message. With the
new default `server` policy, only environment credentials are used. Users of
personal keys must reinstall through `/configure` on a host configured for
`user`. Non-secret language/settings URLs remain supported.

The two policies are exclusive for **all** configured providers. In personal
mode, omitting an OpenSubtitles/TorBox/SubDL key disables that provider for that
profile, even if the administrator has configured one. A personal profile needs
at least an OpenSubtitles or SubDL key. A profile is not proof of a working key,
provider entitlement, correct subtitle timing or permission to publish.

Automated tests use dummy keys and generated subtitles. They exercise both
policies, fresh-process recovery, tampering, mounted secrets, SDK listing and
file delivery, redaction, revocation, HTTPS/origin checks and write limits.
No live provider calls, paid AI operations or community uploads are needed.

# Beheerdersbeleid voor sleutels — Nederlands

De **beheerder die de Docker-container/server draait** kiest bij het starten
precies één stand. De publiceerder van het Docker-image bepaalt de sleutels niet.

| `CREDENTIAL_MODE` | Gebruikte sleutels |
|---|---|
| `server` (standaard) | Alleen sleutels van de beheerder uit de omgeving. Gebruikers kunnen die niet overschrijven. |
| `user` | Iedereen moet een eigen profiel met persoonlijke sleutels maken. Nooit terugvallen op een beheerdersaccount. |

Geen mengstand, automatisch wisselen of samenvoegen van quota. Dit geldt nu voor
OpenSubtitles, SubDL en TorBox. AI-vertaling wordt hiermee nog niet toegevoegd;
die moet later hetzelfde beleid volgen.

In `server` stelt de beheerder minstens een OpenSubtitles- of SubDL-sleutel in.
Iedereen met toegang gebruikt zijn accounts/quota; ook TorBox-toegang voor
referenties valt hieronder. Beperk toegang daarom tot de bedoelde gebruikers.
Stop sleutels in de runtimeconfiguratie, niet in het Docker-image.

In `user` zijn een blijvend profielvolume (`PROFILE_DIR`) en een vaste willekeurige
versleutelsleutel nodig. Gebruik bij voorkeur `PROFILE_ENCRYPTION_KEY_FILE` voor
een gemount secretbestand, of anders `PROFILE_ENCRYPTION_KEY`: 32 bytes als
64 hextekens. Eenmalig genereren kan met `openssl rand -hex 32`. Bewaar sleutel
en volume veilig en apart; verlies van de sleutel maakt profielen onleesbaar.
Sleutelrotatie wordt nog niet ondersteund. Deze PR publiceert geen Docker-image
of Dockerfile; de instellingen zijn voor je eigen image/deployment.

Gebruik HTTPS en configureer achter een proxy `BASE_URL` en alleen de echte
proxyadressen in `TRUST_PROXY` (standaard `loopback`). Gewone HTTP mag alleen bij
rechtstreekse lokale ontwikkeling. Gebruikers vullen sleutels in via
`/configure`. Die gaan via POST naar de server en blijven daar versleuteld.
Stremio krijgt een installatielink met een intrekbaar token. Via hetzelfde
formulier kan een bestaande link/token worden ingetrokken. Voor nieuwe sleutels
maak je een nieuwe installatie en trek je de oude in.

Versleuteling is AES-256-GCM; bestandsnamen bevatten een hash van het token.
Profielen blijven bij herstart bestaan als volume en sleutel gelijk blijven.
Grenzen: 32 KiB per inzending, 1.000 profielen en 100 registratiepogingen per uur
per proces. Dit is bedoeld voor één schrijvend proces, niet voor meerdere
replica's. Een openbare dienst vraagt daarnaast passend toegangs-/proxybeleid.

De beheerder kan persoonlijke sleutels ontsleutelen: de dienst heeft ze nodig.
Het installatietoken is ook geheim; wie het bezit kan het profiel gebruiken.
Verberg tokens in proxylogs en gebruik geen gedeelde cache. Antwoorden voor
profielen krijgen `private, no-store`; intrekking wordt vóór servercaches
gecontroleerd. Al gedownloade ondertitels of lopende aanvragen trek je daarmee
niet terug.

**Migratie:** oude installatie-URL's met providerkeys worden geweigerd en moeten
opnieuw worden ingesteld. Standaard gebruikt de nieuwe versie alleen
beheerderssleutels. Persoonlijke gebruikers installeren opnieuw via
`/configure` op een host in `user`-stand. Ontbrekende persoonlijke sleutels
schakelen die provider uit; er volgt geen terugval naar beheerderssleutels.
Een profiel moet minstens een OpenSubtitles- of SubDL-sleutel bevatten.

Tests gebruiken testsleutels en eigen ondertitels, zonder echte provideraanvragen,
AI-kosten of uploads. Een profiel bewijst geen geldige providerkey, goede timing
of publicatierecht.
