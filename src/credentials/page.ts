/** No submitted settings are echoed into HTML, URLs or browser storage. */
export function credentialPage(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Subtitle Sync — personal keys / eigen sleutels</title>
<style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;background:#171322;color:#eee}label{display:block;margin:1rem 0}input,select,button{box-sizing:border-box;padding:.65rem;width:100%;margin-top:.3rem}button{cursor:pointer}output{display:block;overflow-wrap:anywhere;margin:1rem 0}small{display:block}</style>
<h1>Subtitle Sync</h1><p>This host requires your own API keys. Keys are stored encrypted on the server. Your installation link grants access to your profile: keep it private.</p>
<p>Deze beheerder vereist je eigen API-sleutels. Die worden versleuteld op de server opgeslagen. Je installatielink geeft toegang tot je profiel: houd hem privé.</p>
<form id="profile" autocomplete="off">
<label>OpenSubtitles API key / API-sleutel<input name="osApiKey" type="password" autocomplete="new-password"></label>
<label>OpenSubtitles username / gebruikersnaam<input name="osUsername" autocomplete="off"></label>
<label>OpenSubtitles password / wachtwoord<input name="osPassword" type="password" autocomplete="new-password"></label>
<label>SubDL API key / API-sleutel<input name="subdlApiKey" type="password" autocomplete="new-password"></label>
<label>TorBox API key (optional) / API-sleutel (optioneel)<input name="torboxApiKey" type="password" autocomplete="new-password"></label>
<details><summary>Optional AI translation / Optionele AI-vertaling</summary>
<p>Only when your language is missing, using an endpoint approved by this host. Text leaves this server for that endpoint and may incur costs. / Alleen als je taal ontbreekt, via een door de beheerder toegestaan endpoint. De tekst gaat naar dat endpoint en kan kosten veroorzaken.</p>
${process.env.TRANSLATION_LIBRARY_DIR && process.env.TRANSLATION_LIBRARY_SHARED === "true" ? '<label><input style="width:auto;margin-right:.5rem" type="checkbox" name="librarySharingConsent">Allow other users on this host to reuse my saved translations. API keys remain private. Shared copies remain until the operator deletes them.</label>' : ''}
<label>AI translation / AI-vertaling<select name="aiEnabled"><option value="">Disabled / Uit</option><option value="true">Enabled / Aan</option></select></label>
<label>API base URL / API-basis-URL<input name="aiBaseUrl" type="url" placeholder="https://your-gateway.example/v1"></label>
<label>AI API key (optional for local servers) / AI-sleutel (optioneel voor lokale servers)<input name="aiApiKey" type="password" autocomplete="new-password"></label>
<label>Model<input name="aiModel"></label>
<label>Source languages / Brontalen<input name="aiSourceLanguages" placeholder="en"></label>
<label>Extra headers (JSON, optional) / Extra headers (JSON, optioneel)<input name="aiHeaders" type="password" autocomplete="new-password"></label>
<label>Output token parameter / Uitvoertokenparameter<select name="aiTokenParameter"><option value="">Host default / Standaard beheerder</option><option>max_tokens</option><option>max_completion_tokens</option></select></label>
<label>JSON response mode / JSON-antwoordmodus<select name="aiJsonMode"><option value="">Host default / Standaard beheerder</option><option value="off">Prompt only / Alleen prompt</option><option value="object">JSON object</option></select></label>
</details>
<label>Subtitle languages / Ondertiteltalen<input name="languages" value="nl"></label>
<label>Reference languages / Referentietalen<input name="anchorLanguages" value="en"></label>
<label>Format / Formaat<select name="format"><option>srt</option><option>vtt</option></select></label>
<button>Create private installation / Privé-installatie maken</button></form>
<p>Copy the resulting URL into Stremio → Addons → Add addon. / Plak de resulterende URL in Stremio → Addons → Addon toevoegen.</p>
<output id="result" aria-live="polite"></output>
<label>Installation URL or token to revoke / Installatielink of token om in te trekken<input id="revokeToken" type="password" autocomplete="off"></label><button id="revoke">Revoke this installation / Deze installatie intrekken</button>
<p>To replace keys, create a new installation and revoke the old one. / Maak bij nieuwe sleutels een nieuwe installatie en trek de oude in.</p>
<script>
const form=document.getElementById('profile'), result=document.getElementById('result'), revoke=document.getElementById('revoke');
const access=document.getElementById('revokeToken');
form.onsubmit=async function(event){event.preventDefault();result.textContent='Saving / Opslaan…';
try{const config=Object.fromEntries(new FormData(form));const response=await fetch('/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});
const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed / Aanvraag mislukt');
access.value=data.profile;result.textContent=data.manifestUrl;
for(const name of ['osApiKey','osUsername','osPassword','subdlApiKey','torboxApiKey','aiApiKey','aiHeaders'])form.elements[name].value='';
}catch(error){result.textContent=error.message;}};
revoke.onclick=async function(){try{let token=access.value.trim();if(!token.startsWith('p_'))token=JSON.parse(decodeURIComponent(new URL(token).pathname.split('/')[1])).profile;const response=await fetch('/profiles/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:token})});if(!response.ok)throw new Error('Revocation failed / Intrekken mislukt');result.textContent='Revoked / Ingetrokken';access.value='';}catch(error){result.textContent=error.message;}};
</script></html>`;
}
