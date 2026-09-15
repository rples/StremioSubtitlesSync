/**
 * Stremio shows the `lang` field of a subtitle straight to the user. A valid
 * ISO 639-2 code is turned into a language name with a flag; anything else is
 * printed as written. That gives us two label styles: strict codes, or a
 * readable name plus how the timing was obtained.
 */

/** OpenSubtitles uses 2-letter codes; ISO 639-2/B is what Stremio looks for. */
const ISO_639_2: Record<string, string> = {
  ar: "ara", bg: "bul", bn: "ben", bs: "bos", ca: "cat", cs: "cze", da: "dan",
  de: "ger", el: "gre", en: "eng", eo: "epo", es: "spa", et: "est", eu: "baq",
  fa: "per", fi: "fin", fr: "fre", gl: "glg", he: "heb", hi: "hin", hr: "hrv",
  hu: "hun", id: "ind", is: "ice", it: "ita", ja: "jpn", ka: "geo", kk: "kaz",
  km: "khm", ko: "kor", lt: "lit", lv: "lav", mk: "mac", ml: "mal", ms: "may",
  nl: "dut", no: "nor", pl: "pol", pt: "por", ro: "rum", ru: "rus", si: "sin",
  sk: "slo", sl: "slv", sq: "alb", sr: "srp", sv: "swe", sw: "swa", ta: "tam",
  te: "tel", th: "tha", tl: "tgl", tr: "tur", uk: "ukr", ur: "urd", vi: "vie",
  "pt-br": "pob", "pt-pt": "por", "zh-cn": "chi", "zh-tw": "zht",
};

let displayNames: Intl.DisplayNames | undefined;

/** "pl" -> "Polish". Falls back to the code itself when it is not recognised. */
export function languageName(code: string): string {
  const special: Record<string, string> = {
    "pt-br": "Portuguese (BR)",
    "pt-pt": "Portuguese (PT)",
    "zh-cn": "Chinese (Simplified)",
    "zh-tw": "Chinese (Traditional)",
  };
  const known = special[code];
  if (known) return known;

  try {
    displayNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    const name = displayNames.of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name;
  } catch {
    // Intl without the language data: fall through to the raw code.
  }
  return code.toUpperCase();
}

export function iso639_2(code: string): string {
  return ISO_639_2[code.toLowerCase()] ?? code;
}
