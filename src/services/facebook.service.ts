import axios, { AxiosResponse } from 'axios';
import {
  FacebookPage,
  FacebookTokenExchangeResponse,
  FacebookLongLivedTokenResponse,
  FacebookPagesResponse,
  FacebookUserResponse,
  FacebookApiError,
  FacebookPost,
  FacebookPostsResponse,
  FacebookComment,
  FacebookCommentsResponse,
  FacebookDeleteCommentResponse,
  FacebookHideCommentResponse
} from '../types';

/**
 * Facebook OAuth redirect URI must match Meta App configuration exactly.
 * If FACEBOOK_REDIRECT_URI is not set, it is built from API_URL (e.g. https://localhost:8080/api/facebook/oauth/callback).
 * In Meta for Developers → Your App → App Settings → Basic:
 *   - App Domains: add "localhost" (and your production domain when deployed).
 * In Facebook Login → Settings:
 *   - Valid OAuth Redirect URIs: add the exact redirect URL (e.g. https://localhost:8080/api/facebook/oauth/callback).
 */
function getFacebookRedirectUri(): string {
  const explicit = process.env.FACEBOOK_REDIRECT_URI;
  if (explicit) return explicit;
  const base = process.env.API_URL || process.env.BACKEND_URL || 'http://localhost:8080';
  return base.replace(/\/$/, '') + '/api/facebook/oauth/callback';
}

export class FacebookService {
  private readonly baseUrl = 'https://graph.facebook.com/v21.0';
  private readonly appId = process.env.FACEBOOK_APP_ID!;
  private readonly appSecret = process.env.FACEBOOK_APP_SECRET!;
  private readonly redirectUri = getFacebookRedirectUri();

  /**
   * Generate Facebook OAuth authorization URL
   * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      state,
      scope: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_read_user_content', // Read Page posts & comments (getPagePublishedPosts, getPostComments). Also required when using instagram_basic via Facebook Login.
        'pages_manage_metadata',
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_manage_insights', // Valid scope (instagram_business_manage_insights is invalid)
        'business_management'
      ].join(','),
      response_type: 'code'
    });

    return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for short-lived user access token
   * https://developers.facebook.com/docs/facebook-login/guides/access-tokens
   */
  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    userId: string;
  }> {
    try {
      const params = new URLSearchParams({
        client_id: this.appId,
        client_secret: this.appSecret,
        redirect_uri: this.redirectUri,
        code
      });

      const response = await axios.get<FacebookTokenExchangeResponse>(
        `${this.baseUrl}/oauth/access_token`,
        { params }
      );

      const accessToken = response.data.access_token;

      // Get user ID from the token
      const userResponse = await axios.get<FacebookUserResponse>(
        `${this.baseUrl}/me`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,email'
          }
        }
      );

      return {
        accessToken,
        userId: userResponse.data.id
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Facebook OAuth error: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Exchange short-lived user token for long-lived token (60 days)
   * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
   */
  async getLongLivedUserToken(shortLivedToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    try {
      const params = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortLivedToken
      });

      const response = await axios.get<FacebookLongLivedTokenResponse>(
        `${this.baseUrl}/oauth/access_token`,
        { params }
      );

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Token exchange error: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Get list of Facebook Pages the user manages
   * https://developers.facebook.com/docs/graph-api/reference/user/accounts
   */
  async getUserPages(userAccessToken: string): Promise<FacebookPage[]> {
    try {
      const response = await axios.get<FacebookPagesResponse>(
        `${this.baseUrl}/me/accounts`,
        {
          params: {
            access_token: userAccessToken,
            fields: 'id,name,access_token,category,category_list,picture,instagram_business_account{id,username}'
          }
        }
      );

      return response.data.data || [];
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Failed to get Pages: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Get Page access token (automatically long-lived if user token is long-lived)
   * This is already returned by getUserPages, but this method can be used standalone
   */
  async getPageAccessToken(pageId: string, userAccessToken: string): Promise<string> {
    try {
      const response = await axios.get<{ access_token: string }>(
        `${this.baseUrl}/${pageId}`,
        {
          params: {
            fields: 'access_token',
            access_token: userAccessToken
          }
        }
      );

      return response.data.access_token;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Failed to get Page token: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Verify user is a Page admin
   * https://developers.facebook.com/docs/graph-api/reference/page/
   */
  async verifyPageAdmin(pageId: string, userAccessToken: string): Promise<boolean> {
    try {
      const pages = await this.getUserPages(userAccessToken);
      return pages.some(page => page.id === pageId);
    } catch (error: unknown) {
      console.error('Page admin verification error:', error);
      return false;
    }
  }

  /**
   * Get Facebook Page info including follower count
   * https://developers.facebook.com/docs/graph-api/reference/page/
   */
  async getPageInfo(
    pageId: string,
    pageAccessToken: string
  ): Promise<{
    id: string;
    name: string;
    followers_count?: number;
    fan_count?: number;
  }> {
    try {
      const response = await axios.get<{
        id: string;
        name: string;
        followers_count?: number;
        fan_count?: number;
      }>(
        `${this.baseUrl}/${pageId}`,
        {
          params: {
            fields: 'id,name,followers_count,fan_count',
            access_token: pageAccessToken
          }
        }
      );

      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Failed to get Page info: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Get Instagram Business Account connected to a Page
   * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/get-started
   */
  async getInstagramBusinessAccount(
    pageId: string,
    pageAccessToken: string
  ): Promise<{
    id: string;
    username: string;
    name?: string;
    profile_picture_url?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
  } | null> {
    try {
      const response = await axios.get<{
        instagram_business_account?: {
          id: string;
          username: string;
          name?: string;
          profile_picture_url?: string;
          followers_count?: number;
          follows_count?: number;
          media_count?: number;
        };
      }>(
        `${this.baseUrl}/${pageId}`,
        {
          params: {
            fields: 'instagram_business_account{id,username,name,profile_picture_url,followers_count,follows_count,media_count}',
            access_token: pageAccessToken
          }
        }
      );

      return response.data.instagram_business_account || null;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        console.error('Failed to get Instagram account:', errorData.error?.message);
      }
      return null;
    }
  }

  /**
   * Get detailed Instagram account information
   * Note: account_type is not available via Graph API, but if account is accessible via Page,
   * it must be a Business or Creator account (Personal accounts can't connect to Pages)
   */
  async getInstagramAccountDetails(
    instagramAccountId: string,
    pageAccessToken: string
  ): Promise<{
    id: string;
    username: string;
    name?: string;
    account_type?: 'BUSINESS' | 'CREATOR' | 'PERSONAL';
    profile_picture_url?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    biography?: string;
  } | null> {
    try {
      // Note: account_type field is not available on IGUser node via Graph API
      // If account is accessible via Page token, it must be Business or Creator
      const response = await axios.get(
        `${this.baseUrl}/${instagramAccountId}`,
        {
          params: {
            fields: 'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography',
            access_token: pageAccessToken
          }
        }
      );

      // Since account is accessible via Page, it must be Business or Creator
      // Default to BUSINESS if we can't determine
      return {
        ...response.data,
        account_type: 'BUSINESS' as const // Personal accounts can't connect to Pages
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        console.error('Failed to get Instagram account details:', errorData.error?.message);
      }
      return null;
    }
  }

  /**
   * Verify Page has required permissions for moderation (Instagram OR Facebook)
   */
  async verifyPagePermissions(pageId: string, pageAccessToken: string): Promise<{
    hasInstagram: boolean;
    hasCommentPermissions: boolean;
    instagramAccountId?: string;
    errors: string[];
  }> {
    const errors: string[] = [];
    let hasInstagram = false;
    let hasCommentPermissions = false;
    let instagramAccountId: string | undefined;

    try {
      // Check if Page has Instagram account connected
      const igAccount = await this.getInstagramBusinessAccount(pageId, pageAccessToken);
      
      if (igAccount) {
        hasInstagram = true;
        instagramAccountId = igAccount.id;

        // Test Instagram comment access by trying to get media
        try {
          const testResponse = await axios.get(
            `${this.baseUrl}/${igAccount.id}/media`,
            {
              params: {
                fields: 'id',
                limit: 1,
                access_token: pageAccessToken
              },
              validateStatus: () => true
            }
          );

          if (testResponse.status === 200) {
            hasCommentPermissions = true;
          } else if (testResponse.data.error) {
            errors.push(`Instagram permission error: ${testResponse.data.error.message}`);
          }
        } catch (testError: unknown) {
          errors.push('Failed to verify Instagram comment permissions');
        }
      } else {
        // No Instagram account, but we can still check Facebook Page permissions
        // Test access to Page posts
        try {
          const testResponse = await axios.get(
            `${this.baseUrl}/${pageId}/published_posts`,
            {
              params: {
                limit: 1,
                access_token: pageAccessToken
              },
              validateStatus: () => true
            }
          );

          if (testResponse.status === 200) {
            hasCommentPermissions = true;
          } else if (testResponse.data.error) {
            errors.push(`Facebook Page permission error: ${testResponse.data.error.message}`);
          }
        } catch (testError: unknown) {
          errors.push('Failed to verify Facebook Page permissions');
        }
      }

      return {
        hasInstagram,
        hasCommentPermissions,
        instagramAccountId,
        errors
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        errors.push(errorData.error?.message || 'Unknown verification error');
      } else if (error instanceof Error) {
        errors.push(error.message);
      }

      return {
        hasInstagram,
        hasCommentPermissions,
        instagramAccountId,
        errors
      };
    }
  }

  /**
   * Refresh Page access token
   * Note: Page tokens don't expire if generated from a long-lived user token
   * This is here for completeness but may not be needed
   */
  async refreshPageToken(pageId: string, userAccessToken: string): Promise<string> {
    return this.getPageAccessToken(pageId, userAccessToken);
  }

  /**
   * Debug token to check expiration and permissions
   */
  async debugToken(accessToken: string): Promise<{
    isValid: boolean;
    expiresAt?: Date;
    scopes?: string[];
    error?: string;
  }> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/debug_token`,
        {
          params: {
            input_token: accessToken,
            access_token: `${this.appId}|${this.appSecret}`
          }
        }
      );

      const data = response.data.data;

      return {
        isValid: data.is_valid || false,
        expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : undefined,
        scopes: data.scopes || []
      };
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        return {
          isValid: false,
          error: errorData.error?.message || 'Token validation failed'
        };
      }
      return {
        isValid: false,
        error: 'Unknown error during token validation'
      };
    }
  }

  /**
   * Get published posts from a Facebook Page
   * https://developers.facebook.com/docs/graph-api/reference/page/published_posts/
   */
  async getPagePublishedPosts(
    pageId: string,
    pageAccessToken: string
  ): Promise<FacebookPost[]> {
    try {
      const allPosts: FacebookPost[] = [];
      let nextUrl: string | undefined = `${this.baseUrl}/${pageId}/published_posts`;
      
      while (nextUrl) {
        const response: AxiosResponse<FacebookPostsResponse> = await axios.get(
          nextUrl,
          {
            params: nextUrl === `${this.baseUrl}/${pageId}/published_posts` ? {
              access_token: pageAccessToken,
              fields: 'id,message,created_time,permalink_url,full_picture,likes.summary(true),comments.summary(true)',
              limit: 100
            } : undefined
          }
        );

        allPosts.push(...response.data.data);
        nextUrl = response.data.paging?.next;
      }

      console.log(`✅ Fetched ${allPosts.length} posts from Page ${pageId}`);
      return allPosts;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Failed to get Page posts: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Get comments for a Facebook post
   * https://developers.facebook.com/docs/graph-api/reference/post/comments/
   */
  async getPostComments(
    postId: string,
    pageAccessToken: string
  ): Promise<FacebookComment[]> {
    try {
      const allComments: FacebookComment[] = [];
      let nextUrl: string | undefined = `${this.baseUrl}/${postId}/comments`;

      while (nextUrl) {
        const response: AxiosResponse<FacebookCommentsResponse> = await axios.get(
          nextUrl,
          {
            params: nextUrl === `${this.baseUrl}/${postId}/comments` ? {
              access_token: pageAccessToken,
              fields: 'id,message,from,created_time,parent,can_comment,can_remove,can_hide,is_hidden',
              filter: 'stream', // Get all comments including replies
              limit: 100
            } : undefined
          }
        );

        allComments.push(...response.data.data);
        nextUrl = response.data.paging?.next;
      }

      console.log(`✅ Fetched ${allComments.length} comments for post ${postId}`);
      return allComments;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        throw new Error(`Failed to get post comments: ${errorData.error?.message || 'Unknown error'}`);
      }
      throw error;
    }
  }

  /**
   * Delete a comment from a Facebook post
   * https://developers.facebook.com/docs/graph-api/reference/comment/
   */
  async deleteComment(
    commentId: string,
    pageAccessToken: string
  ): Promise<boolean> {
    try {
      const response = await axios.delete<FacebookDeleteCommentResponse>(
        `${this.baseUrl}/${commentId}`,
        {
          params: {
            access_token: pageAccessToken
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        console.error(`Failed to delete Facebook comment ${commentId}:`, errorData.error?.message);
      }
      return false;
    }
  }

  /**
   * Hide a comment on a Facebook post
   * Note: This updates the is_hidden field; the comment is still visible to the commenter
   * https://developers.facebook.com/docs/graph-api/reference/comment/
   */
  async hideComment(
    commentId: string,
    pageAccessToken: string,
    hide: boolean = true
  ): Promise<boolean> {
    try {
      const response = await axios.post<FacebookHideCommentResponse>(
        `${this.baseUrl}/${commentId}`,
        null,
        {
          params: {
            access_token: pageAccessToken,
            is_hidden: hide
          }
        }
      );

      return response.data.success ?? false;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.data) {
        const errorData = error.response.data as FacebookApiError;
        console.error(`Failed to hide Facebook comment ${commentId}:`, errorData.error?.message);
      }
      return false;
    }
  }
}

export const facebookService = new FacebookService();
