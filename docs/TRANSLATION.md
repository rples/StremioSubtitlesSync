# Optional AI translation — English

Translation is disabled by default. When enabled, it offers **one labelled AI
fallback** for a requested language only when no usable native-language entry
was offered. Source languages are tried in configured order (default English),
with exact-file candidates first within that language. Subtitle listing makes
no AI calls or subtitle downloads. Selecting the AI entry starts the work.
Native entries and their existing timing routes remain available as before.

The default menu label names the target language, AI provenance, source language
and timing method. It is deliberately a distinct language entry; Stremio's normal
Dutch auto-selection is **not guaranteed** to select it. Translation quality
and fluency need human review. Structural validation does not prove that the
translation is semantically correct or in the requested language.

## Credential policy and setup

[Host credential policy](CREDENTIALS.md) applies unchanged:

- `server`: the administrator explicitly sets `AI_ENABLED=true`, `AI_BASE_URL`,
  `AI_MODEL`, optional `AI_API_KEY` and `AI_HEADERS` in the runtime environment.
  Users cannot enable or override this account through an installation URL.
- `user`: the user enables optional AI in `/configure` and supplies their own
  base URL/model/key/optional headers. These settings are encrypted with the
  provider profile, never embedded in returned URLs. Administrator AI credentials
  are never used as a fallback. The host must allow the **exact** base URL in
  `AI_ALLOWED_BASE_URLS`; otherwise setup is refused. Existing profiles without
  AI fields continue to work with translation disabled.

A profile still needs an OpenSubtitles or SubDL key for source retrieval.
Local endpoints may not need an AI key. Allowlisting an unauthenticated gateway
permits users to invoke that service: its own backend accounts/routing remain
under the gateway operator's control. Use only trusted endpoints. The host can
decrypt stored personal settings, as described in the credential documentation.

Base URLs must have no userinfo, query, fragment or final `/chat/completions`.
The addon appends that path and sends a minimal non-streamed Chat Completions
request. It does not discover models or assume structured-output support.

Examples from the official documentation, checked 4 November 2026:

| Service | Base URL example | Notes |
|---|---|---|
| [OpenRouter](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) | `https://openrouter.ai/api/v1` | Set the chosen model and API key; model capabilities vary. |
| [Bifrost](https://docs.getbifrost.ai/features/drop-in-replacement) | `http://bifrost:8080/openai` | Use the compatibility path of your installed gateway, including any deployment prefix. Some configurations expose `/v1` instead. |
| [Local Ollama](https://docs.ollama.com/api/openai-compatibility) | `http://ollama:11434/v1` | Local model must be installed and capable of the required JSON response. `localhost` inside Docker refers to that container. |

These are documented API shapes, **not live integration certifications**. Bifrost
[authentication](https://docs.getbifrost.ai/quickstart/gateway/setting-up-auth)
depends on gateway configuration; use the appropriate bearer credential or
permitted extra headers such as `x-bf-vk`. Basic authentication is not implemented.
The addon itself never silently switches endpoints/models. A gateway may have
its own configured routing or fallbacks; configure that separately.

HTTPS is the default. Trusted local/private HTTP endpoints require explicit
`AI_ALLOW_HTTP=true`; in personal mode they must also be allowlisted. Redirects
are rejected, including redirects within the same origin. Do not allowlist
untrusted or metadata/admin services. Extra headers are limited to up to eight
`X-*`, `HTTP-Referer` or `api-key` fields; proxy-spoofing, authorization override,
cookies and transport headers are refused. No secrets go in a URL or error body.

## Timing and output validation

The source is first fetched and, where applicable, aligned using the existing
OpenSubtitles-reference or verified embedded-reference path. An unavailable
reference or unconfident alignment aborts the AI route **before any AI call**.
A release-name reference remains weak and labelled accordingly. With no usable
reference, no fallback is offered unless `INCLUDE_UNSYNCED=true` explicitly
permits an unchanged source. Translation inherits that unverified timing; it
does not make it verified. Existing hash metadata is evidence supplied by the
upstream provider/client, not a new independent timing guarantee.

Only cue text, stable generated sequence IDs, and source/target language codes
are sent to the model. No media, audio, video URLs, file names, API keys or
source timecodes are included in the prompt. Subtitle text is treated as
untrusted data. No tools are enabled.

The required response is a JSON object with a `cues` array of `{id,text}` records.
Missing, extra, duplicate or reordered IDs, extra fields/timecodes, blank text,
subtitle-block injection, excessive expansion, refusals, truncation, unexpected
finish reasons and malformed JSON cause the **whole subtitle** to fail. Every
successful output retains the source cue count, order and exact timestamps.
There is no source-language/partial subtitle served under a translated label.

## Compatibility and bounds

| Setting | Default / behavior |
|---|---|
| `AI_SOURCE_LANGUAGES` | `en`, up to five source language codes. |
| `AI_TOKEN_PARAMETER` | `max_tokens`; choose `max_completion_tokens` if required. |
| `AI_JSON_MODE` | `off` sends only a JSON prompt; `object` adds `response_format: {type: json_object}`. |
| `AI_MAX_OUTPUT_TOKENS` | 4096 per batch; configurable 256–16384. |
| `AI_BATCH_CUES` / `AI_BATCH_CHARACTERS` | 32 cues / 6000 characters per sequential batch. |
| `AI_MAX_CUES` / `AI_MAX_CHARACTERS` | 5000 cues / 500000 source characters per job. |
| `AI_REQUEST_TIMEOUT_MS` / `AI_JOB_TIMEOUT_MS` | 30 seconds per call / 180 seconds per job. |
| `AI_RESPONSE_WAIT_MS` | 5 seconds before a pending job returns HTTP 503 with Retry-After. |
| `AI_HOURLY_CALLS` | 120 call attempts in a process-wide fixed hourly window; full-job allowance is reserved before starting. |
| `AI_CONCURRENCY` | Two background jobs maximum; no unbounded queue. |

Responses are capped at 512 KiB. Extra headers/individual texts/input are bounded.
Requests use a single endpoint and have no automatic retries, model expansion,
parameter downgrades or cloud fallback. If a model rejects a parameter, select
the supported token/JSON setting explicitly. Timeout, invalid output, auth and
quota errors trigger endpoint/account backoff. Calls already made can still be
billable even when a later batch fails. Request/token limits are **not a currency
budget**; use provider-side spending limits too. Limits are per process, so
multiple replicas require external shared accounting.

## First-use latency and caching

A slow full-subtitle job continues after the first HTTP response/client timeout.
The response says it is preparing and supplies Retry-After; select the entry
again after it completes if your player does not retry. Automatic retries,
refresh and successful first-selection playback on LG/other clients remain to
be tested. This PR does not claim instant or universally automatic translation.
Jobs have a bounded lifetime; revocation does not cancel an already running job.

Identical concurrent requests share one job. Only fully validated text is cached
for one hour, up to 50 results. Identity includes source text revision, language
pair, model, prompt version, batching/options and hashed endpoint credentials.
Text reuse is independent of timing, so each response keeps its own aligned
source timestamps. Credentials/account output are not pooled. A restart loses
jobs and this memory cache. Optional [persistent library storage](LIBRARY.md) now
keeps completed text and release-specific timing across restarts, with explicit
sharing and a separate reviewed publication workflow. Without that volume, a
restart may require another paid translation.

## Validation scope

Tests use generated subtitles, mocked model/provider responses and a locally
generated MKV with a range server. They cover both credential policies, normal
and malformed output, quotas, timeout, concurrency, batch budgets, fallback
selection, native Dutch suppression, SRT delivery, cached text with new timing
and translation after real embedded-reference alignment. Browser testing uses
dummy setup keys. No live provider/model calls or uploads are required.

Before production use, separately test the chosen gateway/model's format,
quality/cost, long-subtitle latency, Docker/proxy configuration and Stremio/TV
retry behavior. Existing dependency audit findings are unchanged by this PR.

# Optionele AI-vertaling — Nederlands

Vertalen staat standaard uit. Als het expliciet aanstaat, verschijnt **één
herkenbare AI-terugval** voor een gewenste taal als geen bruikbare bestaande
ondertitel in die taal is aangeboden. Brontalen worden op ingestelde volgorde
geprobeerd (standaard Engels), met exacte kandidaten eerst. Lijsten tonen kost
geen AI-aanvragen of ondertiteldownloads. Pas selecteren start de vertaling.

Het label toont taal, AI-herkomst, brontaal en timingmethode. Het is een aparte
taalvermelding; automatisch kiezen op basis van de voorkeur Nederlands is
**niet gegarandeerd**. Structuurcontrole bewijst geen goede vertaling of juiste
taal. Inhoudelijke kwaliteit vraagt menselijke beoordeling.

## Instellen en sleutels

Het [beheerdersbeleid](CREDENTIALS.md) blijft gelden:

- `server`: beheerder stelt `AI_ENABLED=true`, basis-URL, model, sleutel en
  eventuele extra headers in via de runtimeomgeving. Gebruikers kunnen dit
  account niet via een installatie-URL inschakelen of overschrijven.
- `user`: gebruiker vult optionele AI-instellingen in via `/configure`. Die
  blijven versleuteld in het persoonlijke profiel. Geen terugval naar AI-sleutels
  van de beheerder. Alleen exacte endpoints uit `AI_ALLOWED_BASE_URLS` zijn
  toegestaan. Bestaande profielen blijven zonder AI werken.

Een OpenSubtitles- of SubDL-sleutel blijft nodig om brontekst op te halen. Een
lokaal model kan zonder AI-sleutel werken. Een toegestane gateway zonder
inlogcontrole geeft toegang tot die dienst; de gatewaybeheerder bepaalt zijn
eigen achterliggende accounts en routering. De addon wisselt zelf geen
model/endpoint of account. Gatewayfallbacks moeten daar apart worden ingesteld.

Gebruik een basis-URL zonder sleutel, query, fragment of `/chat/completions`.
De addon voegt dat pad toe. De officiële voorbeelden hierboven beschrijven
OpenRouter, Bifrost en Ollama; het zijn geen live compatibiliteitsgaranties.
Bifrost-pad/authenticatie hangen van je gatewayversie en instellingen af.
Basic-auth wordt niet ondersteund. HTTP naar een vertrouwde lokale/private
dienst vraagt `AI_ALLOW_HTTP=true`, en in persoonlijke stand ook allowlisting.
Redirects zijn uit. Extra headers zijn begrensd; proxy-/cookie-/transportheaders
en overschrijven van Authorization zijn niet toegestaan.

## Timing, kwaliteit en limieten

Eerst wordt de brontiming bepaald of gecorrigeerd. Een ontbrekende referentie
of onvoldoende zekere uitlijning stopt de AI-route vóór een betaalde aanvraag.
Een zwakke releasereferentie blijft zwak. Alleen met `INCLUDE_UNSYNCED=true` mag
ook ongewijzigde/onbewezen timing als bron dienen. Vertaling bewijst geen sync.

Alleen tekst, gegenereerde volgnummer-ID's en taalcodes gaan naar het model.
Geen media/audio, bestandsnamen, downloadlinks, sleutels of tijdcodes. De
geaccepteerde uitvoer heeft exact dezelfde regels en volgorde; tijdcodes worden
rechtstreeks van de bron gekopieerd. Ontbrekende/dubbele/omgewisselde ID's,
extra velden, lege tekst, ondertitelinjectie, overmatige uitbreiding, truncatie,
weigering en ongeldige JSON worden volledig geweigerd. Geen halve vertaling of
brontaal onder een Nederlands label teruggeven.

Standaard: 32 regels/6000 tekens per batch; maximaal 5000 regels/500000 brontekens;
30 seconden per aanvraag en 180 seconden per taak; twee gelijktijdige taken en
120 aanvragen per uur per proces. De volledige aanvraagruimte wordt vooraf
gereserveerd. Geen onbeperkte wachtrij of automatisch opnieuw proberen.
Antwoorden maximaal 512 KiB; outputtokens standaard 4096 per batch. Kies
`max_tokens` of `max_completion_tokens` en optioneel JSON-objectmodus passend
bij je model. Quota-/auth-/uitvoerfouten veroorzaken een pauze. Reeds gedane
mislukte/deelaanvragen kunnen geld kosten; gebruik ook providerbestedingslimieten.
De genoemde aanvraaglimieten zijn geen eurobudget of gedeelde replicalimiet.

## Wachttijd en hergebruik

Duurt de taak langer dan standaard vijf seconden, dan volgt HTTP 503 met
Retry-After terwijl de taak doorgaat. Selecteer later opnieuw als de speler
niet zelf probeert. Automatisch opnieuw proberen en direct afspelen op LG/tv
moeten nog worden getest. Geen belofte dat een nieuwe vertaling meteen klaar
is. Intrekken van een profiel stopt een al lopende taak niet.

Persistent storage and reviewed publication are now available as an opt-in
[persistent library](LIBRARY.md). Without it, only the one-hour memory cache is
used and restarting can require another paid translation. With the library,
complete text and release-specific timing are kept separately across restarts.
Personal sharing and community publication require explicit configuration.

Tests gebruiken eigen ondertitels, nagebootste API's en gegenereerde MKV/range-
fixtures. Geen echte AI-kosten of uploads. Live model-/kwaliteits-/kostencontrole,
langere taken, Docker/proxy en Stremio-/tv-herhaalgedrag blijven open. Bestaande
dependency-auditmeldingen blijven ongewijzigd.
