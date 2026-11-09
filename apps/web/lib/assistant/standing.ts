// The Assistant standing at the HTTP edge: when it refuses a message, and how
// a response reports it.

import type { NextResponse } from 'next/server';
import { ASSISTANT_STANDING_HEADER, type AssistantStanding } from '@liedmotif/shared';
import { apiError } from '@/lib/api-response';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';

/** Whether a message sent on this standing would be accepted. */
export function mayAskAssistant(standing: AssistantStanding): boolean {
  return standing.enabled && standing.allowance?.remaining !== 0;
}

/** The header an answer, and a refusal for access or allowance, reports the standing in. */
export function assistantStandingHeaders(standing: AssistantStanding): Record<string, string> {
  return { [ASSISTANT_STANDING_HEADER]: JSON.stringify(standing) };
}

/**
 * The refusal for a standing that does not allow a message. Neither is
 * retryable as sent: one waits for the Admin, the other for the next day.
 */
export function assistantRefusal(standing: AssistantStanding): NextResponse {
  const headers = assistantStandingHeaders(standing);
  if (!standing.enabled) {
    return apiError(
      'assistant_access_off',
      `${ASSISTANT_NAME} is switched off for your account. Ask your Admin to switch it on.`,
      { headers },
    );
  }
  return apiError('assistant_allowance_used_up', 'You have used all of your messages for today.', {
    headers,
  });
}
