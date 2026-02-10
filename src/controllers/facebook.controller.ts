import { Request, Response } from "express";
import crypto from "crypto";
import { facebookService } from "../services/facebook.service";
import { db } from "../db";
import {
  users,
  clients,
  facebookPages,
  instagramAccounts,
  pageInstagramConnections,
  posts,
  comments,
  Comment,
} from "../db/schema";
import { AuthRequest } from "../middleware/auth.middleware";
import { DelegationRequest } from "../middleware/delegation.middleware";
import { ApiResponse } from "../types";
import { eq, and } from "drizzle-orm";
import { deepSyncFacebookPage } from "../services/polling.service";
import { syncAccountData, getPageAccessToken } from "./instagram.controller";
import { autumn, resolveBillingCustomerId, checkFeatureAllowed } from "../services/autumn.service";
import {
  setOAuthTokenCache,
  getOAuthTokenCache,
  deleteOAuthTokenCache,
  type DiscoveredAccount,
} from "../services/cache.service";

const frontendBase = (): string => process.env.FRONTEND_URL || "http://localhost:3000";

/**
 * Unified redirect page after OAuth.
 * All account types (AGENCY, CREATOR) redirect to the same /client/connect page,
 * which then intelligently routes to the appropriate dashboard based on the user's account type.
 */
function connectInstagramRedirectBase(): string {
  return "/client/connect";
}

/**
 * Get Facebook OAuth authorization URL
 */
export async function getAuthUrl(
  req: AuthRequest,
  res: Response<ApiResponse<{ authUrl: string }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
      return;
    }

    // Determine account type based on provided accountType or by checking both tables
    let accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT' | null = req.accountType || null;

    // If accountType not provided, check users table first, then clients table
    if (!accountType) {
      const user = await db.query.users.findFirst({
        columns: { accountType: true },
        where: eq(users.id, req.userId),
      });

      if (user) {
        accountType = user.accountType;
      } else {
        // Check if it's a managed client
        const client = await db.query.clients.findFirst({
          columns: { id: true },
          where: eq(clients.id, req.userId),
        });

        if (client) {
          accountType = 'CLIENT';
        }
      }
    }

    // Get optional managedClientId from query params (when agency connects for a client)
    const managedClientId = req.query.managedClientId as string | undefined;

    // Encode userId, accountType, and managedClientId in state for redirect after OAuth (including errors)
    const stateData = {
      userId: req.userId,
      accountType,
      managedClientId,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
    };

    // Base64 encode the state data
    const state = Buffer.from(JSON.stringify(stateData)).toString("base64");

    const authUrl = facebookService.getAuthorizationUrl(state);

    res.json({
      success: true,
      data: { authUrl },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Get Facebook auth URL error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to generate Facebook authorization URL",
    });
  }
}

/**
 * Process OAuth callback and return the URL to redirect the user to.
 * Used by both the direct callback (backend redirect) and the frontend proxy (return JSON for same-domain redirect).
 */
export async function getOAuthCallbackRedirectUrl(
  req: Request,
): Promise<string> {
  console.log("🔐 [FACEBOOK CALLBACK] Request received");
  console.log("🔐 [FACEBOOK CALLBACK] Query params:", req.query);

  const { code, state, error, error_description } = req.query;

  // Decode state early to get managedClientId for error redirects
  let managedClientId: string | undefined;
  if (state && typeof state === "string") {
    try {
      const stateData = JSON.parse(
        Buffer.from(state, "base64").toString("utf-8"),
      );
      managedClientId = stateData.managedClientId;
    } catch {
      // Ignore state parsing errors here, will be caught later
    }
  }

  const clientIdParam = managedClientId ? `&clientId=${encodeURIComponent(managedClientId)}` : "";

  // Handle OAuth errors (redirect to unified connect page)
  if (error) {
    console.error("Facebook OAuth error:", error, error_description);
    const base = connectInstagramRedirectBase();
    return `${frontendBase()}${base}?error=${error}${clientIdParam}`;
  }

  if (!code || typeof code !== "string") {
    const base = connectInstagramRedirectBase();
    return `${frontendBase()}${base}?error=missing_code${clientIdParam}`;
  }

  // Decode and validate state parameter (full validation)
  let userId: string;
  let accountType: 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT' | null;
  try {
    if (state && typeof state === "string") {
      const stateData = JSON.parse(
        Buffer.from(state, "base64").toString("utf-8"),
      );
      userId = stateData.userId;
      accountType = stateData.accountType || null;
      managedClientId = stateData.managedClientId; // Already decoded above

      // Validate timestamp (prevent replay attacks - state valid for 10 minutes)
      const stateAge = Date.now() - stateData.timestamp;
      if (stateAge > 10 * 60 * 1000) {
        throw new Error("State parameter expired");
      }
    } else {
      throw new Error("Missing state parameter");
    }
  } catch (stateError) {
    console.error("State validation error:", stateError);
    const base = connectInstagramRedirectBase();
    return `${frontendBase()}${base}?error=invalid_state${clientIdParam}`;
  }

  console.log("✅ State validated for userId:", userId, "accountType:", accountType);

  // Step 1: Exchange code for short-lived user token
  const { accessToken: shortLivedToken } =
    await facebookService.exchangeCodeForToken(code);
  console.log("✅ Got short-lived user token");

  // Step 2: Exchange for long-lived user token (60 days)
  const { accessToken: longLivedUserToken, expiresIn } =
    await facebookService.getLongLivedUserToken(shortLivedToken);
  console.log(
    "✅ Got long-lived user token, expires in:",
    expiresIn,
    "seconds",
  );

  // Step 3: Get user's Pages
  const pages = await facebookService.getUserPages(longLivedUserToken);
  console.log("✅ Found", pages.length, "Page(s)");

  if (pages.length === 0) {
    console.warn("⚠️  User has no Facebook Pages");
    const base = connectInstagramRedirectBase();
    return `${frontendBase()}${base}?error=no_pages&message=${encodeURIComponent("You must be an admin of a Facebook Page connected to an Instagram Business account.")}${clientIdParam}`;
  }

  // Step 4: Build list of discovered accounts for selection UI
  const discoveredPages: Array<{
    page: DiscoveredAccount;
    pageAccessToken: string;
  }> = [];

  for (const page of pages) {
    const igAccount = page.instagram_business_account;
    discoveredPages.push({
      page: {
        pageId: page.id,
        pageName: page.name,
        pageCategory: page.category,
        pageProfilePic: page.picture?.data?.url ?? null,
        igId: igAccount?.id ?? null,
        igUsername: igAccount?.username ?? null,
        igProfilePic: igAccount?.profile_picture_url ?? null,
      },
      pageAccessToken: page.access_token,
    });
  }

  console.log(`✅ Discovered ${discoveredPages.length} page(s), storing for selection`);

  // Generate nonce for cache key
  const cacheNonce = crypto.randomBytes(16).toString("hex");

  // Step 5: Store tokens + discovered pages in cache (5 min TTL)
  setOAuthTokenCache(userId, cacheNonce, {
    longLivedUserToken: longLivedUserToken,
    pages: discoveredPages,
    userId,
    accountType: accountType ?? null,
    managedClientId,
  });

  // Step 6: Redirect to frontend selection UI with nonce (no tokens in URL)
  const base = connectInstagramRedirectBase();
  const accountsParam = encodeURIComponent(
    Buffer.from(JSON.stringify(discoveredPages.map((p) => p.page))).toString("base64")
  );
  return `${frontendBase()}${base}?select_accounts=true&nonce=${cacheNonce}&accounts_available=${accountsParam}${clientIdParam}`;
}

/**
 * Handle Facebook OAuth callback (direct redirect from Meta).
 * Use this URL as FACEBOOK_REDIRECT_URI when the callback is on the backend domain.
 */
export async function handleCallback(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const redirectTo = await getOAuthCallbackRedirectUrl(req);
    res.redirect(redirectTo);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Facebook OAuth callback error:", errorMessage);
    const base = connectInstagramRedirectBase();
    res.redirect(
      `${frontendBase()}${base}?error=connection_failed&message=${encodeURIComponent(errorMessage)}`,
    );
  }
}

/**
 * Return redirect URL as JSON for frontend proxy (same-domain OAuth callback).
 * Use this when FACEBOOK_REDIRECT_URI is your frontend domain so Meta only sees one App Domain.
 */
export async function handleCallbackComplete(
  req: Request,
  res: Response<ApiResponse<{ redirectTo: string }>>,
): Promise<void> {
  try {
    const redirectTo = await getOAuthCallbackRedirectUrl(req);
    res.json({ success: true, data: { redirectTo } });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Facebook OAuth callback (complete) error:", errorMessage);
    const base = connectInstagramRedirectBase();
    const redirectTo = `${frontendBase()}${base}?error=connection_failed&message=${encodeURIComponent(errorMessage)}`;
    res.json({ success: true, data: { redirectTo } });
  }
}

/**
 * POST /api/facebook/connect-selected
 *
 * Connect only the user-selected pages from the OAuth discovery step.
 * Expects: { nonce: string; selectedPageIds: string[] }
 * The nonce references cached OAuth tokens from the callback redirect.
 */
export async function connectSelectedAccounts(
  req: AuthRequest,
  res: Response<ApiResponse<{ connectedAccounts: string[]; failedAccounts: string[] }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const { nonce, selectedPageIds } = req.body as {
      nonce: string;
      selectedPageIds: string[];
    };

    if (!nonce || !selectedPageIds || selectedPageIds.length === 0) {
      res.status(400).json({
        success: false,
        error: "Missing nonce or selectedPageIds",
      });
      return;
    }

    // Retrieve cached OAuth data
    const cached = getOAuthTokenCache(req.userId, nonce);
    if (!cached) {
      res.status(410).json({
        success: false,
        error: "Session expired. Please reconnect via Facebook.",
      });
      return;
    }

    // Filter to only selected pages
    const selectedPages = cached.pages.filter((p) =>
      selectedPageIds.includes(p.page.pageId)
    );

    if (selectedPages.length === 0) {
      res.status(400).json({
        success: false,
        error: "None of the selected pages were found in the cached data",
      });
      return;
    }

    const userId = cached.userId;
    const accountType = cached.accountType as 'BASIC_AGENCY' | 'MAX_AGENCY' | 'CREATOR' | 'CLIENT' | null;
    const isClientAccount = accountType === 'CLIENT';

    // Gate: check social_accounts limit before connecting
    const { allowed } = await checkFeatureAllowed({
      userId: isClientAccount ? undefined : userId,
      clientId: isClientAccount ? userId : undefined,
      accountType: accountType ?? undefined,
      featureId: "social_accounts",
    });

    if (!allowed) {
      deleteOAuthTokenCache(req.userId, nonce);
      res.status(403).json({
        success: false,
        error: "You've reached your account cluster limit. Please upgrade your plan to connect more accounts.",
      });
      return;
    }

    const connectedAccounts: string[] = [];
    const failedAccounts: string[] = [];

    for (const { page: discoveredPage, pageAccessToken } of selectedPages) {
      const displayName = discoveredPage.igUsername
        ? `${discoveredPage.pageName} → @${discoveredPage.igUsername}`
        : `${discoveredPage.pageName} (Facebook only)`;

      try {
        // Verify permissions
        const permissionCheck = await facebookService.verifyPagePermissions(
          discoveredPage.pageId,
          pageAccessToken,
        );

        if (!permissionCheck.hasCommentPermissions) {
          console.warn(`⚠️  Page ${discoveredPage.pageName} lacks required permissions:`, permissionCheck.errors);
          failedAccounts.push(displayName);
          continue;
        }

        // Get Instagram account details if available
        let igDetails: Awaited<ReturnType<typeof facebookService.getInstagramAccountDetails>> = null;

        if (discoveredPage.igId) {
          igDetails = await facebookService.getInstagramAccountDetails(
            discoveredPage.igId,
            pageAccessToken,
          );

          if (!igDetails) {
            failedAccounts.push(`${discoveredPage.pageName} (${discoveredPage.igUsername || discoveredPage.igId})`);
            continue;
          }

          if (
            igDetails.account_type &&
            igDetails.account_type !== "BUSINESS" &&
            igDetails.account_type !== "CREATOR"
          ) {
            failedAccounts.push(`${discoveredPage.pageName} (${igDetails.username})`);
            continue;
          }
        }

        const igProfilePictureUrl =
          igDetails?.profile_picture_url ||
          discoveredPage.igProfilePic ||
          null;

        // Handle Facebook Page storage with shared ownership support
        // Check if page already exists for THIS specific owner
        let existingPage = await db.query.facebookPages.findFirst({
          where: isClientAccount
            ? and(
                eq(facebookPages.facebookPageId, discoveredPage.pageId),
                eq(facebookPages.clientId, userId)
              )
            : and(
                eq(facebookPages.facebookPageId, discoveredPage.pageId),
                eq(facebookPages.userId, userId)
              ),
        });

        if (!existingPage) {
          existingPage = await db.query.facebookPages.findFirst({
            where: eq(facebookPages.facebookPageId, discoveredPage.pageId),
          });
        }

        let pageId: string;

        if (existingPage) {
          const updateData: Record<string, unknown> = {
            pageName: discoveredPage.pageName,
            pageAccessToken: pageAccessToken,
            tokenExpiresAt: null,
            category: discoveredPage.pageCategory,
            profilePictureUrl: discoveredPage.pageProfilePic,
            isActive: true,
            updatedAt: new Date(),
          };

          if (isClientAccount) {
            updateData.clientId = userId;
          } else {
            updateData.userId = userId;
          }

          await db
            .update(facebookPages)
            .set(updateData)
            .where(eq(facebookPages.id, existingPage.id));

          pageId = existingPage.id;
        } else {
          const [newPage] = await db
            .insert(facebookPages)
            .values({
              ...(isClientAccount ? { clientId: userId } : { userId }),
              facebookPageId: discoveredPage.pageId,
              pageName: discoveredPage.pageName,
              pageAccessToken: pageAccessToken,
              tokenExpiresAt: null,
              category: discoveredPage.pageCategory,
              profilePictureUrl: discoveredPage.pageProfilePic,
              isActive: true,
            })
            .returning();

          pageId = newPage.id;

          // Track account connection for Autumn billing
          const billingCustomerId = await resolveBillingCustomerId({
            userId: isClientAccount ? undefined : userId,
            clientId: isClientAccount ? userId : undefined,
            accountType: accountType ?? undefined,
          });
          if (billingCustomerId) {
            autumn.check({
              customer_id: billingCustomerId,
              feature_id: "social_accounts",
              send_event: true,
            }).catch((err: unknown) => console.error("Autumn check+track (facebook page) failed:", err));
          }
        }

        // Process Instagram account if available
        if (discoveredPage.igId && igDetails) {
          let existingIgAccount = await db.query.instagramAccounts.findFirst({
            where: isClientAccount
              ? and(
                  eq(instagramAccounts.instagramId, discoveredPage.igId),
                  eq(instagramAccounts.clientId, userId)
                )
              : and(
                  eq(instagramAccounts.instagramId, discoveredPage.igId),
                  eq(instagramAccounts.userId, userId)
                ),
          });

          if (!existingIgAccount) {
            existingIgAccount = await db.query.instagramAccounts.findFirst({
              where: eq(instagramAccounts.instagramId, discoveredPage.igId),
            });
          }

          let instagramAccountId: string;

          if (existingIgAccount) {
            const updateData: Record<string, unknown> = {
              facebookPageId: pageId,
              username: igDetails.username,
              name: igDetails.name || null,
              accountType:
                igDetails.account_type === "BUSINESS" || igDetails.account_type === "CREATOR"
                  ? igDetails.account_type
                  : "BUSINESS",
              followersCount: igDetails.followers_count || null,
              followingCount: igDetails.follows_count || null,
              profilePictureUrl: igProfilePictureUrl,
              accessToken: null,
              tokenExpiresAt: null,
              isActive: true,
            };

            if (isClientAccount) {
              updateData.clientId = userId;
            } else {
              updateData.userId = userId;
            }

            await db
              .update(instagramAccounts)
              .set(updateData)
              .where(eq(instagramAccounts.id, existingIgAccount.id));

            instagramAccountId = existingIgAccount.id;
          } else {
            const [newIgAccount] = await db
              .insert(instagramAccounts)
              .values({
                ...(isClientAccount ? { clientId: userId } : { userId }),
                facebookPageId: pageId,
                instagramId: discoveredPage.igId,
                username: igDetails.username,
                name: igDetails.name || null,
                accountType:
                  igDetails.account_type === "BUSINESS" || igDetails.account_type === "CREATOR"
                    ? igDetails.account_type
                    : "BUSINESS",
                followersCount: igDetails.followers_count || null,
                followingCount: igDetails.follows_count || null,
                profilePictureUrl: igProfilePictureUrl,
                accessToken: null,
                tokenExpiresAt: null,
                isActive: true,
              })
              .returning();

            instagramAccountId = newIgAccount.id;

            // Track Instagram account for Autumn billing
            const igBillingCustomerId = await resolveBillingCustomerId({
              userId: isClientAccount ? undefined : userId,
              clientId: isClientAccount ? userId : undefined,
              accountType: accountType ?? undefined,
            });
            if (igBillingCustomerId) {
              autumn.check({
                customer_id: igBillingCustomerId,
                feature_id: "social_accounts",
                send_event: true,
              }).catch((err: unknown) => console.error("Autumn check+track (instagram) failed:", err));
            }
          }

          // Create connection record
          const existingConnection = await db.query.pageInstagramConnections.findFirst({
            where: and(
              eq(pageInstagramConnections.facebookPageId, pageId),
              eq(pageInstagramConnections.instagramAccountId, instagramAccountId),
            ),
          });

          if (!existingConnection) {
            await db.insert(pageInstagramConnections).values({
              facebookPageId: pageId,
              instagramAccountId: instagramAccountId,
              isVerified: true,
              verifiedAt: new Date(),
            });
          }

          // Start auto-sync in background
          const accessToken = await getPageAccessToken(instagramAccountId);
          if (accessToken) {
            syncAccountData(
              instagramAccountId,
              discoveredPage.igId,
              accessToken,
              true,
              false,
              false
            ).catch((err) => {
              console.error(`❌ [AUTO-SYNC] Error for ${igDetails.username}:`, err);
            });
          }

          connectedAccounts.push(igDetails.username);
        } else {
          // Facebook page only — sync in background
          deepSyncFacebookPage(pageId).catch((err) => {
            console.error(`❌ [AUTO-SYNC] Error for FB page ${discoveredPage.pageName}:`, err);
          });
          connectedAccounts.push(`${discoveredPage.pageName} (Facebook Page)`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error(`❌ Error connecting Page ${discoveredPage.pageName}:`, errorMessage);
        failedAccounts.push(displayName);
      }
    }

    // Clean up cache after use
    deleteOAuthTokenCache(req.userId, nonce);

    if (connectedAccounts.length === 0) {
      res.status(400).json({
        success: false,
        error: "Failed to connect any accounts. Please try again.",
      });
      return;
    }

    res.json({
      success: true,
      data: { connectedAccounts, failedAccounts },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Connect selected accounts error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to connect selected accounts",
    });
  }
}

/**
 * Get user's Facebook Pages with Instagram accounts
 */
export async function getPages(
  req: AuthRequest,
  res: Response<
    ApiResponse<
      Array<{
        id: string;
        facebookPageId: string;
        pageName: string;
        category: string | null;
        profilePictureUrl: string | null;
        instagramUsername: string | null;
        instagramId: string | null;
        isActive: boolean;
        createdAt: Date | null;
      }>
    >
  >,
): Promise<void> {
  try {
    const delegationReq = req as DelegationRequest;
    const effectiveClientId = delegationReq.effectiveClientId;
    const effectiveUserId = delegationReq.effectiveUserId ?? req.userId;

    if (!effectiveUserId && !effectiveClientId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    // Return pages by effective owner: by clientId when agency delegates, else by userId
    const ownerCondition = effectiveClientId
      ? eq(facebookPages.clientId, effectiveClientId)
      : eq(facebookPages.userId, effectiveUserId!);

    // Get all pages for this user/client (no relation - we query instagram accounts per page below)
    const pages = await db.query.facebookPages.findMany({
      where: ownerCondition,
    });

    // Transform to response format
    const pageData = await Promise.all(
      pages.map(async (page) => {
        const igAccounts = await db.query.instagramAccounts.findMany({
          where: eq(instagramAccounts.facebookPageId, page.id),
        });
        const igAccount = igAccounts[0] || null;

        return {
          id: page.id,
          facebookPageId: page.facebookPageId,
          pageName: page.pageName,
          category: page.category,
          profilePictureUrl: page.profilePictureUrl ?? null,
          instagramUsername: igAccount?.username || null,
          instagramId: igAccount?.instagramId || null,
          isActive: page.isActive ?? false,
          createdAt: page.createdAt,
        };
      }),
    );

    res.json({
      success: true,
      data: pageData,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Get Facebook Pages error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Facebook Pages",
    });
  }
}

/**
 * Connect a specific Facebook Page
 */
export async function connectPage(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    // This would require storing the user's access token temporarily
    // For now, just return success - the main connection happens in the callback
    res.json({
      success: true,
      data: { success: true },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Connect Facebook Page error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to connect Facebook Page",
    });
  }
}

/**
 * Disconnect a Facebook Page
 */
export async function disconnectPage(
  req: AuthRequest,
  res: Response<ApiResponse<{ success: boolean }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { pageId } = req.params;

    // Get the page
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId),
    });

    if (!page) {
      res.status(404).json({
        success: false,
        error: "Facebook Page not found",
      });
      return;
    }

    // Verify ownership
    if (page.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
      });
      return;
    }

    // Soft delete - set isActive to false
    await db
      .update(facebookPages)
      .set({ isActive: false })
      .where(eq(facebookPages.id, pageId));

    // Also deactivate associated Instagram accounts
    await db
      .update(instagramAccounts)
      .set({ isActive: false })
      .where(eq(instagramAccounts.facebookPageId, pageId));

    res.json({
      success: true,
      data: { success: true },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Disconnect Facebook Page error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to disconnect Facebook Page",
    });
  }
}

/**
 * Sync Facebook Page posts and comments
 */
export async function syncPage(
  req: AuthRequest,
  res: Response<ApiResponse<{ postsCount: number; commentsCount: number }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { pageId } = req.params;
    const includeComments = req.query.includeComments !== "false"; // Default true

    // Get the page
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId),
    });

    if (!page) {
      res.status(404).json({
        success: false,
        error: "Facebook Page not found",
      });
      return;
    }

    // Verify ownership
    if (page.userId !== req.userId) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
      });
      return;
    }

    if (!page.isActive) {
      res.status(400).json({
        success: false,
        error: "Page is not active",
      });
      return;
    }

    // Start sync in background
    syncFacebookPageData(
      pageId,
      page.facebookPageId,
      page.pageAccessToken,
      includeComments,
    ).catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Background sync error:", errorMessage);
    });

    res.json({
      success: true,
      data: {
        postsCount: 0, // Will be updated by background sync
        commentsCount: 0,
      },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Sync Facebook Page error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to sync Facebook Page",
    });
  }
}

/**
 * Refresh comments for a Facebook Page
 */
export async function refreshComments(
  req: AuthRequest,
  res: Response<ApiResponse<{ commentsCount: number }>>,
): Promise<void> {
  try {
    const delegationReq = req as DelegationRequest;
    const effectiveClientId = delegationReq.effectiveClientId;
    const effectiveUserId = delegationReq.effectiveUserId ?? req.userId;

    if (!effectiveUserId && !effectiveClientId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
      return;
    }

    const { pageId } = req.params;

    // Get the page
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId),
    });

    if (!page) {
      res.status(404).json({
        success: false,
        error: "Facebook Page not found",
      });
      return;
    }

    // Verify ownership - check against effective owner
    const isOwner = effectiveClientId
      ? page.clientId === effectiveClientId
      : page.userId === effectiveUserId;

    if (!isOwner) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
      });
      return;
    }

    if (!page.isActive) {
      res.status(400).json({
        success: false,
        error: "Page is not active",
      });
      return;
    }

    // Start refresh in background
    syncFacebookPageData(
      pageId,
      page.facebookPageId,
      page.pageAccessToken,
      true,
    ).catch((error: unknown) => {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Background refresh error:", errorMessage);
    });

    res.json({
      success: true,
      data: {
        commentsCount: 0, // Will be updated by background sync
      },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Refresh Facebook Page comments error:", errorMessage);
    res.status(500).json({
      success: false,
      error: "Failed to refresh comments",
    });
  }
}

/**
 * Manually trigger a Deep Sync for a Facebook Page.
 * This runs in the background and returns immediately.
 */
export async function manualDeepSync(
  req: AuthRequest,
  res: Response<ApiResponse<{ message: string }>>,
): Promise<void> {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const { pageId } = req.params;
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId),
    });

    if (!page) {
      res.status(404).json({ success: false, error: "Page not found" });
      return;
    }

    if (page.userId !== req.userId) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    // Trigger background job
    deepSyncFacebookPage(pageId).catch((err) => {
      console.error(`[MANUAL SYNC] Failed for page ${page.pageName}:`, err);
    });

    res.status(202).json({
      success: true,
      data: { message: "Deep sync started in background" },
    });
  } catch (error) {
    console.error("Manual Deep Sync error:", error);
    res.status(500).json({ success: false, error: "Failed to start sync" });
  }
}

/**
 * Get Facebook Page stats (similar to Instagram account stats)
 */
export async function getPageStats(
  req: AuthRequest,
  res: Response<
    ApiResponse<{
      page: {
        id: string;
        pageName: string;
        category: string | null;
        profilePictureUrl: string | null;
      };
      insights: unknown[];
      comments: {
        total: number;
        flagged: number;
        hidden: number;
        positive: number;
        negative: number;
        sentimentRatio: number;
      };
      posts: Array<{
        id: string;
        fbPostId: string | null;
        caption: string | null;
        postedAt: Date;
        likesCount: number | null;
        commentsCount: number | null;
        commentStats: {
          total: number;
          flagged: number;
          hidden: number;
          deleted: number;
          positive: number;
          negative: number;
          sentimentRatio: number;
        };
      }>;
      overall: {
        totalPosts: number;
        totalComments: number;
        totalFlagged: number;
        totalHidden: number;
        totalDeleted: number;
        totalPositive: number;
        totalNegative: number;
        overallSentimentRatio: number;
      };
    }>
  >,
): Promise<void> {
  try {
    const delegationReq = req as DelegationRequest;
    const effectiveClientId = delegationReq.effectiveClientId;
    const effectiveUserId = delegationReq.effectiveUserId ?? req.userId;

    if (!effectiveUserId && !effectiveClientId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const { pageId } = req.params;

    // Get the page
    const page = await db.query.facebookPages.findFirst({
      where: eq(facebookPages.id, pageId),
    });

    if (!page) {
      res
        .status(404)
        .json({ success: false, error: "Facebook Page not found" });
      return;
    }

    // Verify ownership - check against effective owner
    const isOwner = effectiveClientId
      ? page.clientId === effectiveClientId
      : page.userId === effectiveUserId;

    if (!isOwner) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    // Get all posts for this page
    const pagePosts = await db.query.posts.findMany({
      where: eq(posts.facebookPageId, pageId),
      orderBy: (posts, { desc }) => [desc(posts.postedAt)],
    });

    // Get all comments for these posts
    const postIds = pagePosts.map((p) => p.id);
    let allComments: Comment[] = [];
    if (postIds.length > 0) {
      allComments = await db.query.comments.findMany({
        where: (comments, { inArray }) => inArray(comments.postId, postIds),
      });
    }

    // Calculate overall stats
    const totalComments = allComments.length;
    const totalFlagged = allComments.filter((c) => c.isReported).length;
    const totalHidden = allComments.filter((c) => c.isHidden).length;
    const totalDeleted = allComments.filter((c) => c.deletedAt !== null).length;
    const totalPositive = 0; // Sentiment analysis not yet implemented
    const totalNegative = 0; // Sentiment analysis not yet implemented
    const overallSentimentRatio = 0;

    // Calculate stats per post
    const postsWithStats = pagePosts.map((post) => {
      const postComments = allComments.filter((c) => c.postId === post.id);
      const flagged = postComments.filter((c) => c.isReported).length;
      const hidden = postComments.filter((c) => c.isHidden).length;
      const deleted = postComments.filter((c) => c.deletedAt !== null).length;
      const positive = 0; // Sentiment analysis not yet implemented
      const negative = 0; // Sentiment analysis not yet implemented
      const sentimentRatio = 0;

      return {
        id: post.id,
        fbPostId: post.fbPostId,
        caption: post.caption,
        postedAt: post.postedAt,
        likesCount: post.likesCount,
        commentsCount: post.commentsCount,
        commentStats: {
          total: postComments.length,
          flagged,
          hidden,
          deleted,
          positive,
          negative,
          sentimentRatio,
        },
      };
    });

    res.json({
      success: true,
      data: {
        page: {
          id: page.id,
          pageName: page.pageName,
          category: page.category,
          profilePictureUrl: page.profilePictureUrl,
        },
        insights: [], // Facebook page insights would go here if we fetch them
        comments: {
          total: totalComments,
          flagged: totalFlagged,
          hidden: totalHidden,
          positive: totalPositive,
          negative: totalNegative,
          sentimentRatio: overallSentimentRatio,
        },
        posts: postsWithStats,
        overall: {
          totalPosts: pagePosts.length,
          totalComments,
          totalFlagged,
          totalHidden,
          totalDeleted,
          totalPositive,
          totalNegative,
          overallSentimentRatio,
        },
      },
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Get Facebook Page stats error:", errorMessage);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch page stats" });
  }
}

/**
 * Background function to sync Facebook Page posts and comments
 */
async function syncFacebookPageData(
  internalPageId: string,
  facebookPageId: string,
  pageAccessToken: string,
  includeComments: boolean = true,
): Promise<{ postsCount: number; commentsCount: number }> {
  try {
    console.log(`🔄 Starting sync for Facebook Page ${facebookPageId}`);

    // Fetch all published posts
    const fbPosts = await facebookService.getPagePublishedPosts(
      facebookPageId,
      pageAccessToken,
    );

    let newPostsCount = 0;
    let newCommentsCount = 0;

    // Store posts in database
    for (const fbPost of fbPosts) {
      try {
        // Check if post already exists for this page
        const existingPost = await db.query.posts.findFirst({
          where: and(
            eq(posts.fbPostId, fbPost.id),
            eq(posts.facebookPageId, internalPageId),
          ),
        });

        let dbPost;
        if (existingPost) {
          // Update existing post
          await db
            .update(posts)
            .set({
              caption: fbPost.message || null,
              likesCount: fbPost.likes?.summary?.total_count || null,
              commentsCount: fbPost.comments?.summary?.total_count || null,
            })
            .where(eq(posts.id, existingPost.id));
          dbPost = { ...existingPost, caption: fbPost.message || null };
        } else {
          // Insert new post
          const [newPost] = await db
            .insert(posts)
            .values({
              source: "facebook",
              facebookPageId: internalPageId,
              fbPostId: fbPost.id,
              caption: fbPost.message || null,
              permalink: fbPost.permalink_url || null,
              postedAt: new Date(fbPost.created_time),
              likesCount: fbPost.likes?.summary?.total_count || null,
              commentsCount: fbPost.comments?.summary?.total_count || null,
            })
            .returning();

          dbPost = newPost;
          newPostsCount++;
        }

        // Fetch and store comments if requested
        if (includeComments) {
          const fbComments = await facebookService.getPostComments(
            fbPost.id,
            pageAccessToken,
          );

          // Separate top-level comments from replies
          const topLevelComments = fbComments.filter((c) => !c.parent);
          const replies = fbComments.filter((c) => c.parent);

          console.log(
            `  💬 Processing ${topLevelComments.length} top-level comments, ${replies.length} replies`,
          );

          // Store top-level comments first
          const commentIdMap = new Map<string, string>(); // Maps Facebook comment ID to database UUID

          for (const fbComment of topLevelComments) {
            try {
              // Check if comment already exists for this post
              const existingComment = await db.query.comments.findFirst({
                where: and(
                  eq(comments.fbCommentId, fbComment.id),
                  eq(comments.postId, dbPost.id),
                ),
              });

              if (existingComment) {
                // Update existing comment
                await db
                  .update(comments)
                  .set({
                    text: fbComment.message,
                    isHidden: fbComment.is_hidden || false,
                  })
                  .where(eq(comments.id, existingComment.id));
                commentIdMap.set(fbComment.id, existingComment.id);
              } else {
                // Insert new comment
                const [newComment] = await db
                  .insert(comments)
                  .values({
                    source: "facebook",
                    postId: dbPost.id,
                    fbCommentId: fbComment.id,
                    text: fbComment.message,
                    commenterUsername: fbComment.from.name,
                    commenterId: fbComment.from.id,
                    commentedAt: new Date(fbComment.created_time),
                    isHidden: fbComment.is_hidden || false,
                  })
                  .returning();

                commentIdMap.set(fbComment.id, newComment.id);
                newCommentsCount++;
              }
            } catch (commentError: unknown) {
              const errorMessage =
                commentError instanceof Error
                  ? commentError.message
                  : "Unknown error";
              console.error(
                `  ❌ Failed to store comment ${fbComment.id}:`,
                errorMessage,
              );
            }
          }

          // Store replies
          for (const fbReply of replies) {
            try {
              // Check if reply already exists for this post
              const existingReply = await db.query.comments.findFirst({
                where: and(
                  eq(comments.fbCommentId, fbReply.id),
                  eq(comments.postId, dbPost.id),
                ),
              });

              if (existingReply) {
                // Update existing reply
                await db
                  .update(comments)
                  .set({
                    text: fbReply.message,
                    isHidden: fbReply.is_hidden || false,
                  })
                  .where(eq(comments.id, existingReply.id));
              } else {
                // Get parent comment database ID
                const parentDbId = commentIdMap.get(fbReply.parent!.id);

                if (parentDbId) {
                  // Insert new reply
                  await db.insert(comments).values({
                    source: "facebook",
                    postId: dbPost.id,
                    parentCommentId: parentDbId,
                    fbCommentId: fbReply.id,
                    text: fbReply.message,
                    commenterUsername: fbReply.from.name,
                    commenterId: fbReply.from.id,
                    commentedAt: new Date(fbReply.created_time),
                    isHidden: fbReply.is_hidden || false,
                  });

                  newCommentsCount++;
                } else {
                  console.warn(
                    `  ⚠️  Parent comment ${fbReply.parent!.id} not found for reply ${fbReply.id}`,
                  );
                }
              }
            } catch (replyError: unknown) {
              const errorMessage =
                replyError instanceof Error
                  ? replyError.message
                  : "Unknown error";
              console.error(
                `  ❌ Failed to store reply ${fbReply.id}:`,
                errorMessage,
              );
            }
          }
        }
      } catch (postError: unknown) {
        const errorMessage =
          postError instanceof Error ? postError.message : "Unknown error";
        console.error(
          `  ❌ Failed to process post ${fbPost.id}:`,
          errorMessage,
        );
      }
    }

    console.log(
      `✅ Sync complete: ${newPostsCount} new posts, ${newCommentsCount} new comments`,
    );
    return { postsCount: newPostsCount, commentsCount: newCommentsCount };
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Sync failed:", errorMessage);
    throw error;
  }
}
