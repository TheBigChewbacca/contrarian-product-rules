// Shopify retries a webhook for up to 48 hours on any non-2xx response. Only
// errors that a retry could actually clear should return 500; a permanent
// error (bad configuration, a deleted resource, a rejected mutation) would
// otherwise generate two days of pointless retries for a single event.
const RETRYABLE_PATTERNS = [
  /throttl/i,
  /rate limit/i,
  /timeout/i,
  /timed out/i,
  /temporarily/i,
  /try again/i,
  /internal server error/i,
  /service unavailable/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
];

export function isRetryable(message: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}
