import { Request, Response } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import { AuthRequest } from '../middleware/auth.middleware';
import { ApiResponse } from '../types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { storageService } from '../services/storage.service';

const UpdateAgencyProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  logoUrl: z.string().url().optional().nullable(),
  brandingConfig: z.object({
    displayName: z.string().optional(),
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    coverImageUrl: z.string().url().optional().nullable(),
  }).optional().nullable(),
});

/**
 * Update agency profile (name, logo, branding)
 */
export async function updateAgencyProfile(
  req: AuthRequest,
  res: Response<ApiResponse<{ user: { id: string; name: string | null; logoUrl: string | null } }>>
): Promise<void> {
  try {
    const agencyUserId = req.userId;

    if (!agencyUserId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
      return;
    }

    // Verify the user is an agency
    const agencyUser = await db.query.users.findFirst({
      where: eq(users.id, agencyUserId)
    });

    if (!agencyUser || (agencyUser.accountType !== 'BASIC_AGENCY' && agencyUser.accountType !== 'MAX_AGENCY')) {
      res.status(403).json({
        success: false,
        error: 'Only agencies can update agency profiles'
      });
      return;
    }

    // Validate request body
    const validated = UpdateAgencyProfileSchema.parse(req.body);

    // Update user
    const [updatedUser] = await db
      .update(users)
      .set({
        name: validated.name !== undefined ? validated.name : agencyUser.name,
        logoUrl: validated.logoUrl !== undefined ? validated.logoUrl : agencyUser.logoUrl,
        brandingConfig: validated.brandingConfig !== undefined ? validated.brandingConfig : agencyUser.brandingConfig,
        updatedAt: new Date()
      })
      .where(eq(users.id, agencyUserId))
      .returning({
        id: users.id,
        name: users.name,
        logoUrl: users.logoUrl,
      });

    res.json({
      success: true,
      data: {
        user: updatedUser
      }
    });
  } catch (error) {
    console.error('Update agency profile error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update agency profile'
    });
  }
}

function isS3Url(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.hostname.endsWith('.amazonaws.com') || u.hostname.includes('s3.');
  } catch {
    return false;
  }
}

/**
 * Get current agency's profile (authenticated – for agency settings page)
 * Returns logoDisplayUrl and coverDisplayUrl as signed URLs when stored in S3 so images load in the browser.
 */
export async function getAgencyProfile(
  req: AuthRequest,
  res: Response<ApiResponse<{
    name: string | null;
    logoUrl: string | null;
    logoDisplayUrl: string | null;
    brandingConfig: Record<string, unknown> | null;
    coverDisplayUrl?: string | null;
  }>>
): Promise<void> {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const agencyUser = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });

    if (!agencyUser || (agencyUser.accountType !== 'BASIC_AGENCY' && agencyUser.accountType !== 'MAX_AGENCY')) {
      res.status(403).json({
        success: false,
        error: 'Only agencies can access agency profile'
      });
      return;
    }

    const branding = agencyUser.brandingConfig as Record<string, unknown> | null;
    const coverImageUrl = branding?.coverImageUrl as string | null | undefined;
    let logoDisplayUrl: string | null = agencyUser.logoUrl;
    let coverDisplayUrl: string | null = coverImageUrl ?? null;

    if (agencyUser.logoUrl && isS3Url(agencyUser.logoUrl)) {
      try {
        logoDisplayUrl = await storageService.getSignedUrl(storageService.extractKeyFromUrl(agencyUser.logoUrl), 86400);
      } catch {
        logoDisplayUrl = agencyUser.logoUrl;
      }
    }
    if (coverImageUrl && isS3Url(coverImageUrl)) {
      try {
        coverDisplayUrl = await storageService.getSignedUrl(storageService.extractKeyFromUrl(coverImageUrl), 86400);
      } catch {
        coverDisplayUrl = coverImageUrl;
      }
    }

    res.json({
      success: true,
      data: {
        name: agencyUser.name,
        logoUrl: agencyUser.logoUrl,
        logoDisplayUrl,
        brandingConfig: branding,
        coverDisplayUrl
      }
    });
  } catch (error) {
    console.error('Get agency profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch agency profile'
    });
  }
}

/**
 * Upload agency logo or cover image to S3
 * Query: ?type=logo | ?type=cover
 * Body: multipart/form-data with field "file"
 */
export async function uploadAgencyAsset(
  req: AuthRequest,
  res: Response<ApiResponse<{ url: string; displayUrl: string }>>
): Promise<void> {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const agencyUser = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    if (!agencyUser || (agencyUser.accountType !== 'BASIC_AGENCY' && agencyUser.accountType !== 'MAX_AGENCY')) {
      res.status(403).json({ success: false, error: 'Only agencies can upload branding assets' });
      return;
    }

    const type = (req.query.type as string)?.toLowerCase();
    if (type !== 'logo' && type !== 'cover') {
      res.status(400).json({ success: false, error: 'Query param type must be "logo" or "cover"' });
      return;
    }

    const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' });
      return;
    }
    if (!file.mimetype.startsWith('image/')) {
      res.status(400).json({ success: false, error: 'Only image files are allowed (e.g. PNG, JPG, WebP).' });
      return;
    }

    const folder = `agency/${userId}/${type}`;
    const url = await storageService.uploadFile(file, folder);
    const key = storageService.extractKeyFromUrl(url);
    const displayUrl = await storageService.getSignedUrl(key, 86400); // 24h for preview

    res.json({
      success: true,
      data: { url, displayUrl }
    });
  } catch (error) {
    console.error('Upload agency asset error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload file'
    });
  }
}

/**
 * Get agency branding (public endpoint for login pages)
 * This is a public endpoint - no authentication required
 */
export async function getAgencyBranding(
  req: Request,
  res: Response<ApiResponse<{
    name: string | null;
    logoUrl: string | null;
    logoDisplayUrl?: string | null;
    brandingConfig: Record<string, unknown> | null;
    coverDisplayUrl?: string | null;
  }>>
): Promise<void> {
  try {
    const { agencyId } = req.params;

    if (!agencyId) {
      res.status(400).json({
        success: false,
        error: 'Agency ID is required'
      });
      return;
    }

    // Fetch agency user
    const agencyUser = await db.query.users.findFirst({
      where: eq(users.id, agencyId)
    });

    if (!agencyUser || (agencyUser.accountType !== 'BASIC_AGENCY' && agencyUser.accountType !== 'MAX_AGENCY')) {
      res.status(404).json({
        success: false,
        error: 'Agency not found'
      });
      return;
    }

    // Get branding with signed URLs for S3 assets
    const branding = agencyUser.brandingConfig as Record<string, unknown> | null;
    const coverImageUrl = branding?.coverImageUrl as string | null | undefined;
    let logoDisplayUrl: string | null = agencyUser.logoUrl;
    let coverDisplayUrl: string | null = coverImageUrl ?? null;

    // Generate signed URLs for S3 assets so they can be displayed
    if (agencyUser.logoUrl && isS3Url(agencyUser.logoUrl)) {
      try {
        logoDisplayUrl = await storageService.getSignedUrl(
          storageService.extractKeyFromUrl(agencyUser.logoUrl),
          86400 // 24 hours
        );
      } catch {
        logoDisplayUrl = agencyUser.logoUrl;
      }
    }
    if (coverImageUrl && isS3Url(coverImageUrl)) {
      try {
        coverDisplayUrl = await storageService.getSignedUrl(
          storageService.extractKeyFromUrl(coverImageUrl),
          86400 // 24 hours
        );
      } catch {
        coverDisplayUrl = coverImageUrl;
      }
    }

    res.json({
      success: true,
      data: {
        name: agencyUser.name,
        logoUrl: agencyUser.logoUrl,
        logoDisplayUrl,
        brandingConfig: branding,
        coverDisplayUrl
      }
    });
  } catch (error) {
    console.error('Get agency branding error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch agency branding'
    });
  }
}
