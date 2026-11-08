DROP INDEX "generation_requests_status_idx";--> statement-breakpoint
ALTER TABLE "generation_requests" ALTER COLUMN "status" DROP DEFAULT;