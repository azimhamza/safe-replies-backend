CREATE TABLE "facebook_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"client_id" uuid,
	"facebook_page_id" varchar(255) NOT NULL,
	"page_name" varchar(255) NOT NULL,
	"page_access_token" text NOT NULL,
	"token_expires_at" timestamp,
	"category" varchar(255),
	"profile_picture_url" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "facebook_pages_facebook_page_id_unique" UNIQUE("facebook_page_id")
);
--> statement-breakpoint
CREATE TABLE "page_instagram_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facebook_page_id" uuid NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"is_verified" boolean DEFAULT true,
	"verified_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "instagram_accounts" ALTER COLUMN "access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "parent_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD COLUMN "facebook_page_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "impressions" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "reach" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "engagement" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "saved" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "video_views" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "insights_last_fetched_at" timestamp;--> statement-breakpoint
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_instagram_connections" ADD CONSTRAINT "page_instagram_connections_facebook_page_id_facebook_pages_id_fk" FOREIGN KEY ("facebook_page_id") REFERENCES "public"."facebook_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_instagram_connections" ADD CONSTRAINT "page_instagram_connections_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_facebook_page_id_facebook_pages_id_fk" FOREIGN KEY ("facebook_page_id") REFERENCES "public"."facebook_pages"("id") ON DELETE no action ON UPDATE no action;