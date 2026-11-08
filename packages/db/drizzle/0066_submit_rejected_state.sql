ALTER TYPE "public"."provider_normalized_status" ADD VALUE 'submit_rejected' BEFORE 'processing';--> statement-breakpoint
ALTER TYPE "public"."provider_submit_state" ADD VALUE 'submit_rejected';