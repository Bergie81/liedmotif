CREATE TABLE "person_reference_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"person_id" uuid NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"original_filename" text,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_reference_photos" ADD CONSTRAINT "person_reference_photos_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_reference_photos" ADD CONSTRAINT "person_reference_photos_owner_person_fk" FOREIGN KEY ("owner_user_id","person_id") REFERENCES "public"."people"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_reference_photos_storage_key_unique" ON "person_reference_photos" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "person_reference_photos_owner_person_created_idx" ON "person_reference_photos" USING btree ("owner_user_id","person_id","created_at","id");--> statement-breakpoint
INSERT INTO "deletion_queue_items" ("owner_user_id", "storage_key", "reason", "delete_after")
SELECT "owner_user_id", "storage_key", 'legacy_profile_reference_migration', now()
FROM "profile_cover_references";--> statement-breakpoint
DELETE FROM "profile_cover_references";
