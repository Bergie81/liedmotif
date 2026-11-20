// Step 1 — the owner's own profile: the name is the only required field.
//
// The avatar uploads on select through its own route, so Continue carries the text
// fields plus the reset timezone — and it saves them before advancing, because the
// People step seeds the owner Person from the name typed here.
//
// The timezone is asked beside the city, where it reads as a personal detail, but it
// is stored instance-wide (`usageLimits.resetTimezone`) because it decides when the
// daily and monthly Track windows roll over. Only the Admin's welcome asks it, so
// the person answering is the one who sets that instance-wide value.

'use client';

import { useState } from 'react';
import type { ListenerProfile } from '@liedmotif/db';
import {
  MAX_EMAIL_LENGTH,
  MAX_PROFILE_ARTIST_NAME_LENGTH,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  MAX_PROFILE_FIELD_LENGTH,
  MAX_USER_NAME_LENGTH,
} from '@liedmotif/shared';
import { AvatarUploader } from '@/components/settings/avatar-uploader';
import { ProfileField } from '@/components/settings/profile-field';
import {
  profileFieldErrorsForServerMessage,
  validateProfile,
  type ProfileFieldErrors,
} from '@/components/settings/profile-form-model';
import { TimezoneSelect } from '@/components/timezone-select';
import { saveListenerProfile, saveUsageLimits } from '@/lib/settings/settings-client';
import {
  OnboardingActions,
  OnboardingCard,
  OnboardingError,
  OnboardingPrimaryAction,
  OnboardingStepHeader,
} from './onboarding-layout';

export function OnboardingProfileStep({
  profile,
  avatarUrl,
  timezone,
  withDescription = false,
  onChange,
  onAvatarChange,
  onSaved,
}: {
  profile: ListenerProfile;
  avatarUrl: string | null;
  /**
   * The instance limit-reset zone. Admin-only: it writes through the admin
   * limits route, so the Member welcome omits it — no field, no write; the
   * zone is the Admin's to set.
   */
  timezone?: { value: string; onChange: (timezone: string) => void };
  /** Asks for the Lounge card's Short description; the Member welcome sets it. */
  withDescription?: boolean;
  onChange: (profile: ListenerProfile) => void;
  /** The photo uploads on select, so the wizard hears about it as it happens. */
  onAvatarChange: (imageUrl: string | null) => void;
  /** Both writes landed. The saved profile itself goes back through `onChange`. */
  onSaved: () => void | Promise<void>;
}) {
  const [errors, setErrors] = useState<ProfileFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField(key: keyof ListenerProfile, value: string) {
    onChange({ ...profile, [key]: value });
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setError(null);
    const found = validateProfile(profile);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    const result = await saveListenerProfile(profile);
    if (!result.ok) {
      setSaving(false);
      const fromServer = profileFieldErrorsForServerMessage(result.error);
      if (Object.keys(fromServer).length > 0) setErrors(fromServer);
      else setError(result.error);
      return;
    }
    onChange(result.value.profile);
    // The timezone lives in the instance limits, so it is a second write; the profile
    // is already stored by here, and a failed zone leaves the owner on this screen
    // with the reason rather than silently past it.
    if (timezone) {
      const zone = await saveUsageLimits({ resetTimezone: timezone.value });
      if (!zone.ok) {
        setSaving(false);
        setError(zone.error);
        return;
      }
    }
    setSaving(false);
    await onSaved();
  }

  return (
    <section>
      <OnboardingStepHeader title="Welcome. What Should We Call You?">
        We only need your name. The rest is optional.
      </OnboardingStepHeader>

      <OnboardingCard>
        <div className="space-y-6">
          <div className="grid gap-6 desk:grid-cols-2">
            <ProfileField
              label="First name"
              value={profile.name}
              maxLength={MAX_USER_NAME_LENGTH}
              placeholder="Your first name"
              error={errors.name}
              disabled={saving}
              onChange={(value) => setField('name', value)}
            />
            {/* Read-only: this is the address that just signed in, and changing a
                login identifier belongs in Settings → Profile, not here. */}
            <ProfileField
              label="Email"
              type="email"
              value={profile.email}
              maxLength={MAX_EMAIL_LENGTH}
              readOnly
              error={errors.email}
              onChange={(value) => setField('email', value)}
            />
          </div>
          <ProfileField
            label="Artist name"
            optional
            value={profile.artistName}
            maxLength={MAX_PROFILE_ARTIST_NAME_LENGTH}
            placeholder={profile.name || 'Defaults to your name'}
            hint="The artist on tracks you download. Leave it empty to use your name."
            error={errors.artistName}
            disabled={saving}
            onChange={(value) => setField('artistName', value)}
          />
          <div>
            <span className="mb-2 flex items-baseline justify-between gap-2 text-[13px] font-semibold text-paper">
              Profile image
              <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
                OPTIONAL
              </span>
            </span>
            <AvatarUploader
              name={profile.name}
              initialImageUrl={avatarUrl}
              onImageChange={onAvatarChange}
            />
          </div>
          {/* The hint belongs to the two fields above it, so it stays closer to them
              than the fields are to each other. */}
          <div className="space-y-2">
            <div className="grid gap-6 desk:grid-cols-2">
              <ProfileField
                label="City"
                optional
                value={profile.city}
                maxLength={MAX_PROFILE_FIELD_LENGTH}
                error={errors.city}
                disabled={saving}
                onChange={(value) => setField('city', value)}
              />
              <ProfileField
                label="Country"
                optional
                value={profile.country}
                maxLength={MAX_PROFILE_FIELD_LENGTH}
                error={errors.country}
                disabled={saving}
                onChange={(value) => setField('country', value)}
              />
            </div>
            <p className="text-[11.5px] leading-[1.5] text-dim">
              The text AI can use this to give sessions a sense of place.
            </p>
          </div>
          {withDescription ? (
            <ProfileField
              label="Short description"
              optional
              value={profile.description}
              maxLength={MAX_PROFILE_DESCRIPTION_LENGTH}
              hint="Shown on your profile card in the Lounge."
              error={errors.description}
              disabled={saving}
              onChange={(value) => setField('description', value)}
            />
          ) : null}
          {timezone ? (
            <label className="flex flex-col gap-2 text-[13px] font-semibold text-paper">
              Timezone
              <TimezoneSelect
                value={timezone.value}
                onChange={timezone.onChange}
                ariaLabel="Timezone"
                disabled={saving}
              />
              <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
                Sets when track limits reset and when backups run.
              </span>
            </label>
          ) : null}
        </div>
      </OnboardingCard>

      <OnboardingError error={error} />

      <OnboardingActions>
        <OnboardingPrimaryAction
          label="Continue"
          busyLabel="Saving…"
          busy={saving}
          disabled={!profile.name.trim()}
          onClick={() => void save()}
        />
      </OnboardingActions>
    </section>
  );
}
