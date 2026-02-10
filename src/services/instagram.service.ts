import axios from 'axios';
import * as crypto from 'crypto';
import { retryAxiosRequest } from '../utils/retry';
import {
  InstagramAccount,
  InstagramMedia,
  InstagramComment,
  InstagramTokenRefreshResponse,
  InstagramMediaResponse,
  InstagramCommentResponse,
  InstagramWebhookSubscriptionResponse,
  InstagramWebhookSubscriptionsResponse,
  InstagramWebhookSubscriptionResult,
  InstagramWebhookSubscriptionStatus,
  InstagramTestResult,
  InstagramDeleteCommentResponse,
  InstagramHideCommentResponse,
  InstagramBlockUserResponse,
  InstagramRestrictUserResponse,
  InstagramReportCommentResponse,
  InstagramApproveCommentResponse,
  InstagramApiError
} from '../types';

export class InstagramService {
  // Use Instagram Business Login (direct Instagram OAuth)
  // Using v24.0 API version (latest stable)
  private readonly baseUrl = 'https://graph.facebook.com/v24.0';

  /**
   * Exchange authorization code for access token
   * @deprecated Use FacebookService instead - OAuth now handled via Facebook Login
   */

  /**
   * Get Instagram account info (validate Business/Creator account)
   * Uses Instagram Business Account ID endpoint (works with Page Access Tokens from Facebook Login)
   */
  async getAccountInfo(userId: string, accessToken: string): Promise<InstagramAccount> {
    try {
      // Use Instagram Business Account ID endpoint (works with Page Access Tokens)
      // /me endpoint only works with User Access Tokens, not Page Access Tokens
      const accountUrl = `${this.baseUrl}/${userId}`;
      
      // Try to get all available fields - some might not be available depending on permissions
      // Note: account_type field removed as it's not reliably available on IGUser nodes
      const response = await axios.get<InstagramAccount | InstagramApiError>(
        accountUrl,
        {
          params: {
            fields: 'id,username,name,followers_count,follows_count,profile_picture_url,media_count,biography',
            access_token: accessToken
          },
          validateStatus: () => true // Don't throw on error status
        }
      );

      
      // Check for error in response
      if ('error' in response.data) {
        const errorData = response.data as InstagramApiError;
        
        // Log the error for debugging
        console.error('Instagram API error in getAccountInfo:', errorData.error);
        
        // Try with minimal fields if full request failed
        const basicResponse = await axios.get<InstagramAccount | InstagramApiError>(
          accountUrl,
          {
            params: {
              fields: 'id,username',
              access_token: accessToken
            },
            validateStatus: () => true
          }
        );
        
        if ('error' in basicResponse.data) {
          const basicError = basicResponse.data as InstagramApiError;
          throw new Error(`Instagram API error: ${basicError.error.message} (Code: ${basicError.error.code})`);
        }
        
        return basicResponse.data as InstagramAccount;
      }
      
      const accountData = response.data as InstagramAccount;

      // Note: If this API call succeeds, the account is already a Business or Creator account
      // Personal accounts cannot access Instagram Business API endpoints
      // Therefore, no explicit account_type validation is needed

      return accountData;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to fetch Instagram account info');
    }
  }

  /**
   * Get media/posts from Instagram account
   */
  async getMedia(userId: string, accessToken: string, limit: number = 25): Promise<InstagramMedia[]> {
    try {
      const url = `${this.baseUrl}/${userId}/media`;
      const response = await retryAxiosRequest(
        () => axios.get<InstagramMediaResponse>(
          url,
          {
            params: {
              fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
              access_token: accessToken,
              limit
            },
            timeout: 15000,
          }
        ),
        {
          maxRetries: 2,
          initialDelayMs: 1000,
        }
      );

      return response.data.data || [];
    } catch (error: unknown) {
      throw error;
    }
  }

  /**
   * Get only Instagram Comment IDs for a post (simplified version)
   * Returns just an array of comment IDs without fetching full comment data
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_manage_comments (to read comments)
   */
  async getCommentIds(mediaId: string, accessToken: string): Promise<string[]> {
    try {
      const commentIds: string[] = [];
      let nextUrl: string | undefined = `${this.baseUrl}/${mediaId}/comments`;
      let pageNumber = 1;
      
      while (nextUrl) {
        console.log(`Page ${pageNumber} for post ${mediaId}: ${nextUrl}`);
        
        const urlObj: URL = new URL(nextUrl);
        const params = new URLSearchParams(urlObj.search);
        
        // Request both id and legacy_instagram_comment_id (v24.0)
        // Try legacy_instagram_comment_id first, fallback to id
        if (!params.has('fields')) {
          params.set('fields', 'id,legacy_instagram_comment_id');
        }
        if (!params.has('access_token')) {
          params.set('access_token', accessToken);
        }
        
        const requestUrl: string = `${urlObj.origin}${urlObj.pathname}`;
        const response = await axios.get<InstagramCommentResponse>(
          requestUrl,
          {
            params: Object.fromEntries(params),
            validateStatus: () => true
          }
        );
        
        // Check for API errors
        if (response.data.error) {
          const error = response.data.error;
          
          if (error.code === 190 || error.message?.toLowerCase().includes('invalid') || error.message?.toLowerCase().includes('parse access token')) {
            throw new Error(`Invalid or expired access token (OAuthException ${error.code}): ${error.message}`);
          }
          
          if (error.code === 200 || error.message?.toLowerCase().includes('permission')) {
            throw new Error('Permission denied: instagram_manage_comments permission required');
          }
          
          throw new Error(`Instagram API error: ${error.message}`);
        }
        
        const rawData = response.data.data || [];
        const pageCommentIds = rawData.map((comment: InstagramComment) => {
          const commentWithLegacy = comment as InstagramComment & { legacy_instagram_comment_id?: string };
          const legacyId = commentWithLegacy.legacy_instagram_comment_id;
          const regularId = comment.id;
          // Try legacy first, fallback to regular id
          return legacyId || regularId;
        });
        
        console.log(`Page ${pageNumber}: Found ${pageCommentIds.length} comment IDs (total so far: ${commentIds.length + pageCommentIds.length})`);
        
        // Add comment IDs if we have any
        if (pageCommentIds.length > 0) {
          commentIds.push(...pageCommentIds);
        }
        
        // ALWAYS follow pagination if next URL exists - don't stop early
        if (response.data.paging?.next) {
          nextUrl = response.data.paging.next;
          pageNumber++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          // No more pages
          console.log(`Page ${pageNumber}: No more pages (reached end)`);
          nextUrl = undefined;
        }
      }
      
      console.log(`Post ${mediaId}: ${commentIds.join(', ')}`);
      return commentIds;
    } catch (error: unknown) {
      return [];
    }
  }

  /**
   * Get replies for a specific comment
   * Instagram API endpoint: /{comment-id}/replies
   * Handles pagination to fetch ALL replies
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_manage_comments (to READ reply content)
   */
  async getReplies(commentId: string, accessToken: string, parentCommentId: string): Promise<InstagramComment[]> {
    try {
      const allReplies: InstagramComment[] = [];
      let nextUrl: string | undefined = `${this.baseUrl}/${commentId}/replies`;
      
      while (nextUrl) {
        const urlObj: URL = new URL(nextUrl);
        const params: URLSearchParams = new URLSearchParams(urlObj.search);
        
        if (!params.has('fields')) {
          params.set('fields', 'id,legacy_instagram_comment_id,text,timestamp,username,like_count,hidden,from,parent_id,media');
        }
        if (!params.has('access_token')) {
          params.set('access_token', accessToken);
        }
        
        const requestUrl: string = `${urlObj.origin}${urlObj.pathname}`;
        const response = await axios.get<InstagramCommentResponse>(
          requestUrl,
          {
            params: Object.fromEntries(params),
            validateStatus: () => true
          }
        );

        // Check for API errors
        if (response.data.error) {
          const error = response.data.error;
          if (error.code === 200 || error.message?.toLowerCase().includes('permission')) {
            break; // No replies or permission issue
          }
          break; // Other errors - return what we have
        }
        
        const pageReplies = (response.data.data || []).map((reply: InstagramComment) => ({
          ...reply,
          parentCommentId: reply.parent_id || parentCommentId
        }));
        allReplies.push(...pageReplies);
        
        // Check for next page
        if (response.data.paging?.next) {
          nextUrl = response.data.paging.next;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          nextUrl = undefined;
        }
      }
      
      return allReplies;
    } catch (error: unknown) {
      // Return empty array on error (replies are optional)
      return [];
    }
  }

  /**
   * Validate and refresh access token if needed
   * Returns the valid access token (refreshed if necessary)
   */
  async ensureValidToken(accessToken: string): Promise<string> {
    try {
      // Try to refresh the token (Instagram long-lived tokens can be refreshed)
      // If token is invalid, refresh will fail and we'll know
      const refreshed = await this.refreshAccessToken(accessToken);
      return refreshed.accessToken;
    } catch (error: unknown) {
      // If refresh fails, the token might be invalid or expired
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as { error?: { message?: string; code?: number } };
        if (errorData.error?.code === 190 || errorData.error?.message?.toLowerCase().includes('invalid') || errorData.error?.message?.toLowerCase().includes('expired')) {
          throw new Error(`Invalid or expired access token: ${errorData.error.message}. Please reconnect your Instagram account.`);
        }
      }
      // If it's not a token error, return original token (might still be valid)
      return accessToken;
    }
  }

  /**
   * Get comments for a specific media/post INCLUDING ALL REPLIES
   * NOTE: This method is kept for backwards compatibility and testing only.
   * In production, comments should arrive via webhooks for real-time moderation.
   * 
   * Works for both BUSINESS and CREATOR account types using Instagram Business Login API
   * 
   * IMPORTANT: 
   * - Handles pagination to fetch ALL top-level comments
   * - Fetches ALL replies for each top-level comment (with pagination)
   * - Returns flat array with parentCommentId set for replies
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_manage_comments (to READ comment content)
   */
  async getComments(mediaId: string, accessToken: string): Promise<InstagramComment[]> {
    try {
      const allComments: InstagramComment[] = [];
      let nextUrl: string | undefined = `${this.baseUrl}/${mediaId}/comments`;
      let pageNumber = 1;
      
      // Follow pagination until all comments are retrieved
      while (nextUrl) {
        console.log(`Page ${pageNumber} for post ${mediaId}: ${nextUrl}`);
        
        // Extract URL and params
        const urlObj: URL = new URL(nextUrl);
        const params = new URLSearchParams(urlObj.search);
        
        // Add fields and access token if not already in URL
        // Include legacy_instagram_comment_id for v24.0 compatibility
        if (!params.has('fields')) {
          params.set('fields', 'id,legacy_instagram_comment_id,text,timestamp,username,like_count,hidden,from,parent_id');
        }
        if (!params.has('filter')) {
          params.set('filter', 'stream');
        }
        if (!params.has('access_token')) {
          params.set('access_token', accessToken);
        }

        const requestUrl: string = `${urlObj.origin}${urlObj.pathname}`;
        const response = await retryAxiosRequest(
          () => axios.get<InstagramCommentResponse>(
            requestUrl,
            {
              params: Object.fromEntries(params),
              validateStatus: () => true,
              timeout: 15000, // 15 second timeout per request
            }
          ),
          {
            maxRetries: 2,
            initialDelayMs: 1000,
          }
        );
        
        // Check for API errors
        if (response.data.error) {
          const error = response.data.error;
          
          // Token-specific errors (most common cause of empty comments)
          if (error.code === 190 || error.message?.toLowerCase().includes('invalid') || error.message?.toLowerCase().includes('parse access token')) {
            throw new Error(
              `Invalid or expired access token (OAuthException ${error.code}): ${error.message}. ` +
              'SOLUTION: Reconnect your Instagram account to get a fresh access token.'
            );
          }
          
          // Permission-specific errors
          if (error.code === 200 || error.message?.toLowerCase().includes('permission')) {
            throw new Error(
              'Permission denied: instagram_business_manage_comments permission required to READ comments (Instagram Login). ' +
              'Ensure: 1) Account is Business/Creator type, 2) Permission approved in Meta App Dashboard, 3) Account reconnected after approval.'
            );
          }
          
          throw new Error(`Instagram API error: ${error.message}`);
        }
        
        const pageComments = (response.data.data || []).map((comment: InstagramComment) => ({
          ...comment,
          parentCommentId: comment.parent_id || undefined
        }));
        
        console.log(`Page ${pageNumber}: Found ${pageComments.length} comments (total so far: ${allComments.length + pageComments.length})`);
        
        // Add comments if we have any
        if (pageComments.length > 0) {
          allComments.push(...pageComments);
        }
        
        // Check for next page - ALWAYS follow pagination if next URL exists
        if (response.data.paging?.next) {
          nextUrl = response.data.paging.next;
          pageNumber++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          // No more pages
          console.log(`Page ${pageNumber}: No more pages (reached end)`);
          nextUrl = undefined;
        }
      }
      
      // Fetch replies for each top-level comment
      let totalReplies = 0;
      for (const comment of allComments) {
        const replies = await this.getReplies(comment.id, accessToken, comment.id);
        allComments.push(...replies);
        totalReplies += replies.length;
        if (replies.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      const commentIds = allComments.map(c => {
        const commentWithLegacy = c as InstagramComment & { legacy_instagram_comment_id?: string };
        return commentWithLegacy.legacy_instagram_comment_id || c.id;
      });
      
      console.log(`Post ${mediaId}: ${commentIds.join(', ')}`);

      return allComments;
    } catch (error: unknown) {
      // Log the error with full details so we can diagnose issues
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [Instagram] Failed to fetch comments for post ${mediaId}:`, errorMessage);

      // Log the full error object for debugging
      if (error instanceof Error && error.stack) {
        console.error('Stack trace:', error.stack);
      }

      // Return empty array to allow sync to continue with other posts
      // But now we have visibility into what went wrong
      return [];
    }
  }

  /**
   * Subscribe to Instagram webhooks for real-time comment notifications
   * This should be called after an account is connected
   * 
   * Requires Advanced Access for:
   * - instagram_manage_comments (to receive comment webhooks)
   * - instagram_business_manage_comments (to act on comments)
   * - instagram_business_basic
   */
  async subscribeToWebhooks(userId: string, accessToken: string): Promise<InstagramWebhookSubscriptionResult> {
    try {
      const url = `${this.baseUrl}/${userId}/subscribed_apps`;
      
      // Subscribe to comment and message events
      const response = await axios.post<InstagramWebhookSubscriptionResponse>(
        url,
        null,
        {
          params: {
            subscribed_fields: 'comments,messages,messaging_postbacks',
            access_token: accessToken
          },
          validateStatus: () => true
        }
      );

      if (response.status === 200 && response.data.success) {
        return {
          success: true,
          subscribedFields: ['comments', 'messages', 'messaging_postbacks']
        };
      } else {
        return {
          success: false,
          error: 'Failed to subscribe to webhooks. Ensure app has Advanced Access for instagram_manage_comments and instagram_business_manage_comments.'
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as InstagramWebhookSubscriptionResponse;
        return {
          success: false,
          error: errorData.error?.message || 'Unknown error subscribing to webhooks'
        };
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Check current webhook subscription status
   */
  async getWebhookSubscriptions(userId: string, accessToken: string): Promise<InstagramWebhookSubscriptionStatus> {
    try {
      const url = `${this.baseUrl}/${userId}/subscribed_apps`;
      
      const response = await axios.get<InstagramWebhookSubscriptionsResponse>(url, {
        params: {
          access_token: accessToken
        },
        validateStatus: () => true
      });
      
      if (response.status === 200 && response.data.data && response.data.data.length > 0) {
        const subscription = response.data.data[0];
        
        return {
          isSubscribed: true,
          subscribedFields: subscription.subscribed_fields
        };
      }

      return {
        isSubscribed: false,
        subscribedFields: []
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        isSubscribed: false,
        subscribedFields: [],
        error: errorMessage
      };
    }
  }

  /**
   * Unsubscribe from webhooks (for disconnecting accounts)
   */
  async unsubscribeFromWebhooks(userId: string, accessToken: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/${userId}/subscribed_apps`;
      
      await axios.delete(url, {
        params: {
          access_token: accessToken
        }
      });

      return true;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Test Instagram API access and permissions (for diagnostics)
   * Validates account type first, then tests comment access
   */
  async testCommentsMultipleApproaches(
    mediaId: string,
    accessToken: string,
    userId: string
  ): Promise<InstagramTestResult[]> {
    const results = [];

    // Step 1: Verify account type (Business or Creator required)
    try {
      const accountInfo = await this.getAccountInfo(userId, accessToken);
      
      results.push({
        approach: 'Account Verification',
        success: true,
        response: {
          accountType: accountInfo.account_type || 'BUSINESS/CREATOR',
          username: accountInfo.username,
          message: `Account verified - eligible for comment access (Business/Creator account)`
        }
      });

      // Note: If getAccountInfo() succeeds, the account is already Business/Creator
      // Personal accounts cannot access Instagram Business API endpoints
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        approach: 'Account Verification',
        success: false,
        error: errorMessage
      });
      return results;
    }

    // Step 2: Test standard comments endpoint (works for both Business & Creator)
    // Note: This test uses getComments() which now handles pagination automatically
    try {
      const allComments = await this.getComments(mediaId, accessToken);
      
      results.push({
        approach: 'Comments API (Full Fields + Pagination)',
        success: true,
        commentCount: allComments.length,
        response: {
          commentCount: allComments.length,
          sampleComment: allComments[0] || null,
          note: 'Uses getComments() which handles pagination automatically'
        }
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        approach: 'Comments API (Full Fields + Pagination)',
        success: false,
        error: errorMessage
      });
    }

    // Step 3: Get comment count from media endpoint (doesn't require manage_comments permission)
    try {
      const url = `${this.baseUrl}/${mediaId}`;
      const response = await axios.get(url, {
        params: {
          fields: 'id,comments_count,caption',
          access_token: accessToken
        },
        validateStatus: () => true
      });
      
      results.push({
        approach: 'Media Metadata (Comments Count)',
        success: !response.data.error && response.status === 200,
        commentCount: response.data.comments_count,
        error: response.data.error?.message,
        response: response.data
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        approach: 'Media Metadata (Comments Count)',
        success: false,
        error: errorMessage
      });
    }

    return results;
  }

  /**
   * Delete a comment from Instagram (PERMANENT DELETION)
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_business_manage_comments (to ACT on comments - delete)
   */
  async deleteComment(commentId: string, accessToken: string): Promise<boolean> {
    const igCommentId = (commentId || '').trim();
    if (!igCommentId) {
      console.error('[Instagram] deleteComment called with empty comment ID');
      return false;
    }
    try {
      // DELETE must use the IG Comment ID only – never the media/post ID (that can remove all comments)
      const url = `${this.baseUrl}/${igCommentId}`;
      const response = await axios.delete<InstagramDeleteCommentResponse>(
        url,
        {
          params: {
            access_token: accessToken
          },
          validateStatus: (status) => status === 200 || status >= 400
        }
      );

      if (response.status !== 200) {
        const err = (response.data as { error?: { message?: string; code?: number } })?.error;
        console.error(`[Instagram] deleteComment failed for ID ${igCommentId}:`, err?.message || response.status);
        return false;
      }

      return response.data.success ?? false;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Instagram] deleteComment error for ID ${igCommentId}:`, msg);
      return false;
    }
  }

  /**
   * Hide a comment on Instagram (comment remains but is hidden from public view).
   * Uses Facebook Graph API comment moderation: POST /{COMMENT_ID} with body hide=true.
   * PERMISSIONS: instagram_manage_comments, pages_read_engagement, pages_manage_metadata (Facebook Login)
   *              or instagram_business_manage_comments (Instagram Login)
   * @see https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
   */
  async hideComment(commentId: string, accessToken: string): Promise<boolean> {
    const igCommentId = (commentId || '').trim();
    if (!igCommentId) {
      console.error('[Instagram] hideComment called with empty comment ID');
      return false;
    }
    try {
      const url = `${this.baseUrl}/${igCommentId}`;
      // Graph API expects form-encoded body: hide=true and access_token (per Meta docs)
      const body = new URLSearchParams({
        hide: 'true',
        access_token: accessToken
      });
      const response = await axios.post<InstagramHideCommentResponse>(
        url,
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: (status) => status === 200 || status >= 400
        }
      );
      if (response.status !== 200) {
        const err = (response.data as { error?: { message?: string } })?.error;
        console.error(`[Instagram] hideComment failed for ID ${igCommentId}:`, err?.message || response.status);
        return false;
      }
      return response.data.success ?? false;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Instagram] hideComment error for ID ${igCommentId}:`, msg);
      return false;
    }
  }

  /**
   * Unhide a comment on Instagram (make it visible again).
   * Uses Facebook Graph API: POST /{COMMENT_ID} with hide=false.
   * @see https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment
   */
  async unhideComment(commentId: string, accessToken: string): Promise<boolean> {
    const igCommentId = (commentId || '').trim();
    if (!igCommentId) {
      console.error('[Instagram] unhideComment called with empty comment ID');
      return false;
    }
    try {
      const url = `${this.baseUrl}/${igCommentId}`;
      const body = new URLSearchParams({
        hide: 'false',
        access_token: accessToken
      });
      const response = await axios.post<InstagramHideCommentResponse>(
        url,
        body,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: (status) => status === 200 || status >= 400
        }
      );
      if (response.status !== 200) {
        const err = (response.data as { error?: { message?: string } })?.error;
        console.error(`[Instagram] unhideComment failed for ID ${igCommentId}:`, err?.message || response.status);
        return false;
      }
      return response.data.success ?? false;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Instagram] unhideComment error for ID ${igCommentId}:`, msg);
      return false;
    }
  }

  /**
   * Block a user from commenting on your posts
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_business_manage_comments (to ACT on comments - block)
   */
  async blockUser(userId: string, accessToken: string): Promise<boolean> {
    try {
      const response = await axios.post<InstagramBlockUserResponse>(
        `${this.baseUrl}/${userId}/blocked_users`,
        {},
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Restrict a user (they can comment but only they can see their own comments)
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_business_manage_comments (to ACT on comments - restrict)
   */
  async restrictUser(userId: string, accessToken: string): Promise<boolean> {
    try {
      const response = await axios.post<InstagramRestrictUserResponse>(
        `${this.baseUrl}/${userId}/restricted_users`,
        {},
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Report a comment for violating Instagram's community guidelines
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_business_manage_comments (to ACT on comments - report)
   */
  async reportComment(commentId: string, accessToken: string): Promise<boolean> {
    try {
      const response = await axios.post<InstagramReportCommentResponse>(
        `${this.baseUrl}/${commentId}/reports`,
        {},
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Approve a comment (for business accounts with comment approval enabled)
   * 
   * PERMISSIONS REQUIRED:
   * - instagram_business_manage_comments (to ACT on comments - approve)
   */
  async approveComment(commentId: string, accessToken: string): Promise<boolean> {
    try {
      const response = await axios.post<InstagramApproveCommentResponse>(
        `${this.baseUrl}/${commentId}/approve`,
        {},
        {
          params: {
            access_token: accessToken
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Verify webhook signature (HMAC-SHA256)
   */
  verifyWebhookSignature(signature: string, body: string): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', process.env.INSTAGRAM_APP_SECRET!)
      .update(body)
      .digest('hex');

    return signature === `sha256=${expectedSignature}`;
  }

  /**
   * Get insights for a specific media/post
   * Requires: instagram_manage_insights permission
   * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
   *
   * IMPORTANT: From API v22.0+, 'impressions' is NO LONGER supported for media insights
   *
   * Valid metrics by media type (v22.0+):
   * - IMAGE: engagement, reach, saved
   * - VIDEO: engagement, reach, saved, video_views
   * - CAROUSEL: carousel_album_engagement, carousel_album_reach, carousel_album_saved
   *
   * Note:
   * - impressions is deprecated from v22.0+ (use reach instead)
   * - likes, comments, shares are NOT insights metrics (use media endpoint instead)
   */
  async getMediaInsights(
    mediaId: string,
    accessToken: string,
    metrics: string[] = ['engagement', 'reach', 'saved']
  ): Promise<Array<{ name: string; value: number; period?: string; end_time?: string }>> {
    try {
      const url = `${this.baseUrl}/${mediaId}/insights`;
      const response = await axios.get<{
        data: Array<{
          name: string;
          period: string;
          values: Array<{ value: number; end_time?: string }>;
        }>;
        error?: InstagramApiError['error'];
      }>(url, {
        params: {
          metric: metrics.join(','),
          access_token: accessToken
        },
        validateStatus: () => true
      });

      if (response.data.error) {
        const error = response.data.error;
        if (error.code === 200 || error.message?.toLowerCase().includes('permission')) {
          throw new Error('Permission denied: instagram_manage_insights permission required');
        }
        // Error 100 often means metric not available for this media type/account type
        if (error.code === 100 && error.message?.includes('metric')) {
          throw new Error(`Metric not available: ${error.message}. Try using metrics that match your account type (BUSINESS vs CREATOR) and media type (IMAGE vs VIDEO vs CAROUSEL).`);
        }
        throw new Error(`Instagram API error: ${error.message}`);
      }

      // Transform the response to a simpler format
      const insights: Array<{ name: string; value: number; period?: string; end_time?: string }> = [];
      if (response.data.data) {
        for (const metric of response.data.data) {
          // Get the latest value
          const latestValue = metric.values[metric.values.length - 1];
          if (latestValue) {
            insights.push({
              name: metric.name,
              value: latestValue.value,
              period: metric.period,
              end_time: latestValue.end_time
            });
          }
        }
      }

      return insights;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to fetch media insights');
    }
  }

  /**
   * Get account-level insights
   * Requires: instagram_manage_insights permission
   * https://developers.facebook.com/docs/instagram-platform/reference/ig-user/insights
   */
  async getAccountInsights(
    userId: string,
    accessToken: string,
    metrics: string[] = ['follower_count', 'email_contacts', 'phone_call_clicks', 'text_message_clicks', 'get_directions_clicks', 'website_clicks', 'profile_views'],
    period: 'day' | 'week' | 'days_28' = 'day'
  ): Promise<Array<{ name: string; value: number; period?: string; end_time?: string }>> {
    try {
      const url = `${this.baseUrl}/${userId}/insights`;
      const response = await axios.get<{
        data: Array<{
          name: string;
          period: string;
          values: Array<{ value: number; end_time?: string }>;
        }>;
        error?: InstagramApiError['error'];
      }>(url, {
        params: {
          metric: metrics.join(','),
          period,
          access_token: accessToken
        },
        validateStatus: () => true
      });

      if (response.data.error) {
        const error = response.data.error;
        if (error.code === 200 || error.message?.toLowerCase().includes('permission')) {
          throw new Error('Permission denied: instagram_manage_insights permission required');
        }
        throw new Error(`Instagram API error: ${error.message}`);
      }

      // Transform the response to a simpler format
      const insights: Array<{ name: string; value: number; period?: string; end_time?: string }> = [];
      if (response.data.data) {
        for (const metric of response.data.data) {
          // Get the latest value
          const latestValue = metric.values[metric.values.length - 1];
          if (latestValue) {
            insights.push({
              name: metric.name,
              value: latestValue.value,
              period: metric.period,
              end_time: latestValue.end_time
            });
          }
        }
      }

      return insights;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to fetch account insights');
    }
  }

  /**
   * Get OAuth authorization URL
   * @deprecated Use FacebookService.getAuthorizationUrl() instead - OAuth now handled via Facebook Login
   */
  
  /**
   * Refresh a long-lived access token (extends by another 60 days)
   * Token must be at least 24 hours old and still valid
   */
  async refreshAccessToken(accessToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const response = await axios.get<InstagramTokenRefreshResponse>(
      'https://graph.facebook.com/refresh_access_token',
      {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: accessToken
      }
    });

    return {
      accessToken: response.data.access_token,
      expiresIn: response.data.expires_in
    };
  }
}

export const instagramService = new InstagramService();
