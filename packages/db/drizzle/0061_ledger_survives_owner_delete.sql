ALTER TABLE "generation_requests" DROP CONSTRAINT "generation_requests_owner_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "deletion_queue_items" DROP CONSTRAINT "deletion_queue_items_owner_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "generation_requests" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_queue_items" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_queue_items" ADD CONSTRAINT "deletion_queue_items_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;