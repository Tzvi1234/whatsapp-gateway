/** Distinct exit codes that systemd must NOT restart on. */
export const EXIT_LOGGED_OUT = 41;
export const EXIT_NUMBER_GUARD = 42;
export const EXIT_PAIRING_REQUIRED = 43;
export const EXIT_CONFLICT = 44;
export const EXIT_BAD_SESSION = 50;
/** EX_CONFIG: missing/unsafe key file, bad env. */
export const EXIT_CONFIG = 78;

export const RESTART_PREVENT_EXIT_STATUS = [
  EXIT_LOGGED_OUT,
  EXIT_NUMBER_GUARD,
  EXIT_PAIRING_REQUIRED,
  EXIT_CONFLICT,
  EXIT_BAD_SESSION,
  EXIT_CONFIG,
].join(' ');
