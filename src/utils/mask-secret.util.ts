/**
 * Utility to mask sensitive secrets in logs.
 * Replaces high-risk strings with [MASKED].
 */
export function maskSecret(message: string): string {
  if (!message) return message;
  
  // Regex patterns for LWA and AWS secrets
  const secretPatterns = [
    /amzn1\.oa2-cs\.[a-z0-9]+/gi,          // LWA Client Secret
    /Atzr\|[a-z0-9_-]+/gi,                  // LWA Access Token
    /Atza\|[a-zA-Z0-9_-]+/gi,              // LWA Refresh Token (was missing)
    /AKIA[A-Z0-9]{16}/gi,                   // AWS Access Key ID
    /AWS_SECRET_ACCESS_KEY":"[^"]+"/gi,     // AWS Secret Key pattern
  ];

  let maskedMessage = message;
  
  secretPatterns.forEach(pattern => {
    maskedMessage = maskedMessage.replace(pattern, '[MASKED]');
  });

  return maskedMessage;
}
