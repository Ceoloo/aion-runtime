/**
 * Map raw GHL / LeadConnector HTTP failures into stable adapter error codes.
 */

export interface MappedProviderError {
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  ambiguousWrite: boolean;
}

/**
 * Normalize provider HTTP status + body hint into a durable error contract.
 * Never includes secrets or Authorization material.
 */
export function mapGhlHttpError(
  status: number,
  bodyHint = '',
): MappedProviderError {
  const hint = bodyHint.replace(/\s+/g, ' ').trim().slice(0, 240);

  if (status === 429) {
    return {
      errorCode: 'GHL_RATE_LIMIT',
      errorMessage: hint
        ? `ghl_rate_limited body=${hint}`
        : 'ghl_rate_limited',
      retryable: true,
      ambiguousWrite: false,
    };
  }

  if (status === 408 || status === 504) {
    return {
      errorCode: 'GHL_AMBIGUOUS_TIMEOUT',
      errorMessage: hint
        ? `ghl_ambiguous_timeout status=${status} body=${hint}`
        : `ghl_ambiguous_timeout status=${status}`,
      retryable: false,
      ambiguousWrite: true,
    };
  }

  if (status === 409) {
    return {
      errorCode: 'GHL_CONFLICT',
      errorMessage: hint || 'ghl_conflict',
      retryable: false,
      ambiguousWrite: false,
    };
  }

  if (status === 401 || status === 403) {
    return {
      errorCode: 'GHL_AUTH_DENIED',
      errorMessage: hint || `ghl_auth_denied status=${status}`,
      retryable: false,
      ambiguousWrite: false,
    };
  }

  if (status === 404) {
    return {
      errorCode: 'GHL_NOT_FOUND',
      errorMessage: hint || 'ghl_not_found',
      retryable: false,
      ambiguousWrite: false,
    };
  }

  if (status === 422 || status === 400) {
    return {
      errorCode: 'GHL_BAD_REQUEST',
      errorMessage: hint || `ghl_bad_request status=${status}`,
      retryable: false,
      ambiguousWrite: false,
    };
  }

  if (status >= 500) {
    // 5xx after a write may be ambiguous; treat as ambiguous so we do not auto-repeat.
    return {
      errorCode: 'GHL_AMBIGUOUS_TIMEOUT',
      errorMessage: hint
        ? `ghl_server_error_ambiguous status=${status} body=${hint}`
        : `ghl_server_error_ambiguous status=${status}`,
      retryable: false,
      ambiguousWrite: true,
    };
  }

  return {
    errorCode: `GHL_HTTP_${status}`,
    errorMessage: hint
      ? `ghl_http_error status=${status} body=${hint}`
      : `ghl_http_error status=${status}`,
    retryable: false,
    ambiguousWrite: false,
  };
}
