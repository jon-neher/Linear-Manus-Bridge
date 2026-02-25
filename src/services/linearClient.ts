import { linearGql } from './linearGql';

export async function postComment(
  issueId: string,
  body: string,
  accessToken: string,
  parentId?: string,
): Promise<string | null> {
  const data = await linearGql<{
    commentCreate: { comment?: { id: string } };
  }>(
    `mutation CommentCreate($issueId: String!, $body: String!, $parentId: String) {
      commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) {
        success
        comment { id }
      }
    }`,
    { issueId, body, parentId },
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
    `mutation CommentUpdate($commentId: String!, $body: String!) {
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
    `query IssueDetails($issueId: String!, $commentLimit: Int!) {
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
