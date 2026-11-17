-- Whether the text LLM read a Session's request as putting the listener in its
-- own scene ("me, Jonas and Clara on the moon"). The generated cover then treats
-- the owner Person as named. Existing Sessions were never asked, so they keep
-- the exact-name behavior.
ALTER TABLE "activity_sessions" ADD COLUMN "includes_listener" boolean DEFAULT false NOT NULL;
