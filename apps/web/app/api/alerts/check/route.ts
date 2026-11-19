// Instance alerts: a host cron curls this route every few minutes (see
// https://liedmotif.com/docs/alerts/). It lives in web rather than on the
// worker's crontab because a check inside the worker could never report the
// worker's death.
// Token-gated and signed-out by design: no session means no ambient credential to
// forge, and the gate costs one digest, cheaper than a limiter's bookkeeping.

import { NextResponse } from 'next/server';
import {
  getAdminConfirmedEmail,
  getStorageUsage,
  getUsageLimits,
  getWorkerQueueStats,
  MAX_TRACK_AUDIO_BYTES,
  readInstanceAlertsState,
  readWorkerHeartbeat,
  writeInstanceAlertsState,
  type Database,
  type InstanceAlertsState,
} from '@liedmotif/db';
import { createLogger } from '@liedmotif/shared';
import { mailInstanceAlert } from '@/lib/auth/account-mail';
import { alertTokenRefusal } from '@/lib/admin/alert-token';
import { postAlertWebhook } from '@/lib/admin/alert-webhook';
import { getDb } from '@/lib/db';
import { alertWebhookUrl, getPublicUrl, isAccountEmailEnabled } from '@/lib/env';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers/providers';
import {
  evaluateInstanceAlerts,
  type InstanceAlertNotification,
  type InstanceAlertsSnapshot,
} from '@/lib/admin/instance-alerts-model';

export const dynamic = 'force-dynamic';

const log = createLogger({ name: 'instance-alerts' });

const databaseUnavailable = () =>
  NextResponse.json({ ok: false, error: 'The database is unavailable.' }, { status: 503 });

interface AlertInputs {
  snapshot: InstanceAlertsSnapshot;
  previous: InstanceAlertsState;
  adminEmail: string | null;
}

async function readAlertInputs(db: Database, emailOn: boolean): Promise<AlertInputs> {
  const [heartbeat, queueStats, storageUsage, limits, previous, adminEmail] = await Promise.all([
    readWorkerHeartbeat(db),
    getWorkerQueueStats(db),
    getStorageUsage(db),
    getUsageLimits(db),
    readInstanceAlertsState(db),
    emailOn ? getAdminConfirmedEmail(db) : null,
  ]);
  return {
    snapshot: {
      heartbeat,
      failedJobs: queueStats?.failedJobs ?? null,
      storageUsage,
      storageQuotaBytes: limits.storageQuotaBytes,
      generationReserveBytes: getTypicalTracksPerMusicRequest() * MAX_TRACK_AUDIO_BYTES,
    },
    previous,
    adminEmail,
  };
}

/** One destination: true when it took the notification. */
type AlertSender = (notification: InstanceAlertNotification) => Promise<boolean>;

function alertSenders(webhookUrl: string | null, adminEmail: string | null): AlertSender[] {
  const instance = new URL(getPublicUrl()).host;
  const senders: AlertSender[] = [];
  if (webhookUrl) senders.push((alert) => postAlertWebhook(webhookUrl, alert, instance));
  if (adminEmail) {
    senders.push(({ title, message }) =>
      mailInstanceAlert({ to: adminEmail, title, message, instance }),
    );
  }
  return senders;
}

/**
 * Send every notification to every destination at once, so a run takes as long as
 * its slowest send rather than their sum. A notification counts as dispatched when
 * any destination took it.
 */
async function dispatch(notifications: InstanceAlertNotification[], senders: AlertSender[]) {
  const outcomes = await Promise.all(
    notifications.map(async (notification) => {
      const { condition, severity, state } = notification;
      const delivered = await Promise.all(senders.map((send) => send(notification)));
      return { summary: { condition, severity, state }, delivered };
    }),
  );
  return {
    dispatched: outcomes.filter(({ delivered }) => delivered.some(Boolean)).map((o) => o.summary),
    dispatchFailures: outcomes.flatMap((o) => o.delivered).filter((sent) => !sent).length,
  };
}

function emailDestination(emailOn: boolean, adminEmail: string | null): string {
  if (!emailOn) return 'off';
  return adminEmail ? 'on' : 'no-confirmed-address';
}

export async function GET(request: Request) {
  const refusal = alertTokenRefusal(request);
  if (refusal) return refusal;

  const now = new Date();
  const emailOn = isAccountEmailEnabled();
  // A read that throws means the check could not run. It must never reach the
  // evaluator as null, where a missing heartbeat would read as "never reported".
  let inputs: AlertInputs;
  try {
    inputs = await readAlertInputs(getDb(), emailOn);
  } catch (err) {
    log.error('alert check could not read the database', { err });
    return databaseUnavailable();
  }
  const { snapshot, previous, adminEmail } = inputs;

  const { firing, notifications, nextState } = evaluateInstanceAlerts(
    snapshot,
    previous,
    now.getTime(),
  );
  const webhookUrl = alertWebhookUrl();
  const senders = alertSenders(webhookUrl, adminEmail);
  const { dispatched, dispatchFailures } = await dispatch(notifications, senders);

  // A notification that reached no destination leaves every condition unannounced,
  // so the next run retries them all; one that reached any destination has told the
  // Admin, and a lasting outage elsewhere must not repeat it every run.
  if (notifications.length > 0 && dispatched.length === notifications.length) {
    try {
      await writeInstanceAlertsState(getDb(), nextState);
    } catch (err) {
      log.error('alert check could not save what it announced', { err });
      return databaseUnavailable();
    }
  }

  // No destination is a failure even with nothing firing: a setup that could never
  // deliver must show on the first hand-run curl.
  const ok = senders.length > 0 && dispatchFailures === 0;
  return NextResponse.json(
    {
      ok,
      checkedAt: now.toISOString(),
      firing,
      dispatched,
      dispatchFailures,
      destinations: {
        webhook: webhookUrl ? 'on' : 'off',
        email: emailDestination(emailOn, adminEmail),
      },
    },
    { status: ok ? 200 : 502 },
  );
}
