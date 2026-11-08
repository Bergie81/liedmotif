'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ListenerProfile, UserRole } from '@liedmotif/db';
import { MAX_PASSWORD_LENGTH } from '@liedmotif/shared';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { PasswordField } from '@/components/ui/password-field';
import {
  MAX_PROFILE_ARTIST_NAME_LENGTH,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  MAX_PROFILE_EMAIL_LENGTH,
  MAX_PROFILE_FIELD_LENGTH,
} from '@/lib/constants';
import { saveListenerProfile } from '@/lib/settings-client';
import { ChangePasswordButton } from './change-password-dialog';
import { EmailConfirmationStatus, useConfirmLinkRequest } from './email-confirmation';
import { ProfileField } from './profile-field';
import {
  profileFieldErrorsForServerMessage,
  validateProfile,
  type ProfileFieldErrors,
} from './profile-form-model';
import { SettingsFeedback, type SettingsFeedbackState } from './settings-ui';

export function ProfileForm({
  initial,
  role,
  emailConfirmed,
}: {
  initial: ListenerProfile;
  role: UserRole;
  /** Whether the saved address is a Confirmed email; null while account email is off. */
  emailConfirmed: boolean | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [savedEmail, setSavedEmail] = useState(initial.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);
  const confirmLink = useConfirmLinkRequest();

  // Only the Admin moves their sign-in address; the profile route refuses a
  // Member's, so a Member is shown it and never asked to confirm a change.
  const emailEditable = role === 'admin';
  // The email is the sign-in identifier, so the server re-confirms the account
  // owner before it moves — the field only appears for the save that needs it.
  const emailChanged = values.email.trim().toLowerCase() !== savedEmail.trim().toLowerCase();
  // A refusal keeps the field on screen even when this form thinks the address
  // is unchanged: the server is the authority on that, and its answer has to
  // land somewhere the user can act on.
  const asksForPassword =
    emailEditable && (emailChanged || fieldErrors.currentPassword !== undefined);

  function setField(key: keyof ListenerProfile, next: string) {
    setValues((current) => ({ ...current, [key]: next }));
    clearFieldError(key);
  }

  function clearFieldError(key: keyof ProfileFieldErrors) {
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }

  async function save() {
    if (saving) return;
    setFeedback(null);
    const errors = validateProfile(values);
    if (emailChanged && !currentPassword) {
      errors.currentPassword = 'Enter your current password to change your sign-in address.';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    const result = await saveListenerProfile(values, currentPassword || undefined);
    setSaving(false);
    if (result.ok) {
      const { profile, confirmLinkSent } = result.value;
      setValues(profile);
      setSavedEmail(profile.email);
      setCurrentPassword('');
      if (confirmLinkSent === false) {
        setFeedback({
          kind: 'info',
          message:
            'Profile saved, but the confirm link could not be sent. Use Send confirm link to try again.',
        });
      } else if (confirmLinkSent) {
        setFeedback({
          kind: 'success',
          message: `Profile saved. A confirm link went to ${profile.email}.`,
        });
      } else {
        setFeedback({ kind: 'success', message: 'Profile saved.' });
      }
      router.refresh();
      return;
    }
    const serverFieldErrors = profileFieldErrorsForServerMessage(result.error);
    if (Object.keys(serverFieldErrors).length > 0) setFieldErrors(serverFieldErrors);
    else setFeedback({ kind: 'error', message: result.error });
  }

  return (
    <div className="space-y-4">
      <ProfileField
        label="First name"
        value={values.name}
        maxLength={MAX_PROFILE_FIELD_LENGTH}
        error={fieldErrors.name}
        disabled={saving}
        onChange={(value) => setField('name', value)}
      />
      <div className="space-y-2">
        <ProfileField
          label="Email"
          labelAccessory={
            // The state describes the saved address, so it steps aside while
            // an unsaved one is in the field.
            emailConfirmed !== null && !emailChanged ? (
              <EmailConfirmationStatus
                confirmed={emailConfirmed}
                sending={confirmLink.sending}
                onSend={confirmLink.send}
              />
            ) : null
          }
          type="email"
          value={values.email}
          maxLength={MAX_PROFILE_EMAIL_LENGTH}
          hint={emailEditable ? undefined : 'It can’t be changed.'}
          readOnly={!emailEditable}
          error={fieldErrors.email}
          disabled={saving}
          onChange={(value) => setField('email', value)}
        />
        {confirmLink.feedback && !emailChanged ? (
          <SettingsFeedback kind={confirmLink.feedback.kind}>
            {confirmLink.feedback.message}
          </SettingsFeedback>
        ) : null}
      </div>
      {/* The address change's own password check takes the button's place, so a
          Current password field never sits beside a button that reads as its submit. */}
      {asksForPassword ? (
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          value={currentPassword}
          maxLength={MAX_PASSWORD_LENGTH}
          hint="Changing your sign-in address signs you out everywhere else."
          error={fieldErrors.currentPassword}
          disabled={saving}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
            clearFieldError('currentPassword');
          }}
        />
      ) : (
        <div>
          <ChangePasswordButton email={savedEmail} emailConfirmed={emailConfirmed} />
        </div>
      )}
      <div className="grid grid-cols-[1fr_1fr] gap-3">
        <ProfileField
          label="City"
          optional
          value={values.city}
          maxLength={MAX_PROFILE_FIELD_LENGTH}
          error={fieldErrors.city}
          disabled={saving}
          onChange={(value) => setField('city', value)}
        />
        <ProfileField
          label="Country"
          optional
          value={values.country}
          maxLength={MAX_PROFILE_FIELD_LENGTH}
          error={fieldErrors.country}
          disabled={saving}
          onChange={(value) => setField('country', value)}
        />
      </div>
      <ProfileField
        label="Artist name"
        optional
        value={values.artistName}
        maxLength={MAX_PROFILE_ARTIST_NAME_LENGTH}
        placeholder={values.name}
        hint="Written into exported MP3s as the artist."
        error={fieldErrors.artistName}
        disabled={saving}
        onChange={(value) => setField('artistName', value)}
      />
      <ProfileField
        label="Short description"
        optional
        value={values.description}
        maxLength={MAX_PROFILE_DESCRIPTION_LENGTH}
        hint="Shown on your profile card in the Lounge."
        error={fieldErrors.description}
        disabled={saving}
        onChange={(value) => setField('description', value)}
      />
      {feedback ? (
        <SettingsFeedback kind={feedback.kind}>{feedback.message}</SettingsFeedback>
      ) : null}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className={`${primaryButtonClass} w-full`}
      >
        {saving ? 'Saving…' : 'Save profile'}
      </button>
    </div>
  );
}
