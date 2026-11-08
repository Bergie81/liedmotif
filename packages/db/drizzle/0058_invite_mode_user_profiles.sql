-- Invite Mode foundations: `admin_profile` becomes the role/account table
-- `user_profiles` (it will hold Member rows too), and the listener-details
-- table moves to `listener_profiles` to free the name. Constraint and index
-- renames keep every name aligned with the table it belongs to; the partial
-- unique index keeps enforcing "at most one admin" throughout.
ALTER TABLE "user_profiles" RENAME TO "listener_profiles";--> statement-breakpoint
ALTER INDEX "user_profiles_owner_user_id_unique" RENAME TO "listener_profiles_owner_user_id_unique";--> statement-breakpoint
ALTER TABLE "listener_profiles" RENAME CONSTRAINT "user_profiles_owner_user_id_user_id_fk" TO "listener_profiles_owner_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "listener_profiles" RENAME CONSTRAINT "user_profiles_pkey" TO "listener_profiles_pkey";--> statement-breakpoint
ALTER TABLE "admin_profile" RENAME TO "user_profiles";--> statement-breakpoint
ALTER INDEX "admin_profile_single_admin" RENAME TO "user_profiles_single_admin";--> statement-breakpoint
ALTER TABLE "user_profiles" RENAME CONSTRAINT "admin_profile_user_id_user_id_fk" TO "user_profiles_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "user_profiles" RENAME CONSTRAINT "admin_profile_pkey" TO "user_profiles_pkey";--> statement-breakpoint
-- Roles are explicit at every insert; a silent 'admin' default is now a hazard.
ALTER TABLE "user_profiles" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
-- Supports "list all Members" in creation order.
CREATE INDEX "user_profiles_role_created_at_idx" ON "user_profiles" ("role","created_at");
