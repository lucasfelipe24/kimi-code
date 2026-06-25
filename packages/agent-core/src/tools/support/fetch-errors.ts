/**
 * Custom error class thrown when a fetch target domain is restricted.
 */
export class DomainBlockedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`FetchURL is unable to fetch from ${domain}. This domain is restricted.`);
    this.name = 'DomainBlockedError';
    this.domain = domain;
    Object.setPrototypeOf(this, DomainBlockedError.prototype);
  }
}

/**
 * Custom error class thrown when the domain safety check fails,
 * typically due to network restrictions preventing verification.
 */
export class DomainCheckFailedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions.`);
    this.name = 'DomainCheckFailedError';
    this.domain = domain;
    Object.setPrototypeOf(this, DomainCheckFailedError.prototype);
  }
}

/**
 * Custom error class thrown when access to a domain is blocked
 * by the network egress proxy.
 */
export class EgressBlockedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    );
    this.name = 'EgressBlockedError';
    this.domain = domain;
    Object.setPrototypeOf(this, EgressBlockedError.prototype);
  }
}

/**
 * Custom error class thrown when a fetch request encounters
 * a redirect to a different host.
 */
export class CrossOriginRedirectError extends Error {
  readonly originalUrl: string;
  readonly redirectUrl: string;
  readonly statusCode: number;

  constructor(originalUrl: string, redirectUrl: string, statusCode: number) {
    super(`Redirect to different host: ${originalUrl} → ${redirectUrl}`);
    this.name = 'CrossOriginRedirectError';
    this.originalUrl = originalUrl;
    this.redirectUrl = redirectUrl;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, CrossOriginRedirectError.prototype);
  }
}
