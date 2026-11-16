// Setup surface: single-admin state/lock and the settings repository.

export {
  SetupLockedError,
  resolveSetupState,
  countAdmins,
  adminExists,
  isAdminUser,
  getSetupState,
  assertCanCreateAdmin,
  createAdminProfile,
  getAdminIdentity,
  getAdminConfirmedEmail,
  getAdminDisplayName,
  type SetupState,
} from './state';

export {
  getAssistantAccess,
  getBackupRequest,
  getBackupSchedule,
  getInstanceSettings,
  getMembersPool,
  getUnitCosts,
  upsertInstanceSettings,
  markSetupComplete,
  getUsageLimits,
  readInstanceAlertsState,
  requestBackup,
  updateAssistantAccess,
  updateBackupSchedule,
  updateMembersPool,
  updateUnitCosts,
  updateUsageLimits,
  writeInstanceAlertsState,
} from './settings';

export { withSetupAdvisoryLock, SETUP_ADVISORY_LOCK_KEY } from './lock';
