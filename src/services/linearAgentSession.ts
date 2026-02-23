const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function linearGql<T>(
  query: string,
  variables: Record<string, unknown>,
  accessToken: string,
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
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
    throw new Error(
      `Linear GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`,
    );
  }

  return json.data as T;
}

// ─── Agent Activity types ────────────────────────────────────────────────────

export type AgentActivityType = 'thought' | 'action' | 'response' | 'error' | 'elicitation';

export interface ThoughtContent {
  type: 'thought';
  body: string;
}

export interface ActionContent {
  type: 'action';
  action: string;
  parameter?: string;
  result?: string;
}

export interface ResponseContent {
  type: 'response';
  body: string;
}

export interface ErrorContent {
  type: 'error';
  body: string;
}

export interface ElicitationContent {
  type: 'elicitation';
  body: string;
}

export type AgentActivityContent =
  | ThoughtContent
  | ActionContent
  | ResponseContent
  | ErrorContent
  | ElicitationContent;

export type AgentActivitySignal = 'auth' | 'select';

export interface AgentActivitySignalOptions {
  signal?: AgentActivitySignal;
  signalMetadata?: Record<string, unknown>;
  ephemeral?: boolean;
}

export async function createAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  accessToken: string,
  options: AgentActivitySignalOptions = {},
): Promise<string | null> {
  console.log('[linearAgentSession] createAgentActivity', {
    agentSessionId,
    type: content.type,
    signal: options.signal ?? '(none)',
    ephemeral: options.ephemeral ?? false,
  });
  const data = await linearGql<{
    agentActivityCreate: { success: boolean; agentActivity?: { id: string } };
  }>(
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }`,
    {
      input: {
        agentSessionId,
        content,
        signal: options.signal,
        signalMetadata: options.signalMetadata,
        ephemeral: options.ephemeral,
      },
    },
    accessToken,
  );

  const activityId = data.agentActivityCreate.agentActivity?.id ?? null;
  console.log('[linearAgentSession] createAgentActivity result', {
    success: data.agentActivityCreate.success,
    activityId: activityId ?? '(none)',
  });
  return activityId;
}

// ─── Agent Session update ────────────────────────────────────────────────────

export interface AgentSessionPlanStep {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}

export interface AgentSessionUpdateData {
  externalUrls?: Array<{ label: string; url: string }>;
  plan?: AgentSessionPlanStep[];
}

export async function updateAgentSession(
  agentSessionId: string,
  data: AgentSessionUpdateData,
  accessToken: string,
): Promise<void> {
  await linearGql<{ agentSessionUpdate: { success: boolean } }>(
    `mutation AgentSessionUpdate($agentSessionId: String!, $data: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $agentSessionId, input: $data) {
        success
      }
    }`,
    { agentSessionId, data },
    accessToken,
  );
}
