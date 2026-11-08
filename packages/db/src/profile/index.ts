// User-profile query layer: role resolution (the one seam guards ask), plus
// the listener profile (Settings → Profile + the LLM context read).

export {
  EMPTY_LISTENER_PROFILE,
  getListenerProfile,
  updateListenerProfile,
  getListenerContext,
  isEmailConfirmed,
  getConfirmedEmail,
  findUserByEmail,
  getAvatarOwnerUserId,
  getUserImage,
  type ListenerProfile,
  type ListenerContext,
  type UpdateListenerProfileResult,
} from './profile-repo';

export { resolveUserProfile, type UserProfile, type UserRole } from './resolve-user-profile';

export { listMemberAccounts, setMemberDisabled, type MemberAccountRow } from './member-admin-repo';

export { MEMBER_DELETE_REASON, deleteMember, type DeleteMemberResult } from './delete-member';
