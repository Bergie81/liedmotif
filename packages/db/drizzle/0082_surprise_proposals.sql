CREATE TABLE "surprise_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"adventurous" boolean NOT NULL,
	"skip_profile" boolean NOT NULL,
	"used_own_about" boolean NOT NULL,
	"llm_generated" boolean NOT NULL,
	"intent" text NOT NULL,
	"picks" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"title" text NOT NULL,
	"cover_concept" text,
	"preview" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listening_preferences" ADD COLUMN "proposal_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "surprise_proposals" ADD CONSTRAINT "surprise_proposals_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "surprise_proposals_owner_unique" ON "surprise_proposals" USING btree ("owner_user_id");