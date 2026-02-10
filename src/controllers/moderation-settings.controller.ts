import { Request, Response } from 'express';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { moderationSettings, instagramAccounts, clients, users } from '../db/schema';
import { ApiResponse } from '../types';
import { getEffectiveOwner, DelegationRequest } from '../middleware/delegation.middleware';
import { isAgency } from '../utils/account-type.utils';

interface AuthenticatedRequest extends Request {
  userId?: string;
  clientId?: string;
}

interface AccountSpecificSetting {
  id: string;
  clientId: string | null;
  userId: string | null;
  managedClientId: string | null;
  instagramAccountId: string | null;
  globalThreshold: number | null;
  blackmailThreshold: number | null;
  threatThreshold: number | null;
  harassmentThreshold: number | null;
  defamationThreshold: number | null;
  spamThreshold: number | null;
  autoDeleteBlackmail: boolean | null;
  autoDeleteThreat: boolean | null;
  autoDeleteHarassment: boolean | null;
  autoDeleteDefamation: boolean | null;
  autoDeleteSpam: boolean | null;
  flagHideBlackmail: boolean | null;
  flagHideThreat: boolean | null;
  flagHideHarassment: boolean | null;
  flagHideDefamation: boolean | null;
  flagHideSpam: boolean | null;
  flagDeleteBlackmail: boolean | null;
  flagDeleteThreat: boolean | null;
  flagDeleteHarassment: boolean | null;
  flagDeleteDefamation: boolean | null;
  flagDeleteSpam: boolean | null;
  flagHideBlackmailThreshold: number | null;
  flagHideThreatThreshold: number | null;
  flagHideHarassmentThreshold: number | null;
  flagHideDefamationThreshold: number | null;
  flagHideSpamThreshold: number | null;
  flagDeleteBlackmailThreshold: number | null;
  flagDeleteThreatThreshold: number | null;
  flagDeleteHarassmentThreshold: number | null;
  flagDeleteDefamationThreshold: number | null;
  flagDeleteSpamThreshold: number | null;
  enableKeywordFilter: boolean | null;
  enableLlmFilter: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  instagramAccount?: {
    id: string;
    username: string;
    name: string | null;
  } | null;
}

interface ClientSpecificSetting extends AccountSpecificSetting {
  client?: { id: string; businessName: string } | null;
}

interface ModerationSettingsResponse {
  global: AccountSpecificSetting | null;
  accountSpecific: AccountSpecificSetting[];
  clientSpecific: ClientSpecificSetting[];
  migrationNeeded?: boolean;
}

export class ModerationSettingsController {
  /**
   * Get all moderation settings for the authenticated user/client
   * Returns global settings (default for all accounts) and account-specific settings (overrides)
   */
  async getModerationSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ModerationSettingsResponse>>
  ): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId ?? req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Build ownership condition (who owns these settings)
      const ownershipCondition = clientId
        ? eq(moderationSettings.clientId, clientId)
        : userId
          ? eq(moderationSettings.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Global: instagramAccountId NULL and managedClientId NULL (so agency global is separate from client rules)
      const globalCondition = and(
        isNull(moderationSettings.instagramAccountId),
        isNull(moderationSettings.managedClientId),
        ownershipCondition
      );

      const globalSettings = await db
        .select()
        .from(moderationSettings)
        .where(globalCondition)
        .limit(1);

      // Account-specific: instagramAccountId NOT NULL and managedClientId NULL
      const accountSettingsRaw = await db
        .select()
        .from(moderationSettings)
        .where(
          and(
            ownershipCondition,
            sql`${moderationSettings.instagramAccountId} IS NOT NULL`,
            isNull(moderationSettings.managedClientId)
          )
        );

      const accountSettings: AccountSpecificSetting[] = await Promise.all(
        accountSettingsRaw.map(async (setting) => {
          if (!setting.instagramAccountId) {
            return setting as AccountSpecificSetting;
          }

          const account = await db
            .select({
              id: instagramAccounts.id,
              username: instagramAccounts.username,
              name: instagramAccounts.name
            })
            .from(instagramAccounts)
            .where(eq(instagramAccounts.id, setting.instagramAccountId))
            .limit(1);

          return {
            ...setting,
            instagramAccount: account[0] || null
          } as AccountSpecificSetting;
        })
      );

      // For agency (userId set, no client delegation): also return client-specific rules
      let clientSpecific: ClientSpecificSetting[] = [];
      if (userId && !clientId) {
        try {
          const user = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: { accountType: true }
          });
          const userIsAgency = user?.accountType ? isAgency(user.accountType) : false;
          if (userIsAgency) {
            const clientSettingsRaw = await db
              .select()
              .from(moderationSettings)
              .where(
                and(
                  eq(moderationSettings.userId, userId),
                  sql`${moderationSettings.managedClientId} IS NOT NULL`,
                  isNull(moderationSettings.instagramAccountId)
                )
              );
            clientSpecific = await Promise.all(
              clientSettingsRaw.map(async (setting) => {
                const clientInfo = setting.managedClientId
                  ? await db
                      .select({ id: clients.id, businessName: clients.businessName })
                      .from(clients)
                      .where(eq(clients.id, setting.managedClientId!))
                      .limit(1)
                  : [];
                return {
                  ...setting,
                  client: clientInfo[0] || null
                } as ClientSpecificSetting;
              })
            );
          }
        } catch (agencyErr) {
          // Column managedClientId may not exist yet
          if (agencyErr instanceof Error && !String(agencyErr.message).includes('managed_client_id')) {
            console.error('Error fetching client-specific settings:', agencyErr);
          }
        }
      }

      res.json({
        success: true,
        data: {
          global: (globalSettings[0] as AccountSpecificSetting) || null,
          accountSpecific: accountSettings,
          clientSpecific
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching moderation settings:', errorMessage);

      // Check if it's a column missing error (e.g. managed_client_id not yet migrated)
      if (error instanceof Error && ((error as { code?: string }).code === '42703' || error.message.includes('instagramAccountId') || error.message.includes('managed_client_id') || error.message.includes('managedClientId'))) {
        console.warn('Database schema needs updating. Returning basic settings.');
        res.json({
          success: true,
          data: {
            global: null,
            accountSpecific: [],
            clientSpecific: [],
            migrationNeeded: true
          }
        });
      } else {
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    }
  }

  /**
   * Update global moderation settings
   * Global settings apply to all accounts by default
   */
  async updateGlobalSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<AccountSpecificSetting>>
  ): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId ?? req.clientId;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const settingsData = req.body as Partial<AccountSpecificSetting>;

      // Build ownership condition
      const ownershipCondition = clientId
        ? eq(moderationSettings.clientId, clientId)
        : userId
          ? eq(moderationSettings.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Filter out fields that shouldn't be updated
      const {
        id,
        clientId: _clientId,
        userId: _userId,
        managedClientId: _managedClientId,
        instagramAccountId: _instagramAccountId,
        createdAt,
        updatedAt,
        instagramAccount,
        client: _client,
        ...updateableFields
      } = settingsData as any;

      // Find existing global settings (no account, no managed client)
      const existingSettings = await db
        .select()
        .from(moderationSettings)
        .where(
          and(
            isNull(moderationSettings.instagramAccountId),
            isNull(moderationSettings.managedClientId),
            ownershipCondition
          )
        )
        .limit(1);

      if (existingSettings.length > 0) {
        const [updatedSettings] = await db
          .update(moderationSettings)
          .set({
            ...updateableFields,
            updatedAt: new Date()
          })
          .where(eq(moderationSettings.id, existingSettings[0].id))
          .returning();

        res.json({
          success: true,
          data: updatedSettings as AccountSpecificSetting
        });
      } else {
        const [newSettings] = await db
          .insert(moderationSettings)
          .values({
            ...updateableFields,
            clientId: clientId || null,
            userId: userId || null,
            managedClientId: null,
            instagramAccountId: null
          })
          .returning();

        res.json({
          success: true,
          data: newSettings as AccountSpecificSetting
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('Error updating global moderation settings:', errorMessage);
      console.error('Stack trace:', errorStack);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? { message: errorMessage } : undefined
      });
    }
  }

  /**
   * Create or update account-specific moderation settings
   * Account-specific settings override global settings for that account
   */
  async updateAccountSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<AccountSpecificSetting>>
  ): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId ?? req.clientId;
      const { instagramAccountId, ...rawSettingsData } = req.body as { instagramAccountId: string } & Partial<AccountSpecificSetting>;

      // Filter out fields that shouldn't be updated
      const {
        id,
        clientId: _clientId,
        userId: _userId,
        managedClientId: _managedClientId,
        createdAt,
        updatedAt,
        instagramAccount,
        client: _client2,
        ...settingsData
      } = rawSettingsData as any;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      if (!instagramAccountId || typeof instagramAccountId !== 'string') {
        res.status(400).json({ success: false, error: 'instagramAccountId is required' });
        return;
      }

      // Build account ownership condition
      const accountOwnershipCondition = clientId
        ? eq(instagramAccounts.clientId, clientId)
        : userId
          ? eq(instagramAccounts.userId, userId)
          : undefined;

      if (!accountOwnershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Verify the Instagram account belongs to the user/client
      const accountCheck = await db
        .select()
        .from(instagramAccounts)
        .where(
          and(
            eq(instagramAccounts.id, instagramAccountId),
            accountOwnershipCondition
          )
        )
        .limit(1);

      if (accountCheck.length === 0) {
        res.status(403).json({ success: false, error: 'Instagram account not found or not authorized' });
        return;
      }

      // Build settings ownership condition
      const settingsOwnershipCondition = clientId
        ? eq(moderationSettings.clientId, clientId)
        : userId
          ? eq(moderationSettings.userId, userId)
          : undefined;

      if (!settingsOwnershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Find existing account-specific settings (managedClientId must be null)
      const existingSettings = await db
        .select()
        .from(moderationSettings)
        .where(
          and(
            eq(moderationSettings.instagramAccountId, instagramAccountId),
            isNull(moderationSettings.managedClientId),
            settingsOwnershipCondition
          )
        )
        .limit(1);

      if (existingSettings.length > 0) {
        const [updatedSettings] = await db
          .update(moderationSettings)
          .set({
            ...settingsData,
            updatedAt: new Date()
          })
          .where(eq(moderationSettings.id, existingSettings[0].id))
          .returning();

        res.json({
          success: true,
          data: updatedSettings as AccountSpecificSetting
        });
      } else {
        const [newSettings] = await db
          .insert(moderationSettings)
          .values({
            ...settingsData,
            clientId: clientId || null,
            userId: userId || null,
            managedClientId: null,
            instagramAccountId
          })
          .returning();

        res.json({
          success: true,
          data: newSettings as AccountSpecificSetting
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error('Error updating account-specific moderation settings:', errorMessage);
      console.error('Stack trace:', errorStack);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? { message: errorMessage } : undefined
      });
    }
  }

  /**
   * Delete account-specific moderation settings (revert to global)
   * When deleted, the account will use global settings as fallback
   */
  async deleteAccountSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ message: string }>>
  ): Promise<void> {
    try {
      const delegationReq = req as DelegationRequest;
      const { userId: effectiveUserId, clientId: effectiveClientId } = getEffectiveOwner(delegationReq);
      const userId = effectiveUserId ?? req.userId;
      const clientId = effectiveClientId ?? req.clientId;
      const { instagramAccountId } = req.params;

      if (!userId && !clientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      if (!instagramAccountId || typeof instagramAccountId !== 'string') {
        res.status(400).json({ success: false, error: 'instagramAccountId is required' });
        return;
      }

      const ownershipCondition = clientId
        ? eq(moderationSettings.clientId, clientId)
        : userId
          ? eq(moderationSettings.userId, userId)
          : undefined;

      if (!ownershipCondition) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      await db
        .delete(moderationSettings)
        .where(
          and(
            eq(moderationSettings.instagramAccountId, instagramAccountId),
            isNull(moderationSettings.managedClientId),
            ownershipCondition
          )
        );

      res.json({
        success: true,
        data: {
          message: 'Account-specific settings deleted, now using global settings'
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error deleting account-specific moderation settings:', errorMessage);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Create or update client-specific moderation settings (agency only)
   * These apply when moderating that client's accounts; override client's own global settings.
   */
  async updateClientSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<AccountSpecificSetting>>
  ): Promise<void> {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { managedClientId, ...rawSettingsData } = req.body as { managedClientId: string } & Partial<AccountSpecificSetting>;
      if (!managedClientId || typeof managedClientId !== 'string') {
        res.status(400).json({ success: false, error: 'managedClientId is required' });
        return;
      }

      // Verify user is agency and owns this client
      const [agencyUser, clientRow] = await Promise.all([
        db.query.users.findFirst({ where: eq(users.id, userId), columns: { accountType: true } }),
        db.query.clients.findFirst({
          where: and(eq(clients.id, managedClientId), eq(clients.userId, userId)),
          columns: { id: true }
        })
      ]);

      if ((agencyUser?.accountType !== 'BASIC_AGENCY' && agencyUser?.accountType !== 'MAX_AGENCY') || !clientRow) {
        res.status(403).json({ success: false, error: 'Only agencies can set client rules; client not found or not owned by you' });
        return;
      }

      const {
        id,
        clientId: _c,
        userId: _u,
        managedClientId: _m,
        instagramAccountId: _i,
        createdAt,
        updatedAt,
        instagramAccount,
        client: _client3,
        ...settingsData
      } = rawSettingsData as any;

      const existing = await db
        .select()
        .from(moderationSettings)
        .where(
          and(
            eq(moderationSettings.userId, userId),
            eq(moderationSettings.managedClientId, managedClientId),
            isNull(moderationSettings.instagramAccountId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const [updated] = await db
          .update(moderationSettings)
          .set({ ...settingsData, updatedAt: new Date() })
          .where(eq(moderationSettings.id, existing[0].id))
          .returning();
        res.json({ success: true, data: updated as AccountSpecificSetting });
      } else {
        const [inserted] = await db
          .insert(moderationSettings)
          .values({
            ...settingsData,
            userId,
            clientId: null,
            managedClientId,
            instagramAccountId: null
          })
          .returning();
        res.json({ success: true, data: inserted as AccountSpecificSetting });
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error updating client moderation settings:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * Delete client-specific moderation settings (agency only)
   */
  async deleteClientSettings(
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ message: string }>>
  ): Promise<void> {
    try {
      const userId = req.userId;
      const { managedClientId } = req.params;

      if (!userId || !managedClientId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const [agencyUser, clientRow] = await Promise.all([
        db.query.users.findFirst({ where: eq(users.id, userId), columns: { accountType: true } }),
        db.query.clients.findFirst({
          where: and(eq(clients.id, managedClientId), eq(clients.userId, userId)),
          columns: { id: true }
        })
      ]);

      if ((agencyUser?.accountType !== 'BASIC_AGENCY' && agencyUser?.accountType !== 'MAX_AGENCY') || !clientRow) {
        res.status(403).json({ success: false, error: 'Client not found or not owned by you' });
        return;
      }

      await db
        .delete(moderationSettings)
        .where(
          and(
            eq(moderationSettings.userId, userId),
            eq(moderationSettings.managedClientId, managedClientId),
            isNull(moderationSettings.instagramAccountId)
          )
        );

      res.json({
        success: true,
        data: { message: 'Client-specific settings deleted' }
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error deleting client moderation settings:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const moderationSettingsController = new ModerationSettingsController();