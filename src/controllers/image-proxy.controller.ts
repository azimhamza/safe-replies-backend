import { Request, Response } from 'express';
import dns from 'dns/promises';

/**
 * Allowed domains for image proxy
 * Only Instagram and Facebook CDN domains
 */
const ALLOWED_DOMAINS = [
  'cdninstagram.com',
  'fbcdn.net',
  'scontent.cdninstagram.com',
  'scontent.fbcdn.net',
  'instagram.com',
  'facebook.com'
];

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(ip: string): boolean {
  const privateRanges = [
    /^10\./,                    // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./,              // 192.168.0.0/16
    /^127\./,                   // 127.0.0.0/8 (localhost)
    /^169\.254\./,              // 169.254.0.0/16 (link-local)
    /^0\.0\.0\.0$/,             // 0.0.0.0
    /^::1$/,                    // IPv6 localhost
    /^fe80:/,                   // IPv6 link-local
    /^fc00:/,                   // IPv6 unique local
    /^fd00:/                    // IPv6 unique local
  ];
  return privateRanges.some(regex => regex.test(ip));
}

/**
 * Proxy images from Instagram/Facebook CDN with strict SSRF protection
 * Only allows whitelisted domains, validates DNS, blocks redirects and private IPs
 */
export async function proxyImage(req: Request, res: Response): Promise<void> {
  try {
    const raw = req.query.url;
    const url = typeof raw === 'string' ? raw : null;

    if (!url) {
      res.status(400).json({ success: false, error: 'Invalid URL' });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      res.status(400).json({ success: false, error: 'Invalid URL format' });
      return;
    }

    // Only HTTPS allowed
    if (parsedUrl.protocol !== 'https:') {
      res.status(400).json({ success: false, error: 'Only HTTPS URLs allowed' });
      return;
    }

    // Whitelist domain check
    const hostname = parsedUrl.hostname.toLowerCase();
    const isAllowed = ALLOWED_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );

    if (!isAllowed) {
      console.warn(`[SSRF] Blocked non-whitelisted domain: ${hostname}`);
      res.status(400).json({ success: false, error: 'Domain not allowed' });
      return;
    }

    // DNS resolution check - prevent DNS rebinding attacks
    try {
      const addresses = await dns.resolve4(parsedUrl.hostname);
      for (const ip of addresses) {
        if (isPrivateIP(ip)) {
          console.warn(`[SSRF] Blocked private IP: ${ip} for ${parsedUrl.hostname}`);
          res.status(400).json({ success: false, error: 'Private IP blocked' });
          return;
        }
      }
    } catch (dnsError) {
      console.error(`[SSRF] DNS resolution failed for ${parsedUrl.hostname}:`, dnsError);
      res.status(400).json({ success: false, error: 'DNS resolution failed' });
      return;
    }

    // Fetch with strict settings
    const fetchRes = await fetch(url, {
      redirect: 'manual', // Block redirects (prevent redirect-based SSRF)
      signal: AbortSignal.timeout(5000), // 5 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SafeRepliesImageProxy/1.0)',
        'Accept': 'image/*'
      }
    });

    // Block redirects
    if (fetchRes.status >= 300 && fetchRes.status < 400) {
      console.warn(`[SSRF] Blocked redirect attempt from ${url}`);
      res.status(400).json({ success: false, error: 'Redirects not allowed' });
      return;
    }

    if (!fetchRes.ok) {
      res.status(fetchRes.status).json({ success: false, error: 'Upstream fetch failed' });
      return;
    }

    // Validate content type is actually an image
    const contentType = fetchRes.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      console.warn(`[SSRF] Blocked non-image content type: ${contentType}`);
      res.status(400).json({ success: false, error: 'Invalid content type' });
      return;
    }

    const buffer = Buffer.from(await fetchRes.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
    res.send(buffer);
  } catch (err) {
    console.error('[SSRF] Image proxy error:', err);
    res.status(500).json({ success: false, error: 'Failed to proxy image' });
  }
}
