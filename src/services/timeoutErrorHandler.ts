/**
 * Check if an error is an AbortError caused by a timeout.
 * AbortError is thrown when fetch is aborted via AbortController.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Log a timeout error with context and return a standard error message.
 */
export function handleTimeoutError(context: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[timeout] ${context}: ${message}`);
  return 'Request timeout: the external service did not respond within the configured timeout period';
}
