// Live checklist of the shared password policy, rendered under every input
// that sets a password. Each rule flips as the user types, so the policy is
// visible before the first refusal rather than explained by it.

import { Check, Circle } from 'lucide-react';
import { PASSWORD_RULES } from '@liedmotif/shared';
import { cn } from '@/lib/cn';

export function PasswordRequirements({ password }: { password: string }) {
  return (
    <ul className="flex flex-col gap-1 text-[11.5px]" aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.met(password);
        return (
          <li
            key={rule.id}
            className={cn('flex items-center gap-2', met ? 'text-signal' : 'text-dim')}
          >
            {met ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <Circle className="h-2 w-2 shrink-0 [&]:mx-[3px]" aria-hidden />
            )}
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}
