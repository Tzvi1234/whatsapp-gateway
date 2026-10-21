import { err, ok, type Result } from './result';
import { gatewayError, type GatewayError } from './errors';

export type PhoneRegion = 'IL';

const COUNTRY_CODE: Record<PhoneRegion, string> = { IL: '972' };

/**
 * Israeli national significant number (no trunk 0):
 *  - mobile 5X + 7 digits (9 digits)
 *  - VoIP / special 7X + 7 digits (9 digits)
 *  - landline 2,3,4,8,9 + 7 digits (8 digits)
 */
const IL_NSN = /^(?:5\d{8}|7\d{8}|[23489]\d{7})$/;

/**
 * The single phone normaliser for UI, API and normalizeJid.
 * `0559014410`, `055-901-4410`, `+972 55 901 4410`, `972559014410` -> `+972559014410`.
 * Only Israeli numbers are accepted in v1; anything else is rejected with `invalid_number`.
 */
export function toE164(
  input: string,
  defaultRegion: PhoneRegion = 'IL',
): Result<string, GatewayError> {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 32)
    return err(gatewayError('invalid_number', 'empty_or_too_long'));
  if (!/^[+\d\s\-().]+$/.test(raw))
    return err(gatewayError('invalid_number', 'invalid_characters'));

  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  const cc = COUNTRY_CODE[defaultRegion];
  let nsn: string;
  if (digits.startsWith(cc) && (hasPlus || digits.length >= cc.length + 8)) {
    nsn = digits.slice(cc.length);
    if (nsn.startsWith('0')) nsn = nsn.slice(1); // "+972 055..." is a common typo
  } else if (hasPlus) {
    return err(gatewayError('invalid_number', 'unsupported_country'));
  } else if (digits.startsWith('0')) {
    nsn = digits.slice(1);
  } else {
    return err(gatewayError('invalid_number', 'missing_trunk_or_country_code'));
  }

  if (!IL_NSN.test(nsn)) return err(gatewayError('invalid_number', 'invalid_length_or_prefix'));
  return ok(`+${cc}${nsn}`);
}

/** Display helper: `+972559014410` -> `+972 55-901-4410`. Input must already be E.164. */
export function formatE164ForDisplay(e164: string): string {
  const m = /^\+972(5\d|7\d)(\d{3})(\d{4})$/.exec(e164);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  const l = /^\+972([23489])(\d{3})(\d{4})$/.exec(e164);
  if (l) return `+972 ${l[1]}-${l[2]}-${l[3]}`;
  return e164;
}

/** Log-safe masking: keeps only the last 4 digits. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  return d.length <= 4 ? '****' : `…${d.slice(-4)}`;
}
