/**
 * One-time setup script to provision Autumn features and products.
 *
 * Run with: pnpm tsx scripts/setup-autumn-billing.ts
 *
 * Features (already exist in dashboard):
 *   comments_moderated – single_use (consumable, resets monthly)
 *   social_accounts    – continuous_use (seats-style, no reset)
 *
 * Products (already exist in dashboard):
 *   creator-plan   – $30/mo,  10k comments ($0.30/500 overage), 2 accounts ($5/extra)
 *   agency-plan    – $100/mo, 75k comments ($0.20/500 overage), 15 accounts ($5/extra)
 *   super-max-plan – $200/mo, 300k comments ($0.10/500 overage), 25 accounts ($5/extra)
 *
 * Mapping to account types:
 *   CREATOR      → creator-plan
 *   BASIC_AGENCY → agency-plan
 *   MAX_AGENCY   → super-max-plan
 *   CLIENT       → not billed (managed by agency)
 */

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const AUTUMN_SECRET_KEY = process.env.AUTUMN_SECRET_KEY;
if (!AUTUMN_SECRET_KEY) {
  console.error("Missing AUTUMN_SECRET_KEY in .env.local");
  process.exit(1);
}

const BASE_URL = "https://api.useautumn.com/v1";

interface AutumnResponse {
  message?: string;
  code?: string;
  id?: string;
  [key: string]: unknown;
}

async function autumnFetch(
  endpoint: string,
  body: Record<string, unknown>
): Promise<AutumnResponse> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTUMN_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as AutumnResponse;
  if (!res.ok) {
    const alreadyExists =
      data.code === "feature_already_exists" ||
      data.code === "product_already_exists";
    if (alreadyExists) {
      console.log("   Already exists, skipping.");
    } else {
      console.error(`  [FAIL] ${endpoint}:`, JSON.stringify(data, null, 2));
    }
  }
  return data;
}

async function createFeatures(): Promise<void> {
  console.log("\n=== Creating Features ===\n");

  console.log("1. Creating feature: comments_moderated");
  await autumnFetch("/features", {
    id: "comments_moderated",
    type: "single_use",
    name: "comments moderated",
    display: { singular: "comment moderated", plural: "comments moderated" },
  });
  console.log("   Done.");

  console.log("2. Creating feature: social_accounts");
  await autumnFetch("/features", {
    id: "social_accounts",
    type: "continuous_use",
    name: "Account Cluster",
    display: { singular: "account cluster", plural: "account clusters" },
  });
  console.log("   Done.");
}

async function createProducts(): Promise<void> {
  console.log("\n=== Creating Products ===\n");

  // ── Creator ──────────────────────────────────────────────────────────
  console.log("1. Creating product: creator-plan ($30/mo)");
  await autumnFetch("/products", {
    id: "creator-plan",
    name: "Creator",
    is_default: false,
    items: [
      {
        type: "price",
        feature_id: null,
        interval: "month",
        interval_count: 1,
        price: 30,
      },
      {
        type: "priced_feature",
        feature_id: "social_accounts",
        included_usage: 2,
        interval: "month",
        price: 5,
        usage_model: "pay_per_use",
        billing_units: 1,
      },
      {
        type: "priced_feature",
        feature_id: "comments_moderated",
        included_usage: 10000,
        interval: "month",
        price: 0.3,
        usage_model: "pay_per_use",
        billing_units: 500,
        reset_usage_when_enabled: false,
      },
    ],
    free_trial: {
      duration: "day",
      length: 2,
      unique_fingerprint: true,
      card_required: true,
    },
  });
  console.log("   Done.");

  // ── Agency (BASIC_AGENCY) ────────────────────────────────────────────
  console.log("2. Creating product: agency-plan ($100/mo)");
  await autumnFetch("/products", {
    id: "agency-plan",
    name: "Agency",
    is_default: false,
    items: [
      {
        type: "price",
        feature_id: null,
        interval: "month",
        interval_count: 1,
        price: 100,
      },
      {
        type: "priced_feature",
        feature_id: "social_accounts",
        included_usage: 15,
        interval: "month",
        price: 5,
        usage_model: "pay_per_use",
        billing_units: 1,
      },
      {
        type: "priced_feature",
        feature_id: "comments_moderated",
        included_usage: 75000,
        interval: "month",
        price: 0.2,
        usage_model: "pay_per_use",
        billing_units: 500,
        reset_usage_when_enabled: false,
      },
    ],
    free_trial: {
      duration: "day",
      length: 2,
      unique_fingerprint: true,
      card_required: true,
    },
  });
  console.log("   Done.");

  // ── Super Max (MAX_AGENCY) ───────────────────────────────────────────
  console.log("3. Creating product: super-max-plan ($200/mo)");
  await autumnFetch("/products", {
    id: "super-max-plan",
    name: "Super Max",
    is_default: false,
    items: [
      {
        type: "price",
        feature_id: null,
        interval: "month",
        interval_count: 1,
        price: 200,
      },
      {
        type: "priced_feature",
        feature_id: "social_accounts",
        included_usage: 25,
        interval: "month",
        price: 5,
        usage_model: "pay_per_use",
        billing_units: 1,
      },
      {
        type: "priced_feature",
        feature_id: "comments_moderated",
        included_usage: 300000,
        interval: "month",
        price: 0.1,
        usage_model: "pay_per_use",
        billing_units: 500,
        reset_usage_when_enabled: false,
      },
    ],
    free_trial: {
      duration: "day",
      length: 2,
      unique_fingerprint: true,
      card_required: true,
    },
  });
  console.log("   Done.");
}

async function main(): Promise<void> {
  console.log("Setting up Autumn billing configuration...");
  console.log(`Using key: ${AUTUMN_SECRET_KEY?.slice(0, 15)}...`);

  await createFeatures();
  await createProducts();

  console.log("\n=== Setup Complete ===");
  console.log("\nProducts configured in Autumn:");
  console.log("  creator-plan   → CREATOR accounts");
  console.log("  agency-plan    → BASIC_AGENCY accounts");
  console.log("  super-max-plan → MAX_AGENCY accounts");
  console.log("\nNext steps:");
  console.log("  1. Visit https://app.useautumn.com to verify features & products");
  console.log("  2. Connect Stripe in Autumn to enable payments");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
