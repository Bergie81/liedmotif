import { describe, expect, it } from 'vitest';
import { musicSetupMessage } from './music-setup-copy';

// One message per role covers every way the music key can be unusable: none
// anywhere, a stored one that cannot be read, or an unknown music provider.
describe('musicSetupMessage', () => {
  it('sends the Admin to the page the Settings hub labels AI Providers', () => {
    expect(musicSetupMessage('admin')).toBe(
      "The music key is missing or can't be read. Enter it under Settings › AI Providers.",
    );
  });

  it('tells a Member to ask the Admin, never naming a settings page', () => {
    const message = musicSetupMessage('member');
    expect(message).toBe("Music isn't set up on this server yet. Ask the Admin to set it up.");
    expect(message).not.toMatch(/Settings/);
  });
});
