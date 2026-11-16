-- A User name and a Short description hold at most 80 characters, the cap every
-- profile form and route enforces; a longer stored value is cut to fit, so no
-- saved value can make the next profile save fail its own length check.
UPDATE "user" SET "name" = rtrim(left("name", 80)) WHERE char_length("name") > 80;--> statement-breakpoint
UPDATE "listener_profiles" SET "description" = rtrim(left("description", 80)) WHERE char_length("description") > 80;
