# SubDL provider — English

## Setup and behavior

Set `SUBDL_API_KEY` in the server's `.env`, restart, and install the addon as
usual. For Dutch subtitles set `LANGUAGES=nl`. SubDL's key is server-side only;
there is no new key field on the configure page or in generated install URLs.
At least one of `OS_API_KEY` or `SUBDL_API_KEY` must be configured.

SubDL supplies **candidate files, not verified timing**. The existing rules apply:

1. Align against an OpenSubtitles hash-matched reference, if available.
2. Otherwise use the existing verified TorBox embedded-reference route.
3. Otherwise use an OpenSubtitles release-name reference, explicitly marked weak.
4. With no reference, offer nothing by default. `INCLUDE_UNSYNCED=true` explicitly
   allows unchanged candidates; it does not make their timing verified.

SubDL results never become hash-matched anchors. Adding SubDL does not establish
Easynews support or remove the need to identify the exact playback file.
OpenSubtitles is optional when the embedded route is available. Provider search
failures are isolated, so one provider failing does not discard the other's
results. Existing numeric OpenSubtitles subtitle URLs remain valid.

## API contract, quota and safety

This implementation uses the [official SubDL API](https://subdl.com/developers):

- v2 search with IMDb ID, movie/TV type, requested languages and episode, plus
  `unpack=1`. Search accepts the documented legacy-shaped `results`/`subtitles`
  response and verifies the returned title identity.
- Unpacked child URLs are reduced to validated IDs. Only HTTPS requests to
  `dl.subdl.com/subtitle/<upload>/<child>` are constructed; provider queries,
  credentials and arbitrary download hosts are never forwarded.
- Single uploads with an explicit `n_id`/`nId` can use the v2
  `/subtitles/<id>/download?format=file` route. ZIP extraction is not implemented:
  archives, binary responses and invalid subtitle text are refused.
- Search requests use Bearer authentication; unpacked downloads use X-API-Key.
  Redirects are refused. Errors do not echo provider bodies, URLs or keys.
- Nothing is downloaded while listing subtitles. Identical concurrent downloads
  share one request. Search results are cached for 15 minutes and files for
  12 hours, separately for each API key. These caches are bounded, in memory and
  lost on restart; this is **not durable translation storage**.
- Each search reads at most three pages of 30 requested results. Each response
  is limited to 4 MiB, each subtitle to 2 MiB and 20,000 valid cues. Requests have
  a 20-second timeout. Parsing also bounds inspected rows and unpacked children.
- HTTP 401/403/406/429 pause new requests for that account, sharing the pause
  between searches and downloads. Retry-After seconds/dates are used with a
  60-second minimum and one-hour maximum; application-level search rejection
  pauses for 60 seconds. Quotas remain determined by the provider/account.

Only SRT, WebVTT and ASS/SSA unpacked text files are offered. Season packs require
explicit matching child season and episode metadata. Unknown language names,
ambiguous packs and unsupported files are skipped. Unknown API response shapes
fail safely rather than selecting an arbitrary file.

The addon has no user authentication: anyone who can reach it can consume the
server's quota. Use a private deployment or an authenticated gateway. This
provider adds no public sharing/uploading of subtitles. Follow source rights
and service terms; downloading a subtitle does not grant republication rights.

## Validation and remaining checks

Automated tests use generated subtitles, mock SubDL responses and local media;
no real provider credentials or downloaded subtitles are included. They cover
quota handling, pack selection, authentication, unsafe URLs, size limits,
provider isolation, old URL compatibility and HTTP alignment to a known timing
reference. Run `npm test`, `npm run typecheck`, and `npm run build`.

**Before relying on a deployment:** smoke-test the current v2 response and raw
child download with your own account, then check an actual movie and a season
pack on your Stremio clients. Provider availability, changing response shapes,
account limits and client auto-selection are not guaranteed by these fixtures.
There is no AI translation, publication or persistent storage in this change.

# SubDL-provider — Nederlands

## Instellen en werking

Zet `SUBDL_API_KEY` in het `.env`-bestand van de server en herstart de addon.
Gebruik `LANGUAGES=nl` voor Nederlandse ondertitels. De sleutel blijft op de
server en krijgt geen nieuw veld op de configuratiepagina of in de installatie-URL.
Minstens één van `OS_API_KEY` en `SUBDL_API_KEY` moet ingesteld zijn.

SubDL levert **kandidaatbestanden, geen bewijs van juiste timing**. De volgorde
blijft: OpenSubtitles-hashreferentie, geverifieerde ingebouwde TorBox-referentie,
dan een zwakke OpenSubtitles-releasereferentie. Zonder referentie verschijnt
standaard niets. `INCLUDE_UNSYNCED=true` biedt expliciet ongewijzigde bestanden
aan, zonder hun timing als gecontroleerd aan te merken.

SubDL wordt geen hashreferentie. Deze toevoeging bewijst geen Easynews-werking.
OpenSubtitles is optioneel als de ingebouwde referentieroute beschikbaar is.
Een providerstoring verwijdert de resultaten van de andere provider niet.
Bestaande OpenSubtitles-URL's blijven werken.

## Grenzen en controle

De officiële v2-API wordt gebruikt met authenticatie in headers. Downloadlinks
worden teruggebracht tot veilige bestands-ID's op het toegestane SubDL-domein;
querysleutels, onbekende hosts en redirects worden niet doorgestuurd. Er wordt
geen ZIP uitgepakt. Bij seizoenspakketten moet de aflevering expliciet uit de
metadata blijken. Onbekende formaten, talen en onduidelijke pakketten vallen af.

Lijsten ophalen verbruikt geen download. Gelijktijdige identieke downloads delen
één aanvraag. Zoekresultaten blijven 15 minuten en bestanden 12 uur in het
geheugen, per API-sleutel gescheiden; na herstart vervallen ze. Dit is geen
blijvende vertaalopslag. Zoekopdrachten stoppen na maximaal drie pagina's met
30 aangevraagde resultaten. Limieten: 4 MiB per zoekantwoord, 2 MiB/20.000 regels
per ondertitel en 20 seconden per aanvraag. Quota-/accountfouten veroorzaken een
pauze; Retry-After wordt begrensd op 60 seconden tot één uur.

De addon heeft zelf geen toegangscontrole. Gebruik hem privé of achter een
poort met authenticatie. Deze wijziging uploadt of deelt geen ondertitels.
Bronrechten en voorwaarden blijven gelden.

Tests gebruiken eigen gegenereerde bestanden en nagebootste providerantwoorden.
De actuele v2-antwoorden, een echte film, een seizoenspakket en de werking op
je Stremio-apparaten moeten nog met een eigen account gecontroleerd worden.
Er komt in deze wijziging geen AI-vertaling, publicatie of blijvende opslag bij.
