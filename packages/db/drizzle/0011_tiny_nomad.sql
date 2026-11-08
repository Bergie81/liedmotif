CREATE TYPE "public"."cover_reference_frequency" AS ENUM('always', 'regularly', 'seldom', 'never');--> statement-breakpoint
CREATE TABLE "profile_cover_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"description" text NOT NULL,
	"original_filename" text,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "artist_name" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "cover_reference_frequency" "cover_reference_frequency" DEFAULT 'regularly' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_cover_references" ADD CONSTRAINT "profile_cover_references_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_cover_references_owner_user_id_idx" ON "profile_cover_references" USING btree ("owner_user_id");