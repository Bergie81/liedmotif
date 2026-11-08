-- A cover ledger row is the spend record the cover budgets count, so deleting
-- its owner clears the owner instead of erasing the paid attempt (as 0061 did
-- for generation_requests): a deleted Member's covers keep counting in the
-- Members Pool until their window rolls over.
ALTER TABLE "session_cover_generations" DROP CONSTRAINT "session_cover_generations_owner_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "session_cover_generations" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_cover_generations" ADD CONSTRAINT "session_cover_generations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;