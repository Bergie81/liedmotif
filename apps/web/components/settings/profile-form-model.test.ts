import { describe, expect, it } from 'vitest';
import type { ListenerProfile } from '@liedmotif/db';
import { profileFieldErrorsForServerMessage, validateProfile } from './profile-form-model';

const valid: ListenerProfile = {
  name: 'John',
  email: 'john@example.com',
  city: '',
  country: '',
  artistName: '',
  description: '',
};

describe('profile form validation', () => {
  it('reports required and malformed fields independently', () => {
    expect(validateProfile({ ...valid, name: '', email: 'not-an-email' })).toEqual({
      name: 'Enter a name.',
      email: 'Enter a valid email address.',
    });
  });

  it('accepts optional location and artist fields when blank', () => {
    expect(validateProfile(valid)).toEqual({});
  });

  it('maps safe server validation messages back to every affected field', () => {
    expect(profileFieldErrorsForServerMessage('Enter a valid email address.')).toEqual({
      email: 'Enter a valid email address.',
    });
    expect(
      profileFieldErrorsForServerMessage('Artist name must be text of at most 80 characters.'),
    ).toEqual({ artistName: 'Artist name must be text of at most 80 characters.' });
    expect(
      profileFieldErrorsForServerMessage('Description must be text of at most 160 characters.'),
    ).toEqual({ description: 'Description must be text of at most 160 characters.' });
    expect(profileFieldErrorsForServerMessage('City and country must both be provided.')).toEqual({
      city: 'City and country must both be provided.',
      country: 'City and country must both be provided.',
    });
    expect(profileFieldErrorsForServerMessage('Country must be text.')).toEqual({
      country: 'Country must be text.',
    });
    expect(profileFieldErrorsForServerMessage('Could not save.')).toEqual({});
  });

  // The route's two email-change refusals, verbatim: this mapping is the only
  // thing that puts them on the password field, so a reworded route message
  // that stops matching would silently strand the refusal.
  it('routes both current-password refusals to the password field', () => {
    for (const message of [
      'Enter your current password to change your sign-in address.',
      'That password is not correct.',
    ]) {
      expect(profileFieldErrorsForServerMessage(message)).toEqual({ currentPassword: message });
    }
  });
});
