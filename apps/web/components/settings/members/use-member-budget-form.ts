'use client';

// The budget form's state, shared by the invite form, the per-Member editor,
// and the Pool panel: the kind, every field as typed, and per-field errors —
// setting a field clears that field's error. The Pool has no kind and leaves
// it at its default, unread.

import { useCallback, useState } from 'react';
import type { BudgetKind } from '@liedmotif/shared';
import type {
  MemberBudgetErrors,
  MemberBudgetField,
  MemberBudgetFormValues,
} from './members-admin-model';

export function useMemberBudgetForm(
  initial: () => MemberBudgetFormValues,
  initialKind: BudgetKind = 'rolling',
) {
  const [kind, setKind] = useState<BudgetKind>(initialKind);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<MemberBudgetErrors>({});

  const change = useCallback((field: MemberBudgetField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  return { kind, setKind, values, setValues, errors, change, setErrors };
}
