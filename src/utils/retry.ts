/**
 * Retry utility with exponential backoff for handling transient network failures
 */

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EADDRNOTAVAIL',
    'EAI_AGAIN', // DNS lookup timeout
  ],
};

function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as { code?: string; message?: string; syscall?: string };

  // Check error code
  if (err.code && retryableErrors.includes(err.code)) {
    return true;
  }

  // Check for DNS errors in message
  if (err.message) {
    const lowerMessage: string = err.message.toLowerCase();
    if (
      lowerMessage.includes('enotfound') ||
      lowerMessage.includes('getaddrinfo') ||
      lowerMessage.includes('etimedout') ||
      lowerMessage.includes('network')
    ) {
      return true;
    }
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the function call
 * @throws The last error if all retries fail
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Don't retry if this is the last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(error, opts.retryableErrors || [])) {
        // Non-retryable error, throw immediately
        throw error;
      }

      // Calculate delay with exponential backoff
      const delayMs: number = Math.min(
        opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt),
        opts.maxDelayMs,
      );

      console.warn(
        `⚠️  Network error (attempt ${attempt + 1}/${opts.maxRetries + 1}): ${
          error instanceof Error ? error.message : String(error)
        }. Retrying in ${delayMs}ms...`,
      );

      await delay(delayMs);
    }
  }

  // All retries failed, throw the last error
  throw lastError;
}

/**
 * Wrapper for axios requests with automatic retry
 * @param requestFn - Function that makes the axios request
 * @param options - Retry options
 */
export async function retryAxiosRequest<T>(
  requestFn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  return retryWithBackoff(requestFn, {
    ...options,
    retryableErrors: [
      ...(DEFAULT_OPTIONS.retryableErrors || []),
      'ECONNABORTED', // Request timeout
      ...(options.retryableErrors || []),
    ],
  });
}
