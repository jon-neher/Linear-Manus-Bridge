import { linearGql } from './linearGql';
import { createLogger } from './logger';

const log = createLogger('linearAgentSession');

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
  log.info(
    {
      agentSessionId,
      type: content.type,
      signal: options.signal ?? '(none)',
      ephemeral: options.ephemeral ?? false,
    },
    'createAgentActivity',
  );
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
  log.info(
    {
      success: data.agentActivityCreate.success,
      activityId: activityId ?? '(none)',
    },
    'createAgentActivity result',
  );
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

/**
 * Emit an auth elicitation to prompt the user to link an account.
 * This shows a "Link Account" button in Linear's UI.
 */
export async function emitAuthElicitation(
  agentSessionId: string,
  authUrl: string,
  accessToken: string,
  options: { providerName?: string; userId?: string } = {},
): Promise<string | null> {
  const body = options.providerName
    ? `Please link your ${options.providerName} account to continue.`
    : 'Please link your account to continue.';

  return createAgentActivity(
    agentSessionId,
    { type: 'elicitation', body },
    accessToken,
    {
      signal: 'auth',
      signalMetadata: {
        url: authUrl,
        providerName: options.providerName,
        userId: options.userId,
      },
    },
  );
}
