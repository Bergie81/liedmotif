CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"name_match_key" text NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_role_valid" CHECK ("people"."role" in ('owner', 'ordinary')),
	CONSTRAINT "people_sort_order_nonnegative" CHECK ("people"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "people_owner_name_match_key_unique" ON "people" USING btree ("owner_user_id","name_match_key");--> statement-breakpoint
CREATE UNIQUE INDEX "people_one_owner_profile" ON "people" USING btree ("owner_user_id") WHERE "people"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "people_owner_id_unique" ON "people" USING btree ("owner_user_id","id");--> statement-breakpoint
CREATE INDEX "people_owner_sort_order_idx" ON "people" USING btree ("owner_user_id","sort_order","id");--> statement-breakpoint
INSERT INTO "people" ("owner_user_id", "role", "name", "name_match_key", "about", "sort_order")
SELECT
	"user"."id",
	'owner',
	regexp_replace(btrim("user"."name"), '[[:space:]]+', ' ', 'g'),
	replace(
		replace(
			lower(normalize(regexp_replace(btrim("user"."name"), '[[:space:]]+', ' ', 'g'), NFKC)),
			'ß',
			'ss'
		),
		'ς',
		'σ'
	),
	coalesce("user_profiles"."about", ''),
	0
FROM "user"
LEFT JOIN "user_profiles" ON "user_profiles"."owner_user_id" = "user"."id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "about";
