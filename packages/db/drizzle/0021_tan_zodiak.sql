ALTER TABLE "cover_art_studio_candidates" DROP CONSTRAINT "cover_art_studio_candidates_batch_id_cover_art_studio_batches_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_batches_owner_id_unique" ON "cover_art_studio_batches" USING btree ("owner_user_id","id");
--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ADD CONSTRAINT "cover_art_studio_candidates_owner_batch_fk" FOREIGN KEY ("owner_user_id","batch_id") REFERENCES "public"."cover_art_studio_batches"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;
