// One-shot link URLs, built from `APP_PUBLIC_URL` VERBATIM: a
// private IP or LAN hostname is a legitimate production configuration —
// reachability is the deployer's business, never flagged here.

import { getPublicUrl } from '@/lib/env';

/** Where each flow's address bar ends up once its page has dropped the token. */
export const JOIN_BASE_PATH = '/join';
export const RESET_BASE_PATH = '/reset';
export const CONFIRM_BASE_PATH = '/confirm';

function withPath(path: string): string {
  return `${getPublicUrl().replace(/\/+$/, '')}${path}`;
}

export function joinLinkUrl(token: string): string {
  return withPath(`${JOIN_BASE_PATH}/${token}`);
}

export function resetLinkUrl(token: string): string {
  return withPath(`${RESET_BASE_PATH}/${token}`);
}

export function confirmLinkUrl(token: string): string {
  return withPath(`${CONFIRM_BASE_PATH}/${token}`);
}
