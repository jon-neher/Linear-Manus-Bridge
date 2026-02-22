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
): Promise<string | null> {
  const data = await linearGql<{
    commentCreate: { comment?: { id: string } };
  }>(
    `mutation CommentCreate($issueId: ID!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }`,
    { issueId, body },
    accessToken,
  );

  return data.commentCreate.comment?.id ?? null;
}

export async function updateComment(
  commentId: string,
  body: string,
  accessToken: string,
): Promise<void> {
  await linearGql<unknown>(
    `mutation CommentUpdate($commentId: ID!, $body: String!) {
      commentUpdate(id: $commentId, input: { body: $body }) {
        success
        comment { id }
      }
    }`,
    { commentId, body },
    accessToken,
  );
}

export interface IssueCommentSummary {
  id: string;
  body: string;
  authorName?: string;
}

export interface IssueDetails {
  id: string;
  title: string;
  description?: string | null;
  teamId?: string | null;
  comments: IssueCommentSummary[];
}

interface IssueDetailsData {
  issue: {
    id: string;
    title: string;
    description?: string | null;
    team?: { id: string } | null;
    comments: { nodes: Array<{ id: string; body: string; user?: { name?: string } | null }> };
  } | null;
}

export async function getIssueDetails(
  issueId: string,
  accessToken: string,
  commentLimit = 5,
): Promise<IssueDetails> {
  const data = await linearGql<IssueDetailsData>(
    `query IssueDetails($issueId: ID!, $commentLimit: Int!) {
      issue(id: $issueId) {
        id
        title
        description
        team { id }
        comments(last: $commentLimit) {
          nodes {
            id
            body
            user { name }
          }
        }
      }
    }`,
    { issueId, commentLimit },
    accessToken,
  );

  if (!data.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  return {
    id: data.issue.id,
    title: data.issue.title,
    description: data.issue.description ?? null,
    teamId: data.issue.team?.id ?? null,
    comments: data.issue.comments.nodes.map((node) => ({
      id: node.id,
      body: node.body,
      authorName: node.user?.name,
    })),
  };
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
    `query WorkflowStates($teamId: ID!) {
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
    `mutation IssueUpdate($issueId: ID!, $stateId: ID!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
        issue { id state { name } }
      }
    }`,
    { issueId, stateId },
    accessToken,
  );
}
