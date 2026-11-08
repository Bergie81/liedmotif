'use client';

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

type CredentialOperation = 'test' | 'save' | 'delete';

interface CredentialMutationGate {
  pending: CredentialOperation | null;
  begin(operation: CredentialOperation): boolean;
  end(operation: CredentialOperation): void;
}

const CredentialMutationContext = createContext<CredentialMutationGate | null>(null);

export function CredentialMutationGroup({ children }: { children: ReactNode }) {
  const pendingRef = useRef<CredentialOperation | null>(null);
  const [pending, setPending] = useState<CredentialOperation | null>(null);

  const gate: CredentialMutationGate = {
    pending,
    begin(operation) {
      if (pendingRef.current) return false;
      pendingRef.current = operation;
      setPending(operation);
      return true;
    },
    end(operation) {
      if (pendingRef.current !== operation) return;
      pendingRef.current = null;
      setPending(null);
    },
  };

  return (
    <CredentialMutationContext.Provider value={gate}>{children}</CredentialMutationContext.Provider>
  );
}

export function useCredentialMutationGate(): CredentialMutationGate {
  const gate = useContext(CredentialMutationContext);
  if (!gate) throw new Error('Credential controls must be inside CredentialMutationGroup');
  return gate;
}
