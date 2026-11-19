// The login form's wording for a refused sign-in. Only a credential refusal may
// say the password is wrong: a browser on a second address for the instance
// (127.0.0.1 next to localhost, a LAN IP next to the domain) is refused by
// Better Auth's origin check with correct credentials, and calling that a wrong
// password sends people into password resets that cannot help.

export const WRONG_CREDENTIALS_MESSAGE = 'Incorrect email or password.';
export const SIGN_IN_RATE_LIMITED_MESSAGE =
  'Too many failed sign-in attempts. Wait a few minutes, then try again.';
export const WRONG_ADDRESS_MESSAGE =
  'Sign-in only works at the address Liedmotif was set up with. Open Liedmotif there, then try again.';
export const SIGN_IN_FAILED_MESSAGE = 'Could not sign in. Try again.';

/** Better Auth's 403 codes for an `Origin` it does not trust. */
const ORIGIN_REFUSAL_CODES = new Set(['INVALID_ORIGIN', 'MISSING_OR_NULL_ORIGIN']);

/**
 * The message for a failed `POST /api/auth/sign-in/email`, from its status and
 * Better Auth's error `code`. A 401 is every credential refusal, a disabled
 * Member's included (deliberately indistinguishable); a 400 is an email or
 * password the endpoint would not even check, which is still the visitor's input.
 */
export function signInErrorMessage(status: number, code: string | undefined): string {
  if (status === 401 || status === 400) return WRONG_CREDENTIALS_MESSAGE;
  if (status === 429) return SIGN_IN_RATE_LIMITED_MESSAGE;
  if (status === 403 && code !== undefined && ORIGIN_REFUSAL_CODES.has(code)) {
    return WRONG_ADDRESS_MESSAGE;
  }
  return SIGN_IN_FAILED_MESSAGE;
}
