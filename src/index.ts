// Load environment variables FIRST before any other imports
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { startPollCron } from "./cron/pollCron";
import { startDeepSyncCron } from "./cron/deepSyncCron";
import { startFollowerTrackingCron } from "./cron/followerTrackingCron";
import express from "express";
import https from "https";
import fs from "fs";
import cors from "cors";
import multer from "multer";
import { auth } from "./config/auth.config";
import { toNodeHandler } from "better-auth/node";
import { authMiddleware } from "./middleware/auth.middleware";
import { delegationMiddleware, DelegationRequest } from "./middleware/delegation.middleware";
import { authRateLimiter, apiRateLimiter, webhookRateLimiter, syncStatusRateLimiter } from "./middleware/rate-limit.middleware";
import * as authController from "./controllers/auth.controller";
import * as webhookController from "./controllers/webhook.controller";
import * as clientsController from "./controllers/clients.controller";
import * as agencyController from "./controllers/agency.controller";
import * as instagramController from "./controllers/instagram.controller";
import * as facebookController from "./controllers/facebook.controller";
import * as dashboardController from "./controllers/dashboard.controller";
import * as commentsController from "./controllers/comments.controller";
import { customFiltersController } from "./controllers/custom-filters.controller";
import { moderationSettingsController } from "./controllers/moderation-settings.controller";
import { suspiciousAccountsController } from "./controllers/suspicious-accounts.controller";
import { commentReviewController } from "./controllers/commentReview.controller";
import * as billingController from "./controllers/billing.controller";
import * as imageProxyController from "./controllers/image-proxy.controller";
import { underAttackController } from "./controllers/under-attack.controller";
import syncStatusController from "./controllers/sync-status.controller";
import initialSyncProgressController from "./controllers/initial-sync-progress.controller";
import * as onboardingController from "./controllers/onboarding.controller";
import { AuthRequest } from "./middleware/auth.middleware";
import { autumnHandler } from "autumn-js/express";
import jwt from "jsonwebtoken";

const app = express();
const port = process.env.PORT ?? 8080;

// Middleware
// Strict CORS configuration - only allow specific frontend origins
const frontendOrigins = [
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  'http://localhost:3000',
  'https://localhost:3000',
  // Add your specific Vercel deployment URL
  'https://safe-replies-frontend-go8h-380dnxuc5-azim-hamzas-projects.vercel.app'
].filter(Boolean);

const useHttps = process.env.USE_HTTPS !== "false"; // Default to true

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-to-server)
      if (!origin) return callback(null, true);

      // Check if origin is in the exact match list
      if (frontendOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Allow all Vercel preview deployments (*.vercel.app)
      if (origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }

      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true, // Required for secure cookies
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer configuration for file uploads
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Allow images and videos
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only image and video files are allowed"));
    }
  },
});

// Multer configuration for logo uploads (smaller file size)
const logoUpload = multer({
  dest: "uploads/logos/",
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Allow only images for logos
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed for logos"));
    }
  },
});

// Autumn billing handler
app.use(
  "/api/autumn",
  autumnHandler({
    identify: async (req) => {
      const cookieName = "better-auth.session_token";
      const cookies = req.headers.cookie?.split(";").reduce(
        (acc: Record<string, string>, cookie: string) => {
          const [key, value] = cookie.trim().split("=");
          if (key && value) {
            acc[key] = value;
          }
          return acc;
        },
        {}
      );

      const token = cookies?.[cookieName];
      if (!token) {
        return { customerId: "" };
      }

      try {
        const secret = process.env.BETTER_AUTH_SECRET || "fallback-secret-key";
        const decoded = jwt.verify(token, secret) as {
          userId: string;
          email: string;
          accountType: string;
        };

        // Only create Autumn customers for agencies and creators, not clients
        if (decoded.accountType === "CLIENT") {
          return { customerId: "" };
        }

        return {
          customerId: decoded.userId,
          customerData: {
            name: decoded.email,
            email: decoded.email,
          },
        };
      } catch {
        return { customerId: "" };
      }
    },
  })
);

// Better-auth routes (with rate limiting)
app.all("/api/auth/*", authRateLimiter, toNodeHandler(auth));

// Authentication routes (with strict rate limiting)
app.post("/api/signup/agency", authRateLimiter, authController.agencySignup);
app.post("/api/signup/creator", authRateLimiter, authController.creatorSignup);
app.post("/api/login", authRateLimiter, authController.login);

// Onboarding routes (protected)
app.post(
  "/api/onboarding/branding",
  authMiddleware,
  logoUpload.single("logo"),
  onboardingController.saveBranding
);

// Webhook routes (with rate limiting to prevent spam)
app.get("/api/webhook/instagram", webhookRateLimiter, webhookController.verifyWebhook);
app.post("/api/webhook/instagram", webhookRateLimiter, webhookController.handleWebhook);

// Invitation routes (public - uses token auth)
app.get(
  "/api/invitation/:token/validate",
  clientsController.validateInvitation,
);
app.post("/api/invitation/:token", clientsController.acceptInvitation);

// Billing routes (protected)
app.get("/api/billing/status", authMiddleware, billingController.getBillingStatus);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Facebook OAuth callback (no auth required - handles its own OAuth flow)
app.get("/api/facebook/oauth/callback", facebookController.handleCallback);
// Facebook OAuth callback complete (returns redirect URL as JSON for same-domain frontend proxy)
app.get(
  "/api/facebook/oauth/complete",
  facebookController.handleCallbackComplete,
);

// Legacy Instagram OAuth callback (deprecated - use Facebook OAuth instead)
// app.get('/api/instagram/oauth/callback', instagramController.handleCallback);

// Apply general API rate limiting to all API routes (before auth)
app.use("/api/*", apiRateLimiter);

// Protected routes (require authentication)
// Exclude public routes from auth middleware
app.use("/api/*", (req, res, next) => {
  // List of public routes that don't require authentication
  const publicRoutes = [
    "/api/auth",
    "/api/login",
    "/api/signup",
    "/api/webhook",
    "/api/invitation",
    "/api/health",
    "/api/agency/branding", // Public endpoint for login pages
    "/api/facebook/oauth/callback",
    "/api/facebook/oauth/complete",
    "/api/instagram/oauth/callback", // Legacy route
    "/api/image-proxy", // Instagram CDN image proxy (no auth; URL allowlist only)
    "/api/autumn", // Autumn billing handler (handles its own auth)
  ];

  // Check if the current path is a public route
  // Use originalUrl to get the full path (req.path may have prefix stripped by Express)
  const fullPath = req.originalUrl.split('?')[0]; // Remove query string for comparison
  const isPublicRoute = publicRoutes.some((route) =>
    fullPath.startsWith(route),
  );

  if (isPublicRoute) {
    // Skip authentication for public routes
    console.log(`[AUTH] Skipping auth for public route: ${req.method} ${fullPath}`);
    return next();
  }

  // Apply authentication middleware for protected routes
  console.log(`[AUTH] Applying auth middleware for: ${req.method} ${fullPath}`);
  return authMiddleware(req as AuthRequest, res, next);
});

// Image proxy (public - allowlisted Instagram CDN URLs only)
app.get("/api/image-proxy", imageProxyController.proxyImage);

// Dashboard routes (protected + delegation)
app.get(
  "/api/dashboard/stats",
  authMiddleware,
  delegationMiddleware,
  dashboardController.getStats,
);

// Facebook OAuth routes (protected)
app.get("/api/facebook/auth/url", facebookController.getAuthUrl);
app.get("/api/facebook/pages", authMiddleware, delegationMiddleware, facebookController.getPages);
app.post("/api/facebook/connect-selected", authMiddleware, facebookController.connectSelectedAccounts);
app.post("/api/facebook/pages/:pageId/connect", facebookController.connectPage);
app.delete("/api/facebook/pages/:pageId", authMiddleware, facebookController.disconnectPage);

// Facebook Page sync routes (protected)
app.get(
  "/api/facebook/pages/:pageId/stats",
  authMiddleware,
  delegationMiddleware,
  facebookController.getPageStats,
);
app.post(
  "/api/facebook/pages/:pageId/sync",
  authMiddleware,
  facebookController.syncPage,
);
app.post(
  "/api/facebook/pages/:pageId/refresh-comments",
  authMiddleware,
  delegationMiddleware,
  facebookController.refreshComments,
);
app.post(
  "/api/facebook/pages/:pageId/deep-sync",
  authMiddleware,
  facebookController.manualDeepSync,
);

// Instagram routes (protected)
// Legacy OAuth route (deprecated - use Facebook OAuth)
// app.get('/api/instagram/auth/url', instagramController.getAuthUrl);
app.get(
  "/api/instagram/accounts",
  authMiddleware,
  delegationMiddleware,
  instagramController.getAccounts,
);
app.get(
  "/api/instagram/accounts/:accountId/webhook-status",
  instagramController.getWebhookStatus,
);
app.get(
  "/api/instagram/accounts/:accountId/stats",
  authMiddleware,
  instagramController.getAccountStats,
);
app.post(
  "/api/instagram/accounts/:accountId/refresh-comments",
  authMiddleware,
  delegationMiddleware,
  instagramController.refreshComments,
);
app.post(
  "/api/instagram/accounts/:accountId/deep-sync",
  authMiddleware,
  instagramController.manualDeepSync,
);
app.post(
  "/api/instagram/accounts/refresh-all",
  authMiddleware,
  delegationMiddleware,
  instagramController.refreshAllAccountsInfo,
);
app.post(
  "/api/instagram/accounts/:accountId/refresh",
  instagramController.refreshAccountInfo,
);
app.delete(
  "/api/instagram/accounts/:accountId",
  authMiddleware,
  instagramController.disconnectAccount,
);

// Comments routes (protected + delegation)
app.get(
  "/api/comments",
  authMiddleware,
  delegationMiddleware,
  commentsController.getComments,
);
app.delete(
  "/api/comments/:commentId",
  authMiddleware,
  delegationMiddleware,
  commentsController.deleteComment,
);
app.post(
  "/api/comments/:commentId/hide",
  authMiddleware,
  delegationMiddleware,
  commentsController.hideComment,
);

// Sync status route (protected + delegation + permissive rate limiting)
app.get(
  "/api/sync-status",
  syncStatusRateLimiter,
  authMiddleware,
  delegationMiddleware,
  (req, res) => syncStatusController.getSyncStatus(req as any, res),
);
app.get(
  "/api/sync-status/initial-progress",
  syncStatusRateLimiter,
  authMiddleware,
  delegationMiddleware,
  (req, res) => initialSyncProgressController.getInitialSyncProgress(req as any, res),
);
app.post(
  "/api/comments/bulk-hide",
  authMiddleware,
  delegationMiddleware,
  commentsController.bulkHideComments,
);
app.post(
  "/api/comments/bulk-delete",
  authMiddleware,
  delegationMiddleware,
  commentsController.bulkDeleteComments,
);
app.post("/api/comments/:commentId/block", authMiddleware, delegationMiddleware, commentsController.blockUser);
app.post("/api/comments/:commentId/restrict", authMiddleware, delegationMiddleware, commentsController.restrictUser);
app.post("/api/comments/:commentId/report", authMiddleware, delegationMiddleware, commentsController.reportComment);

// Comment review routes (protected + delegation)
app.get(
  "/api/comments/review/flagged",
  authMiddleware,
  delegationMiddleware,
  (req, res) => commentReviewController.getFlaggedComments(req, res),
);
app.get("/api/comments/:commentId/similar", authMiddleware, delegationMiddleware, (req, res) =>
  commentReviewController.getSimilarComments(req, res),
);
app.post("/api/comments/:commentId/review", authMiddleware, delegationMiddleware, (req, res) =>
  commentReviewController.reviewComment(req, res),
);
app.post("/api/comments/:commentId/allow", authMiddleware, delegationMiddleware, (req, res) =>
  commentReviewController.allowComment(req, res),
);
app.post("/api/comments/bulk-review", authMiddleware, delegationMiddleware, (req, res) =>
  commentReviewController.bulkReview(req, res),
);

// Custom filters routes (protected + delegation)
app.get(
  "/api/custom-filters",
  authMiddleware,
  delegationMiddleware,
  (req, res) => customFiltersController.getCustomFilters(req, res),
);
app.post("/api/custom-filters", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.createCustomFilter(req, res),
);
app.post("/api/custom-filters/from-comment", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.createCustomFilterFromComment(req, res),
);
app.put("/api/custom-filters/:id", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.updateCustomFilter(req, res),
);
app.delete("/api/custom-filters/:id", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.deleteCustomFilter(req, res),
);
app.post("/api/custom-filters/:id/apply", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.applyFilterToExistingComments(req, res),
);
app.get("/api/custom-filters/accounts/available", authMiddleware, delegationMiddleware, (req, res) =>
  customFiltersController.getAvailableAccounts(req, res),
);

// Moderation settings routes (protected + delegation)
app.get(
  "/api/moderation-settings",
  authMiddleware,
  delegationMiddleware,
  (req, res) => moderationSettingsController.getModerationSettings(req, res),
);
app.put("/api/moderation-settings/global", authMiddleware, (req, res) =>
  moderationSettingsController.updateGlobalSettings(req, res),
);
app.put("/api/moderation-settings/account", authMiddleware, (req, res) =>
  moderationSettingsController.updateAccountSettings(req, res),
);
app.delete(
  "/api/moderation-settings/account/:instagramAccountId",
  authMiddleware,
  (req, res) => moderationSettingsController.deleteAccountSettings(req, res),
);
app.put("/api/moderation-settings/client", authMiddleware, (req, res) =>
  moderationSettingsController.updateClientSettings(req, res),
);
app.delete(
  "/api/moderation-settings/client/:managedClientId",
  authMiddleware,
  (req, res) => moderationSettingsController.deleteClientSettings(req, res),
);

// Suspicious accounts routes (protected + delegation)
app.post(
  "/api/suspicious-accounts",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.createSuspiciousAccount(req, res),
);
app.post(
  "/api/suspicious-accounts/test",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.createTestAccount(req, res),
);
app.get(
  "/api/suspicious-accounts/debug",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getAllSuspiciousAccounts(req, res),
);
app.get(
  "/api/suspicious-accounts",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getSuspiciousAccounts(req, res),
);
app.get("/api/suspicious-accounts/:id", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.getSuspiciousAccountById(req, res),
);
app.get(
  "/api/suspicious-accounts/:id/identifiers",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getExtractedIdentifiers(req, res),
);
app.get(
  "/api/suspicious-accounts/:id/network-activity",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getNetworkActivity(req, res),
);
app.get(
  "/api/suspicious-accounts/:id/similar-behaviors",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getSimilarBehaviors(req, res),
);
app.get("/api/suspicious-accounts/:id/evidence", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.getAccountEvidence(req, res),
);
app.post(
  "/api/suspicious-accounts/:id/evidence",
  authMiddleware,
  delegationMiddleware,
  upload.single("file"),
  (req, res) => suspiciousAccountsController.uploadAccountEvidence(req, res),
);
app.delete(
  "/api/suspicious-accounts/:id/evidence/:evidenceId",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.deleteAccountEvidence(req, res),
);
app.get("/api/suspicious-accounts/:id/comments", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.getAccountComments(req, res),
);
app.get("/api/suspicious-accounts/:id/export", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.exportAccountReport(req, res),
);
app.get(
  "/api/suspicious-accounts/:id/bot-network",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.detectBotNetwork(req, res),
);
app.get("/api/suspicious-accounts/bot-networks", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.getAllBotNetworks(req, res),
);
app.post("/api/suspicious-accounts/:id/watchlist", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.watchlistAccount(req, res),
);
app.post("/api/suspicious-accounts/:id/hide", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.hideAccount(req, res),
);
app.post("/api/suspicious-accounts/:id/block", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.blockAccount(req, res),
);
app.put("/api/suspicious-accounts/:id/auto-hide", authMiddleware, delegationMiddleware, (req, res) =>
  suspiciousAccountsController.updateAutoHide(req, res),
);
app.put(
  "/api/suspicious-accounts/:id/auto-delete",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.updateAutoDelete(req, res),
);
app.post(
  "/api/under-attack",
  authMiddleware,
  delegationMiddleware,
  (req, res) => underAttackController.handleUnderAttack(req as any, res)
);
app.get(
  "/api/suspicious-accounts/:id/mastermind-connections",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getMastermindConnections(req as DelegationRequest, res),
);
app.post(
  "/api/suspicious-accounts/:id/mastermind-connections",
  authMiddleware,
  delegationMiddleware,
  (req, res) =>
    suspiciousAccountsController.createMastermindConnection(req as DelegationRequest, res),
);
app.get(
  "/api/suspicious-accounts/:id/mentions-by-connected",
  authMiddleware,
  delegationMiddleware,
  (req, res) => suspiciousAccountsController.getMentionsByConnected(req as DelegationRequest, res),
);

// Agency management routes (protected)
app.get(
  "/api/agency/profile",
  authMiddleware,
  agencyController.getAgencyProfile,
);
app.put(
  "/api/agency/profile",
  authMiddleware,
  agencyController.updateAgencyProfile,
);
app.post(
  "/api/agency/upload",
  authMiddleware,
  upload.single("file"),
  (req, res) => agencyController.uploadAgencyAsset(req, res),
);
app.get("/api/agency/branding/:agencyId", agencyController.getAgencyBranding);

// Client management routes (agency only - all require auth)
app.get("/api/clients", authMiddleware, clientsController.getClients);
app.post("/api/clients", authMiddleware, clientsController.createClient);
app.get("/api/clients/:clientId", authMiddleware, clientsController.getClientById);
app.get("/api/clients/:clientId/details", authMiddleware, clientsController.getClientDetails);
app.delete("/api/clients/:clientId", authMiddleware, clientsController.deleteClient);
app.post("/api/clients/:clientId/refresh-comments", authMiddleware, clientsController.refreshClientComments);

// TODO: Add more protected routes
// - /api/comments/* (list, export)
// - /api/moderation/* (logs, settings)
// - /api/suspicious-accounts/* (tracking)
// - /api/legal-cases/* (CRUD)
// - /api/evidence/* (upload)
// - /api/watchlist/* (CRUD)
// Whitelist routes
import { whitelistController } from "./controllers/whitelist.controller";
app.get("/api/whitelist", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.getWhitelist(req, res),
);
app.get("/api/whitelist/commenters", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.getWhitelistedCommenters(req, res),
);
app.post("/api/whitelist", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.addIdentifier(req, res),
);
app.post("/api/whitelist/commenter", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.addCommenter(req, res),
);
app.delete("/api/whitelist/:id", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.removeIdentifier(req, res),
);
app.delete("/api/whitelist/commenter", authMiddleware, delegationMiddleware, (req, res) =>
  whitelistController.removeCommenter(req, res),
);

// Error handling
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  },
);

// Start HTTPS server
if (useHttps) {
  const certPath = path.join(__dirname, "../certs/cert.pem");
  const keyPath = path.join(__dirname, "../certs/key.pem");

  // Check if certificates exist
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const options = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    https.createServer(options, app).listen(port, () => {
      console.log(`🚀 Safe Replies API running on HTTPS port ${port}`);
      console.log(`📊 Health check: https://localhost:${port}/api/health`);
      console.log(`🔐 Auth endpoint: https://localhost:${port}/api/auth/*`);
      console.log(
        `⚠️  Using self-signed certificate - browser will show security warning`,
      );
      console.log(
        `   Accept the certificate to continue (this is normal for localhost)`,
      );
      startPollCron();
      startDeepSyncCron();
      startFollowerTrackingCron();
    });
  } else {
    console.error("❌ SSL certificates not found!");
    console.error(`   Expected cert: ${certPath}`);
    console.error(`   Expected key: ${keyPath}`);
    console.error("   Falling back to HTTP...");
    app.listen(port, () => {
      console.log(`🚀 Safe Replies API running on HTTP port ${port}`);
      console.log(`📊 Health check: http://localhost:${port}/api/health`);
      startPollCron();
      startDeepSyncCron();
      startFollowerTrackingCron();
    });
  }
} else {
  app.listen(port, () => {
    console.log(`🚀 Instagram Moderation API running on HTTP port ${port}`);
    console.log(`📊 Health check: http://localhost:${port}/api/health`);
    startPollCron();
    startDeepSyncCron();
    startFollowerTrackingCron();
  });
}

export default app;
