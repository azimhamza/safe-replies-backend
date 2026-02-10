CREATE TYPE "public"."filter_scope" AS ENUM('GENERAL', 'SPECIFIC');--> statement-breakpoint
CREATE TABLE "custom_filter_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"custom_filter_id" uuid NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "custom_filters" ADD COLUMN "scope" "filter_scope" DEFAULT 'GENERAL';--> statement-breakpoint
ALTER TABLE "custom_filter_accounts" ADD CONSTRAINT "custom_filter_accounts_custom_filter_id_custom_filters_id_fk" FOREIGN KEY ("custom_filter_id") REFERENCES "public"."custom_filters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_filter_accounts" ADD CONSTRAINT "custom_filter_accounts_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;