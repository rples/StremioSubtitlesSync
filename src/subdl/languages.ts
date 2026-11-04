/** SubDL returns either ISO codes or legacy language names. */
const NAMES: Record<string, string> = {
  arabic: "ar", bengali: "bn", bosnian: "bs", bulgarian: "bg", burmese: "my",
  catalan: "ca", chinese: "zh-cn", croatian: "hr", czech: "cs", danish: "da",
  dutch: "nl", english: "en", esperanto: "eo", estonian: "et", farsi_persian: "fa",
  finnish: "fi", french: "fr", georgian: "ka", german: "de", greek: "el",
  hebrew: "he", hindi: "hi", hungarian: "hu", icelandic: "is", indonesian: "id",
  italian: "it", japanese: "ja", korean: "ko", latvian: "lv", lithuanian: "lt",
  macedonian: "mk", malay: "ms", malayalam: "ml", norwegian: "no", persian: "fa",
  polish: "pl", portuguese: "pt", brazilian_portuguese: "pt-br", portuguese_br: "pt-br",
  romanian: "ro", russian: "ru", serbian: "sr", sinhala: "si", slovak: "sk",
  slovenian: "sl", spanish: "es", swedish: "sv", tagalog: "tl", tamil: "ta",
  telugu: "te", thai: "th", turkish: "tr", ukrainian: "uk", urdu: "ur", vietnamese: "vi",
  dut: "nl", nld: "nl", eng: "en", chi: "zh-cn", zho: "zh-cn",
};

export function subdlLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase().replace(/[ -]/g, "_");
  return NAMES[code] ?? (/^[a-z]{2}(?:_[a-z]{2})?$/.test(code) ? code.replace("_", "-") : undefined);
}
