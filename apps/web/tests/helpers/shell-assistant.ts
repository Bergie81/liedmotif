// The Assistant as the app shell wires it: the shell holds whether the panel is
// open, hands that to the dock, and lends the page (`children`) the launcher.

import { createElement as h, Fragment, type ComponentProps, type ReactNode } from 'react';
import { AssistantDock } from '@/components/assistant/assistant-dock';
import {
  AssistantLauncherContext,
  useAssistantLauncher,
} from '@/components/assistant/assistant-launcher';

export function ShellAssistant({
  children,
  ...dock
}: Omit<ComponentProps<typeof AssistantDock>, 'open' | 'onOpenChange'> & {
  children?: ReactNode;
}) {
  const assistant = useAssistantLauncher();
  return h(
    Fragment,
    null,
    h(AssistantLauncherContext.Provider, { value: assistant.launcher }, children),
    h(AssistantDock, { ...dock, open: assistant.open, onOpenChange: assistant.setOpen }),
  );
}
