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

export async function postComment(
  issueId: string,
  body: string,
  accessToken: string,
): Promise<void> {
  await linearGql<unknown>(
    `mutation CommentCreate($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }`,
    { issueId, body },
    accessToken,
  );
}

interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

interface WorkflowStatesData {
  workflowStates: { nodes: WorkflowState[] };
}

async function getWorkflowStates(
  teamId: string,
  accessToken: string,
): Promise<WorkflowState[]> {
  const data = await linearGql<WorkflowStatesData>(
    `query WorkflowStates($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`,
    { teamId },
    accessToken,
  );
  return data.workflowStates.nodes;
}

export async function findStateIdByName(
  teamId: string,
  stateName: string,
  accessToken: string,
): Promise<string | null> {
  const states = await getWorkflowStates(teamId, accessToken);
  const match = states.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  return match?.id ?? null;
}

export async function updateIssueState(
  issueId: string,
  stateId: string,
  accessToken: string,
): Promise<void> {
  await linearGql<unknown>(
    `mutation IssueUpdate($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
        issue { id state { name } }
      }
    }`,
    { issueId, stateId },
    accessToken,
  );
}
