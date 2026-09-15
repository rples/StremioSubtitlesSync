import type { Manifest } from "stremio-addon-sdk";
import landingTemplate from "stremio-addon-sdk/src/landingTemplate";

/**
 * The SDK's install button emits a `stremio://` link and nothing else. That
 * link loses the port on some Stremio builds and is rewritten to https, which
 * fails against a local addon. So the page also shows the plain URL to paste
 * into Stremio's "Add addon" box, built from the page's own origin so the
 * scheme and port are always right.
 *
 * Blank fields are left out of the URL. An instance that gets its API key from
 * the environment therefore installs from a short URL with no config segment
 * at all, and no password ever travels in a link.
 */
const INSTALL_BY_URL = `
<div style="max-width:100%;margin:1.5em auto 0;padding:1em 1.2em;border-radius:8px;background:rgba(0,0,0,0.35);text-align:left;">
  <div style="font-weight:600;margin-bottom:0.4em;">Or install by URL</div>
  <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.8em;">
    In Stremio open Addons and use "Add addon". Paste the whole line below,
    keeping the http:// and the port number.
  </div>
  <div style="display:flex;gap:0.5em;">
    <input id="directUrl" readonly
      style="flex:1;min-width:0;padding:0.5em;border-radius:4px;border:none;font-family:monospace;font-size:0.85em;">
    <button id="copyDirect" type="button"
      style="padding:0.5em 1em;border-radius:4px;border:none;cursor:pointer;">Copy</button>
  </div>
</div>
<script>
(function () {
  var output = document.getElementById('directUrl');
  var button = document.getElementById('copyDirect');
  var form = document.getElementById('mainForm');

  function build() {
    var url = window.location.origin + '/';
    if (form) {
      var config = {};
      new FormData(form).forEach(function (value, key) {
        if (String(value).length > 0) config[key] = value;
      });
      if (Object.keys(config).length > 0) {
        url += encodeURIComponent(JSON.stringify(config)) + '/';
      }
    }
    output.value = url + 'manifest.json';
  }

  build();
  if (form) {
    form.addEventListener('change', build);
    form.addEventListener('input', build);
  }

  button.onclick = function () {
    output.select();
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(output.value).then(done, done);
    } else {
      document.execCommand('copy');
      done();
    }
  };
})();
</script>
`;

export function landingPage(manifest: Manifest): string {
  return landingTemplate(manifest).replace("</body>", INSTALL_BY_URL + "</body>");
}
