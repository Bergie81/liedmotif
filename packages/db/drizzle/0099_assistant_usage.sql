CREATE TABLE "assistant_usage" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"messages" integer NOT NULL,
	CONSTRAINT "assistant_usage_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;