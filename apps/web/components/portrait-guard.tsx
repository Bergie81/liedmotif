import { Smartphone } from 'lucide-react';

/**
 * Portrait is the only orientation the app is laid out for. Android WebAPKs
 * enforce that from the manifest's `orientation` member, but iOS home-screen
 * apps ignore it and Safari exposes no Screen Orientation lock — so on iOS
 * landscape is covered rather than prevented. `.portrait-guard` is display:none
 * everywhere except an installed app rendering landscape on a phone-sized
 * screen, which is why this can sit in the root layout unconditionally.
 */
export function PortraitGuard() {
  return (
    <div className="portrait-guard">
      <Smartphone aria-hidden className="size-8 text-lamp" />
      <p className="font-display text-lg text-paper">Turn Your Phone Upright</p>
      <p className="text-[13px] text-muted">Liedmotif plays in portrait.</p>
    </div>
  );
}
