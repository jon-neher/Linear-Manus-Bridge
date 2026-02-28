import { REQUEST_TIMEOUT_MS } from './constants';

/**
 * Wraps the native fetch function with a configurable timeout.
 * If the request exceeds the timeout, an AbortError is thrown.
 *
 * @param url - The URL to fetch
 * @param init - Fetch options (method, headers, body, etc.)
 * @returns Promise<Response>
 * @throws AbortError if the request times out
 */
export async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}
