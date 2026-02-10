CREATE TABLE "extracted_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"suspicious_account_id" uuid NOT NULL,
	"identifier" varchar(500) NOT NULL,
	"identifier_type" "identifier_type" NOT NULL,
	"platform" varchar(100),
	"normalized_identifier" varchar(500) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"source" varchar(50) DEFAULT 'llm_extraction',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "extracted_identifiers" ADD CONSTRAINT "extracted_identifiers_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_identifiers" ADD CONSTRAINT "extracted_identifiers_suspicious_account_id_suspicious_accounts_id_fk" FOREIGN KEY ("suspicious_account_id") REFERENCES "public"."suspicious_accounts"("id") ON DELETE no action ON UPDATE no action;