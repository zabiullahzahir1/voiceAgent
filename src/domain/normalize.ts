/**
 * Normalisation helpers — the bridge between *spoken* input and *stored* data.
 *
 * A speech-to-text transcript is messy in ways a web form never is. Callers say
 * "California", not "C-A"; "john at gmail dot com", not "john@gmail.com";
 * "March fifth nineteen eighty-five" arrives from the LLM as any of a dozen
 * date formats. Rather than push that burden onto the prompt (where it is
 * unreliable and unverifiable), we accept a generous range of inputs here and
 * collapse everything to one canonical representation before it reaches the
 * database.
 *
 * Every function is pure and independently unit-tested — see `tests/`.
 */

// --- Names -----------------------------------------------------------------

/** Collapse whitespace and trim. Applied to every free-text field. */
export function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Titlecase a spoken name while preserving internal punctuation:
 * "mary-jane o'brien" -> "Mary-Jane O'Brien".
 */
export function normalizeName(value: string): string {
  return squish(value)
    .toLowerCase()
    .replace(/(^|[\s\-'])([\p{L}])/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

// --- Phone numbers ---------------------------------------------------------

/**
 * Reduce any spoken/typed U.S. number to 10 digits, or return null.
 *
 * Rejects the classic bad inputs the assessment calls out (a 3-digit number)
 * plus NANP-invalid numbers: area code and exchange code may not begin with
 * 0 or 1, which is what catches transcription garbage like "111-111-1111".
 */
export function normalizePhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');

  // Strip the U.S. country code if the caller included it.
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;

  const areaCode = digits.slice(0, 3);
  const exchange = digits.slice(3, 6);
  if (areaCode[0] === '0' || areaCode[0] === '1') return null;
  if (exchange[0] === '0' || exchange[0] === '1') return null;

  return digits;
}

/** Render 10 stored digits for display: "4155550123" -> "(415) 555-0123". */
export function formatPhone(digits: string): string {
  if (digits.length !== 10) return digits;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Render 10 stored digits for *speech*: "415 555 0123" reads back cleanly. */
export function speakPhone(digits: string): string {
  if (digits.length !== 10) return digits.split('').join(' ');
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

// --- Dates -----------------------------------------------------------------

const MAX_AGE_YEARS = 130;

/**
 * Accept the date formats an LLM realistically emits and return `YYYY-MM-DD`.
 *
 * Returns a discriminated result rather than throwing so the caller can turn
 * the specific reason ("that date is in the future") into a spoken re-prompt.
 */
export type DateResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'unparseable' | 'invalid_date' | 'future' | 'too_old' };

export function normalizeDateOfBirth(input: string): DateResult {
  const raw = squish(input);

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;

  // YYYY-MM-DD (ISO — what a well-behaved LLM sends)
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  // MM/DD/YYYY (the U.S. spoken order the assessment specifies)
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw);

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  } else {
    return { ok: false, reason: 'unparseable' };
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, reason: 'invalid_date' };
  }

  // Round-trip through UTC to reject impossible calendar dates such as
  // 02/30/1990 or 04/31/2001, which the range check above lets through.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, reason: 'invalid_date' };
  }

  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  if (date.getTime() > todayUtc.getTime()) return { ok: false, reason: 'future' };

  const earliest = new Date(todayUtc);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - MAX_AGE_YEARS);
  if (date.getTime() < earliest.getTime()) return { ok: false, reason: 'too_old' };

  const pad = (n: number) => String(n).padStart(2, '0');
  return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` };
}

/** "1985-03-05" -> "March 5, 1985", for reading a record back to the caller. */
export function speakDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

// --- U.S. states -----------------------------------------------------------

/** 50 states + DC + inhabited territories, keyed by the spoken full name. */
const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
  'puerto rico': 'PR', guam: 'GU', 'american samoa': 'AS',
  'us virgin islands': 'VI', 'u.s. virgin islands': 'VI', 'virgin islands': 'VI',
  'northern mariana islands': 'MP',
};

export const VALID_STATE_CODES: ReadonlySet<string> = new Set(Object.values(STATE_BY_NAME));

/**
 * Accept either the abbreviation or the spoken full name.
 * "california" | "CA" | "c a" -> "CA". Returns null if unrecognised.
 */
export function normalizeState(value: string): string | null {
  const cleaned = squish(value).toLowerCase();

  const byName = STATE_BY_NAME[cleaned];
  if (byName) return byName;

  // "c a" / "c.a." — a spelled-out abbreviation from the transcript.
  const letters = cleaned.replace(/[^a-z]/g, '');
  if (letters.length === 2) {
    const code = letters.toUpperCase();
    return VALID_STATE_CODES.has(code) ? code : null;
  }

  return null;
}

// --- ZIP codes -------------------------------------------------------------

/** "94107" or "94107-1234" (also accepts 9 unbroken digits). Null if invalid. */
export function normalizeZip(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return null;
}

// --- Email -----------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Repair the way email addresses survive speech-to-text before validating.
 * "john dot smith at gmail dot com" -> "john.smith@gmail.com".
 */
export function normalizeEmail(value: string): string | null {
  const spoken = squish(value)
    .toLowerCase()
    .replace(/\s*\(at\)\s*|\s+at\s+/g, '@')
    .replace(/\s*\(dot\)\s*|\s+dot\s+/g, '.')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+dash\s+|\s+hyphen\s+/g, '-')
    .replace(/\s+/g, '');

  return EMAIL_RE.test(spoken) ? spoken : null;
}

// --- Sex -------------------------------------------------------------------

export const SEX_VALUES = ['Male', 'Female', 'Other', 'Decline to Answer'] as const;
export type Sex = (typeof SEX_VALUES)[number];

/** Map the many ways a caller phrases this onto the four allowed enum values. */
export function normalizeSex(value: string): Sex | null {
  const v = squish(value).toLowerCase().replace(/[^a-z ]/g, '');

  if (['m', 'male', 'man', 'boy'].includes(v)) return 'Male';
  if (['f', 'female', 'woman', 'girl'].includes(v)) return 'Female';
  if (['o', 'other', 'nonbinary', 'non binary', 'nb', 'intersex'].includes(v)) return 'Other';
  if (
    v.includes('decline') ||
    v.includes('prefer not') ||
    v.includes('rather not') ||
    v.includes('skip') ||
    v === 'n/a'
  ) {
    return 'Decline to Answer';
  }
  return null;
}
