import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import {
  cardClass,
  displayHeadingClass,
  eyebrowClass,
  LiedmotifMark,
  LiedmotifWordmark,
} from '@/components/ui/design-system';
import { isAccountEmailEnabled } from '@/lib/env';

// "Forgot password?" from the login page. Only exists while account email is
// on; without a mail server a Member gets back in through the Admin's copy-link
// reset, and the Admin through the recovery CLI.
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  if (!isAccountEmailEnabled()) notFound();
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-[460px] flex-col justify-center px-4 py-10 desk:px-10">
      <div className="mb-10 flex items-center gap-3">
        <LiedmotifMark className="h-8 w-8" />
        <LiedmotifWordmark className="text-[22px]" />
      </div>
      <p className={eyebrowClass}>Password Reset</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Forgot Your Password?</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Enter the email you sign in with. If it is confirmed, we mail you a link to pick a new
        password.
      </p>
      <div className={`${cardClass} mt-7`}>
        <ForgotPasswordForm />
      </div>
      <Link
        href="/login"
        className="mt-6 self-center text-[13.5px] font-semibold text-lamp underline-offset-4 hover:underline"
      >
        Back to Sign In
      </Link>
    </main>
  );
}
