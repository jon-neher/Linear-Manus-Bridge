import { LINEAR_GRAPHQL_URL } from './constants';
import { fetchWithTimeout } from './fetchWithTimeout';
import { isTimeoutError, handleTimeoutError } from './timeoutErrorHandler';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function linearGql<T>(
  query: string,
  variables: Record<string, unknown>,
  accessToken: string
): Promise<T> {
  try {
    const response = await fetchWithTimeout(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linear API error (${response.status}): ${text}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
    }

    return json.data as T;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(handleTimeoutError('linearGql', error));
    }
    throw error;
  }
}
