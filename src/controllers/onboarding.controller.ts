import { Response } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { AuthRequest } from '../middleware/auth.middleware';
import { ApiResponse } from '../types';
import { storageService } from '../services/storage.service';

interface BrandingConfig {
  brandColor?: string;
  tagline?: string;
}

/**
 * Save branding information for agency accounts
 */
export async function saveBranding(
  req: AuthRequest,
  res: Response<ApiResponse<{ redirectTo: string }>>
): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated'
      });
      return;
    }

    const { brandColor, tagline } = req.body as BrandingConfig;
    const logoFile = req.file;

    // Fetch user to verify they're an agency
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user.userId))
      .limit(1);

    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found'
      });
      return;
    }

    // Verify user is an agency
    if (user.accountType !== 'BASIC_AGENCY' && user.accountType !== 'MAX_AGENCY') {
      res.status(403).json({
        success: false,
        error: 'Only agency accounts can set branding'
      });
      return;
    }

    let logoUrl: string | undefined = undefined;

    // Upload logo if provided
    if (logoFile) {
      try {
        const folder = `logos/${req.user.userId}`;
        logoUrl = await storageService.uploadFile(logoFile, folder);
      } catch (uploadError) {
        console.error('Logo upload error:', uploadError);
        res.status(500).json({
          success: false,
          error: 'Failed to upload logo'
        });
        return;
      }
    }

    // Build branding config object
    const brandingConfig: BrandingConfig = {};
    if (brandColor) {
      brandingConfig.brandColor = brandColor;
    }
    if (tagline) {
      brandingConfig.tagline = tagline;
    }

    // Update user with branding information
    const updateData: {
      logoUrl?: string;
      brandingConfig?: BrandingConfig;
      updatedAt: Date;
    } = {
      updatedAt: new Date()
    };

    if (logoUrl) {
      updateData.logoUrl = logoUrl;
    }

    if (Object.keys(brandingConfig).length > 0) {
      updateData.brandingConfig = brandingConfig;
    }

    await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, req.user.userId));

    res.json({
      success: true,
      data: {
        redirectTo: '/client/agency/dashboard'
      }
    });
  } catch (error) {
    console.error('Save branding error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save branding'
    });
  }
}
