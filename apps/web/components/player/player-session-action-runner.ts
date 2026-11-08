/** Every action that can hold a single-flight gate; a caller narrows to the
 *  ones its own gate runs. */
export type PlayerSessionAction = 'change-vibe' | 'convert-to-playlist' | 'more-like-this' | 'stop';

export interface PlayerSessionActionGate {
  active: PlayerSessionAction | null;
}

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

export async function runPlayerSessionAction<T, A extends PlayerSessionAction>({
  gate,
  action,
  failureLabel,
  request,
  onBusyChange,
  onFailure,
  onSuccess,
}: {
  gate: PlayerSessionActionGate;
  action: A;
  failureLabel: string;
  request: () => Promise<ActionResult<T>>;
  onBusyChange: (action: A | null) => void;
  onFailure: (error: { action: A; message: string } | null) => void;
  onSuccess: (data: T) => void;
}): Promise<boolean> {
  if (gate.active) return false;

  gate.active = action;
  onFailure(null);
  onBusyChange(action);
  const result = await request();
  gate.active = null;
  onBusyChange(null);

  if (!result.ok) {
    onFailure({ action, message: `${failureLabel}: ${result.error.message}` });
    return false;
  }

  onSuccess(result.data);
  return true;
}
