CREATE TYPE "public"."review_action" AS ENUM('ALLOW_THIS', 'ALLOW_SIMILAR', 'HIDE_THIS', 'AUTO_HIDE_SIMILAR', 'DELETE_THIS', 'AUTO_DELETE_SIMILAR');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('instagram', 'facebook');--> statement-breakpoint
CREATE TABLE "comment_review_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"action" "review_action" NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_by_client_id" uuid,
	"reviewed_at" timestamp DEFAULT now(),
	"similarity_threshold" numeric(5, 4),
	"custom_filter_id" uuid,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "ig_comment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "instagram_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "ig_post_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "source" "source" DEFAULT 'instagram' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "fb_comment_id" varchar(255);--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "review_action" "review_action";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "is_allowed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "custom_filters" ADD COLUMN "auto_hide" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "custom_filters" ADD COLUMN "auto_delete" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "custom_filters" ADD COLUMN "auto_flag" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "source" "source" DEFAULT 'instagram' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "facebook_page_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "fb_post_id" varchar(255);--> statement-breakpoint
ALTER TABLE "whitelisted_identifiers" ADD COLUMN "instagram_account_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_review_actions" ADD CONSTRAINT "comment_review_actions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_review_actions" ADD CONSTRAINT "comment_review_actions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_review_actions" ADD CONSTRAINT "comment_review_actions_reviewed_by_client_id_clients_id_fk" FOREIGN KEY ("reviewed_by_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_review_actions" ADD CONSTRAINT "comment_review_actions_custom_filter_id_custom_filters_id_fk" FOREIGN KEY ("custom_filter_id") REFERENCES "public"."custom_filters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_facebook_page_id_facebook_pages_id_fk" FOREIGN KEY ("facebook_page_id") REFERENCES "public"."facebook_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_identifiers" ADD CONSTRAINT "whitelisted_identifiers_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_fb_comment_id_unique" UNIQUE("fb_comment_id");--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_fb_post_id_unique" UNIQUE("fb_post_id");