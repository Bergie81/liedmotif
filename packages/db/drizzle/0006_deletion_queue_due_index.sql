DROP INDEX "deletion_queue_items_delete_after_idx";--> statement-breakpoint
DROP INDEX "deletion_queue_items_processed_at_idx";--> statement-breakpoint
CREATE INDEX "deletion_queue_items_due_idx" ON "deletion_queue_items" USING btree ("delete_after") WHERE "deletion_queue_items"."processed_at" is null;