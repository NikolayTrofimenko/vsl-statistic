/**
 * Countries and languages the creative library talks about. Shared by the
 * server (guessing a creative's geo from its file name) and the UI (filters,
 * labels). Plain data — compiled by both toolchains.
 */

/** ISO 3166-1 alpha-2 → Russian name. The markets the team actually runs. */
export const COUNTRIES: Record<string, string> = {
  // Europe
  ES: 'Испания',
  IT: 'Италия',
  PT: 'Португалия',
  FR: 'Франция',
  DE: 'Германия',
  AT: 'Австрия',
  CH: 'Швейцария',
  BE: 'Бельгия',
  NL: 'Нидерланды',
  PL: 'Польша',
  CZ: 'Чехия',
  SK: 'Словакия',
  HU: 'Венгрия',
  RO: 'Румыния',
  BG: 'Болгария',
  GR: 'Греция',
  HR: 'Хорватия',
  SI: 'Словения',
  RS: 'Сербия',
  BA: 'Босния',
  LT: 'Литва',
  LV: 'Латвия',
  EE: 'Эстония',
  CY: 'Кипр',
  // Latin America
  MX: 'Мексика',
  CO: 'Колумбия',
  PE: 'Перу',
  CL: 'Чили',
  AR: 'Аргентина',
  EC: 'Эквадор',
  BO: 'Боливия',
  PY: 'Парагвай',
  UY: 'Уругвай',
  VE: 'Венесуэла',
  GT: 'Гватемала',
  CR: 'Коста-Рика',
  PA: 'Панама',
  DO: 'Доминикана',
  HN: 'Гондурас',
  SV: 'Сальвадор',
  NI: 'Никарагуа',
  BR: 'Бразилия',
  // Asia, Africa, other
  IN: 'Индия',
  ID: 'Индонезия',
  MY: 'Малайзия',
  PH: 'Филиппины',
  TH: 'Таиланд',
  VN: 'Вьетнам',
  TR: 'Турция',
  KZ: 'Казахстан',
  UZ: 'Узбекистан',
  AE: 'ОАЭ',
  SA: 'Саудовская Аравия',
  EG: 'Египет',
  MA: 'Марокко',
  DZ: 'Алжир',
  TN: 'Тунис',
  NG: 'Нигерия',
  KE: 'Кения',
  TZ: 'Танзания',
  ZM: 'Замбия',
  ZA: 'ЮАР',
  US: 'США',
  GB: 'Великобритания',
};

/** ISO 639-1 → Russian name, for languages whisper reports. */
export const LANGUAGES: Record<string, string> = {
  es: 'Испанский',
  it: 'Итальянский',
  pt: 'Португальский',
  fr: 'Французский',
  de: 'Немецкий',
  nl: 'Нидерландский',
  pl: 'Польский',
  cs: 'Чешский',
  sk: 'Словацкий',
  hu: 'Венгерский',
  ro: 'Румынский',
  bg: 'Болгарский',
  el: 'Греческий',
  hr: 'Хорватский',
  sl: 'Словенский',
  sr: 'Сербский',
  bs: 'Боснийский',
  lt: 'Литовский',
  lv: 'Латышский',
  et: 'Эстонский',
  en: 'Английский',
  ru: 'Русский',
  uk: 'Украинский',
  tr: 'Турецкий',
  ar: 'Арабский',
  hi: 'Хинди',
  id: 'Индонезийский',
  ms: 'Малайский',
  tl: 'Филиппинский',
  th: 'Тайский',
  vi: 'Вьетнамский',
  kk: 'Казахский',
  uz: 'Узбекский',
};

/** Full country names that show up in file names instead of a code. */
const NAME_ALIASES: Record<string, string> = {
  india: 'IN',
  mexico: 'MX',
  colombia: 'CO',
  peru: 'PE',
  chile: 'CL',
  spain: 'ES',
  italy: 'IT',
  italia: 'IT',
  portugal: 'PT',
  brazil: 'BR',
  brasil: 'BR',
  argentina: 'AR',
  ecuador: 'EC',
  romania: 'RO',
  bulgaria: 'BG',
  greece: 'GR',
  poland: 'PL',
  hungary: 'HU',
  turkey: 'TR',
  indonesia: 'ID',
  malaysia: 'MY',
  philippines: 'PH',
  latam: '',
};

/**
 * Geo from a file name's leading token: `ES_17.mp4`, `MX 10.mp4`, `IT-3`,
 * `BG.mp4`, `india 5.mp4`. The token must stand alone — `AQPhs…` (a Facebook
 * id that happens to start with Antarctica's code) does not count.
 */
export function geoFromName(name: string): string | null {
  const match = /^\s*([A-Za-z]{2,12})(?=$|[\s_\-.\d(])/.exec(name);
  if (!match) return null;
  const token = match[1]!;
  if (token.length === 2) {
    const code = token.toUpperCase();
    return code in COUNTRIES ? code : null;
  }
  const alias = NAME_ALIASES[token.toLowerCase()];
  return alias || null;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return COUNTRIES[code] ?? code;
}

export function languageName(code: string | null | undefined): string {
  if (!code) return '';
  return LANGUAGES[code] ?? code;
}
