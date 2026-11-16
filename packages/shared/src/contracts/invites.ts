// Invite Mode one-shot link contracts: the claim, password-reset,
// email-confirm, and forgot-password request bodies, shared by the
// unauthenticated routes and their forms — plus the signed-in password change
// that stands in for a mailed reset link while account email is off, and the
// reply the Admin's Member reset card reads.

import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, passwordSchema } from '../password';
import { updateMemberLimitsRequestSchema } from './member-budgets';
import { MAX_EMAIL_LENGTH, MAX_USER_NAME_LENGTH } from './profile-limits';

/** Room for 32 random bytes in base64url, with margin for future token shapes. */
const linkToken = z.string().min(1).max(256);

const password = passwordSchema;

const email = z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email());

export const claimInviteRequestSchema = z.strictObject({
  token: linkToken,
  name: z.string().trim().min(1).max(MAX_USER_NAME_LENGTH),
  email,
  password,
});
export type ClaimInviteRequest = z.infer<typeof claimInviteRequestSchema>;

export const resetPasswordRequestSchema = z.strictObject({
  token: linkToken,
  password,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const confirmEmailRequestSchema = z.strictObject({ token: linkToken });
export type ConfirmEmailRequest = z.infer<typeof confirmEmailRequestSchema>;

export const forgotPasswordRequestSchema = z.strictObject({ email });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/**
 * The current password is capped at the policy's maximum: no stored password is
 * longer, so a longer guess is never right, and the cap bounds the hash work one
 * guess costs.
 */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: password,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * Admin mints an invite: a label plus the starting budget as a partial
 * `MemberLimits` patch (in provider tasks, like every stored budget) merged
 * over the defaults server-side. `email` is the address the Invite is mailed to
 * and binds as the Member's login: required while account email is on, refused
 * while it is off — the route decides, since only the server knows the mode.
 */
export const createMemberInviteRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(MAX_USER_NAME_LENGTH),
  budget: updateMemberLimitsRequestSchema.optional(),
  email: email.optional(),
});
export type CreateMemberInviteRequest = z.infer<typeof createMemberInviteRequestSchema>;

/** Why an Admin's Member reset came back as a link to copy instead of a mail. */
export type MemberResetFallbackReason = 'email_off' | 'unconfirmed' | 'disabled' | 'send_failed';

/**
 * The Admin's Member reset: mailed to the Member's Confirmed email, or a link
 * to copy and the reason it was not mailed. A mailed link never comes back.
 */
export type MemberResetPasswordResponse =
  { sent: true; to: string } | { url: string; reason: MemberResetFallbackReason };
