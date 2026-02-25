import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { getValidToken } from '../services/linearAuth';
import {
  findStateIdByName,
  getIssueDetails,
  getRepositorySuggestions,
  postComment,
  updateIssueState,
} from '../services/linearClient';
import { buildManusAttachments } from '../services/manusAttachments';
import { createTaskWithFallback, replyToTask } from '../services/manusClient';
import {
  consumePendingTask,
  findPendingTaskByIssue,
  findPendingTaskBySession,
  findTaskByQuestionCommentId,
  findTaskBySession,
  getPendingTask,
  getTask,
  type PendingTaskRecord,
  removeTasksByIssue,
  storePendingTask,
  storeTask,
} from '../services/taskStore';
import {
  PROFILE_OPTIONS,
  GITHUB_CONNECTOR_ID,
  CONNECTORS_NONE_REGEX,
} from '../services/constants';
import {
  createAgentActivity,
  emitAuthElicitation,
  updateAgentSession,
} from '../services/linearAgentSession';

const router = Router();
const verboseWebhookLogs = process.env.LOG_VERBOSE_WEBHOOKS === 'true';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// ─── AgentSessionEvent payload types ────────────────────────────────────────

interface AgentSessionIssue {
  id: string;
  title?: string;
  description?: string | null;
  teamId?: string;
  team?: { id?: string; organizationId?: string; organization?: { id?: string } | null } | null;
}

interface AgentSessionWebhookPayload {
  id: string;
  issue?: AgentSessionIssue | null;
  status?: string;
}

interface AgentActivityPayload {
  id?: string;
  body?: string;
  content?: { type?: string; body?: string };
  signal?: 'stop' | 'auth' | 'select';
}

interface GuidanceRule {
  origin?: 'workspace' | 'team';
  teamName?: string;
  rule?: string;
}

interface AgentSessionEventPayload {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted';
  organizationId: string;
  agentSession: AgentSessionWebhookPayload;
  agentActivity?: AgentActivityPayload | null;
  promptContext?: string | null;
  guidance?: GuidanceRule[] | null;
  webhookId?: string;
  webhookTimestamp?: number;
}

// ─── Legacy Issue assignment payload types ───────────────────────────────────

interface LinearIssueData {
  id?: string;
  title?: string;
  description?: string | null;
  team?: { id?: string; organization?: { id?: string } | null; organizationId?: string } | null;
  teamId?: string;
  assignee?: { id?: string; name?: string; type?: string } | null;
  assigneeId?: string;
  assigneeName?: string;
  assigneeType?: string;
  organizationId?: string;
}

interface LinearIssuePayload {
  type?: string;
  action?: string;
  data?: Record<string, unknown>;
  organizationId?: string;
  updatedFields?: string[];
}

interface LinearCommentData {
  id?: string;
  body?: string;
  issueId?: string;
  parentId?: string | null;
  parent?: { id?: string } | null;
}

interface LinearCommentPayload {
  type?: string;
  action?: string;
  data?: LinearCommentData;
  organizationId?: string;
  actor?: { id?: string; type?: string; name?: string } | null;
}

// ─── Signature verification ──────────────────────────────────────────────────

function extractSignatureCandidates(signatureHeader: string): string[] {
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('=')) {
      const [key, value] = trimmed.split('=');
      const lowerKey = key.trim().toLowerCase();
      if (lowerKey === 'sha256' || lowerKey === 'v1') {
        candidates.push(value.trim());
      }
    } else {
      candidates.push(trimmed);
    }
  }
  return candidates;
}

function verifyLinearSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidates = extractSignatureCandidates(signatureHeader);
  return candidates.some((candidate) => {
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  });
}

// ─── Legacy helpers ──────────────────────────────────────────────────────────

function extractIssueData(payload: LinearIssuePayload): LinearIssueData | undefined {
  const data = payload.data as LinearIssueData | undefined;
  if (!data) return undefined;
  if ((data as { issue?: LinearIssueData }).issue) {
    return (data as { issue: LinearIssueData }).issue;
  }
  return data;
}

function isManusAssignment(
  assigneeId?: string,
  assigneeName?: string,
  assigneeType?: string,
): boolean {
  const configuredId = process.env.LINEAR_MANUS_ASSIGNEE_ID;
  if (configuredId) return assigneeId === configuredId;
  if (assigneeName && assigneeName.toLowerCase().includes('manus')) return true;
  if (assigneeType) {
    const normalized = assigneeType.toLowerCase();
    return normalized === 'app' || normalized === 'application' || normalized === 'bot';
  }
  return false;
}

function buildPromptFromDetails(
  title: string,
  description: string | null | undefined,
  comments: Array<{ body: string; authorName?: string }>,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${title}`);
  lines.push('');
  lines.push('Description:');
  lines.push(description?.trim() ? description : '(none)');
  lines.push('');
  lines.push('Comments:');
  if (!comments.length) {
    lines.push('(none)');
  } else {
    for (const comment of comments) {
      const body = comment.body?.trim() || '(empty comment)';
      const prefix = comment.authorName ? `${comment.authorName}: ` : '';
      lines.push(`- ${prefix}${body}`);
    }
  }
  return lines.join('\n');
}

const PROFILE_SELECTION_MESSAGE = 'Please select the Manus profile to use:';
const PROFILE_GUIDANCE = `Please reply with one of: ${PROFILE_OPTIONS.join(', ')}`;

function parseProfileChoice(body: string | undefined | null): string | null {
  if (!body) return null;
  const normalized = body.toLowerCase();
  if (normalized.includes('manus-1.6-max') || normalized.includes('max')) return 'manus-1.6-max';
  if (normalized.includes('manus-1.6-lite') || normalized.includes('lite')) return 'manus-1.6-lite';
  if (normalized.includes('manus-1.6')) return 'manus-1.6';
  return null;
}

function buildProfileSelectionElicitation() {
  return {
    content: {
      type: 'elicitation' as const,
      body: PROFILE_SELECTION_MESSAGE,
    },
    signal: 'select' as const,
    signalMetadata: {
      options: PROFILE_OPTIONS.map((option) => ({
        label: option === 'manus-1.6' ? 'Manus 1.6' :
               option === 'manus-1.6-lite' ? 'Manus 1.6 Lite' :
               option === 'manus-1.6-max' ? 'Manus 1.6 Max' : option,
        value: option,
      })),
    },
  };
}

function shouldDisableGithubConnector(
  comments: Array<{ body: string }>,
): boolean {
  return comments.some((comment) => CONNECTORS_NONE_REGEX.test(comment.body));
}

/**
 * Parse candidate repositories from CANDIDATE_REPOSITORIES env var.
 * Format: "github.com/owner/repo1,github.com/owner/repo2"
 */
function parseCandidateRepositories(): Array<{ hostname: string; repositoryFullName: string }> {
  const raw = process.env.CANDIDATE_REPOSITORIES;
  if (!raw) return [];

  return raw.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((repo) => {
      // Handle both "github.com/owner/repo" and "owner/repo" formats
      if (repo.includes('/')) {
        const parts = repo.split('/');
        if (parts.length >= 3) {
          // "github.com/owner/repo" format
          const hostname = parts[0];
          const fullName = parts.slice(1).join('/');
          return { hostname, repositoryFullName: fullName };
        } else if (parts.length === 2) {
          // "owner/repo" format, assume github.com
          return { hostname: 'github.com', repositoryFullName: repo };
        }
      }
      return null;
    })
    .filter((r): r is { hostname: string; repositoryFullName: string } => r !== null);
}

/**
 * Check if an error message indicates an auth/authorization issue.
 * Returns the provider name if detected, or null if not an auth error.
 */
function detectAuthError(errorMessage: string): string | null {
  const lower = errorMessage.toLowerCase();

  // Check for GitHub auth-related patterns
  if (lower.includes('github') && (lower.includes('auth') || lower.includes('unauthorized') || lower.includes('not connected'))) {
    return 'GitHub';
  }
  if (lower.includes('repository access') || lower.includes('repo access')) {
    return 'GitHub';
  }
  if (lower.includes('private repository') && lower.includes('access')) {
    return 'GitHub';
  }

  // Generic auth patterns
  if (lower.includes('authentication required') || lower.includes('account linking')) {
    return 'Manus';
  }

  return null;
}

/**
 * Handle an auth error by emitting an auth elicitation if configured.
 * Returns true if handled, false if not an auth error or not configured.
 */
async function handleAuthError(
  agentSessionId: string | undefined,
  errorMessage: string,
  accessToken: string,
): Promise<boolean> {
  if (!agentSessionId) return false;

  const authUrl = process.env.MANUS_AUTH_URL;
  if (!authUrl) return false;

  const provider = detectAuthError(errorMessage);
  if (!provider) return false;

  console.log('[linear/webhook] Detected auth error for provider:', provider);

  try {
    await emitAuthElicitation(agentSessionId, authUrl, accessToken, {
      providerName: provider,
    });
    return true;
  } catch (err) {
    console.error('[linear/webhook] Failed to emit auth elicitation:', err);
    return false;
  }
}

async function finalizePendingTask(
  pending: PendingTaskRecord,
  selectedProfile: string,
  accessToken: string,
): Promise<{ taskId: string; taskUrl?: string; usedProfile: string; fallbackToLite: boolean }> {
  if (pending.agentSessionId) {
    await createAgentActivity(pending.agentSessionId, {
      type: 'action',
      action: 'Creating Manus task',
      parameter: selectedProfile,
    }, accessToken, { ephemeral: true }).catch((err) =>
      console.error('[linear/webhook] Failed to emit creating action:', err),
    );
  }

  if (pending.linearTeamId) {
    const inProgressState = process.env.LINEAR_IN_PROGRESS_STATE ?? 'In Progress';
    try {
      const stateId = await findStateIdByName(
        pending.linearTeamId,
        inProgressState,
        accessToken,
      );
      if (stateId) {
        await updateIssueState(pending.linearIssueId, stateId, accessToken);
      }
    } catch (err) {
      console.error('Failed to update issue state:', err);
    }
  }

  // Fetch repository suggestions if candidates are configured
  let repositorySuggestions: Array<{ hostname: string; repositoryFullName: string; confidence: number }> | undefined;
  const candidates = parseCandidateRepositories();
  if (candidates.length > 0 && pending.agentSessionId) {
    try {
      const suggestions = await getRepositorySuggestions(
        pending.linearIssueId,
        pending.agentSessionId,
        candidates,
        accessToken,
      );
      repositorySuggestions = suggestions;
      console.log('[linear/webhook] Repository suggestions:', suggestions.map(s => `${s.repositoryFullName} (${s.confidence})`));
    } catch (err) {
      console.error('[linear/webhook] Failed to get repository suggestions:', err);
    }
  }

  const result = await createTaskWithFallback(pending.prompt, {
    agentProfile: selectedProfile,
    attachments: pending.attachments,
    interactiveMode: true,
    connectors: pending.connectors,
    repositorySuggestions,
  });

  storeTask(result.taskId, {
    linearIssueId: pending.linearIssueId,
    linearTeamId: pending.linearTeamId,
    workspaceId: pending.workspaceId,
    agentSessionId: pending.agentSessionId,
  });

  if (pending.agentSessionId) {
    if (result.taskUrl) {
      await updateAgentSession(pending.agentSessionId, {
        externalUrls: [{ label: 'View in Manus', url: result.taskUrl }],
      }, accessToken).catch((err) =>
        console.error('[linear/webhook] Failed to update session external URL:', err),
      );
    }

    const profileNote = result.fallbackToLite
      ? ` (fallback to ${result.usedProfile} due to credits)`
      : '';
    await createAgentActivity(pending.agentSessionId, {
      type: 'action',
      action: 'Created Manus task',
      parameter: result.taskId,
      result: `Profile: ${result.usedProfile}${profileNote}`,
    }, accessToken).catch((err) =>
      console.error('[linear/webhook] Failed to emit created action:', err),
    );
  }

  return result;
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * POST /linear/webhook
 *
 * Handles two event types from Linear:
 *
 * 1. AgentSessionEvent (action: "created") — fired when a user delegates an
 *    issue to the Manus app via the agent session UI. This is the primary
 *    trigger for creating a Manus task.
 *
 * 2. Issue (legacy) — fired when an issue is assigned to the Manus app via
 *    a standard assignee change. Kept for backwards compatibility.
 */
router.post('/', async (req: RawBodyRequest, res: Response): Promise<void> => {
  const requestLog: Record<string, unknown> = {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'linear-signature': req.headers['linear-signature'],
      'x-linear-signature': req.headers['x-linear-signature'],
    },
  };
  if (verboseWebhookLogs) {
    requestLog.bodyPreview = JSON.stringify(req.body)?.slice(0, 300);
  }
  console.log('[linear/webhook] Received request', requestLog);
  const signatureHeader =
    (req.headers['linear-signature'] as string | undefined) ??
    (req.headers['x-linear-signature'] as string | undefined);
  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(500).json({ error: 'Raw body unavailable for signature verification' });
    return;
  }

  console.log('[linear/webhook] Signature header:', signatureHeader ?? '(none)');
  if (!verifyLinearSignature(rawBody, signatureHeader)) {
    console.error('[linear/webhook] Signature verification FAILED');
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }
  console.log('[linear/webhook] Signature OK');

  const body = req.body as AgentSessionEventPayload | LinearIssuePayload;
  const eventType = (body as { type?: string }).type;
  console.log('[linear/webhook] eventType:', eventType);

  // ── Path 1: AgentSessionEvent ──────────────────────────────────────────────
  if (eventType === 'AgentSessionEvent') {
    console.log('[linear/webhook] Handling AgentSessionEvent');
    const payload = body as AgentSessionEventPayload;

    console.log('[linear/webhook] AgentSessionEvent action:', payload.action);

    const agentSessionId = payload.agentSession?.id;
    const issueId = payload.agentSession?.issue?.id;
    const workspaceId = payload.organizationId;

    // ── Handle "prompted" — user replied in the agent session ──────────────
    if (payload.action === 'prompted') {
      const userMessage =
        payload.agentActivity?.content?.body ??
        payload.agentActivity?.body ??
        payload.promptContext;
      const normalizedMessage = userMessage?.trim().toLowerCase();
      const hasStopSignal = payload.agentActivity?.signal === 'stop';
      const isStopCommand = normalizedMessage === 'stop' || hasStopSignal;
      console.log('[linear/webhook] Handling prompted event', {
        agentSessionId,
        issueId,
        workspaceId,
        userMessageLength: userMessage?.length ?? 0,
        agentActivityId: payload.agentActivity?.id ?? '(none)',
        hasAgentActivity: !!payload.agentActivity,
        hasContentBody: !!payload.agentActivity?.content?.body,
        hasBody: !!payload.agentActivity?.body,
        hasPromptContext: !!payload.promptContext,
        isStopCommand,
      });
      if (!userMessage || !agentSessionId || !workspaceId) {
        console.warn('[linear/webhook] prompted: missing required data', {
          hasUserMessage: !!userMessage,
          hasAgentSessionId: !!agentSessionId,
          hasWorkspaceId: !!workspaceId,
        });
        res.json({ ok: true, ignored: true, reason: 'prompted missing data' });
        return;
      }

      let accessToken: string;
      try {
        accessToken = await getValidToken(workspaceId);
        console.log('[linear/webhook] prompted: token fetched OK');
      } catch (err) {
        console.error('[linear/webhook] prompted: getValidToken failed:', (err as Error).message);
        res.status(503).json({ error: (err as Error).message });
        return;
      }

      const pendingSelection = findPendingTaskBySession(agentSessionId);
      console.log('[linear/webhook] prompted: pendingSelection lookup', {
        found: !!pendingSelection,
        pendingKey: pendingSelection?.commentId ?? '(none)',
        pendingIssueId: pendingSelection?.record.linearIssueId ?? '(none)',
      });
      if (pendingSelection) {
        const selectedProfile = parseProfileChoice(userMessage);
        console.log('[linear/webhook] prompted: profile selection', {
          userMessageLength: userMessage?.length ?? 0,
          parsedProfile: selectedProfile ?? '(no match)',
        });
        if (!selectedProfile) {
          await createAgentActivity(agentSessionId, {
            type: 'response',
            body: PROFILE_GUIDANCE,
          }, accessToken).catch((err) =>
            console.error('[linear/webhook] Failed to emit profile guidance:', err),
          );
          res.json({ ok: true, awaitingProfile: true, message: 'invalid profile selection' });
          return;
        }

        consumePendingTask(pendingSelection.commentId);
        console.log('[linear/webhook] prompted: consumed pending task, creating Manus task with profile:', selectedProfile);

        try {
          const result = await finalizePendingTask(
            pendingSelection.record,
            selectedProfile,
            accessToken,
          );
          console.log('[linear/webhook] prompted: Manus task created', {
            taskId: result.taskId,
            taskUrl: result.taskUrl,
            usedProfile: result.usedProfile,
            fallbackToLite: result.fallbackToLite,
          });
          res.json({ ok: true, taskId: result.taskId });
        } catch (err) {
          const message = (err as Error).message;
          console.error('[linear/webhook] prompted: finalizePendingTask failed:', message);

          // Check if this is an auth error that we can handle
          const handled = await handleAuthError(agentSessionId, message, accessToken);
          if (!handled) {
            await createAgentActivity(agentSessionId, {
              type: 'error',
              body: `Manus task creation failed: ${message}`,
            }, accessToken).catch((e) =>
              console.error('[linear/webhook] Failed to emit error activity:', e),
            );
            await postComment(
              pendingSelection.record.linearIssueId,
              `Manus task creation failed: ${message}`,
              accessToken,
            ).catch((e) =>
              console.error('[linear/webhook] Failed to post failure comment:', e),
            );
          }
          res.status(502).json({ error: message });
        }
        return;
      }

      // Find the Manus task ID associated with this session
      const manusTaskId = findTaskBySession(agentSessionId);
      console.log('[linear/webhook] prompted: task lookup for multi-turn', {
        agentSessionId,
        manusTaskId: manusTaskId ?? '(not found)',
      });

      if (!manusTaskId) {
        if (isStopCommand) {
          res.json({ ok: true, ignored: true, reason: 'no task in progress' });
          return;
        }
        console.error('[linear/webhook] No Manus task found for session:', agentSessionId);
        await createAgentActivity(agentSessionId, {
          type: 'error',
          body: 'Could not find the associated Manus task to forward your message.',
        }, accessToken).catch((err) =>
          console.error('[linear/webhook] Failed to emit error activity:', err),
        );
        res.status(422).json({ error: 'No Manus task found for this session' });
        return;
      }

      if (isStopCommand) {
        try {
          await replyToTask(manusTaskId, 'stop');
          console.log('[linear/webhook] prompted: forwarded stop to Manus task:', manusTaskId);
        } catch (err) {
          await createAgentActivity(agentSessionId, {
            type: 'error',
            body: `Failed to forward stop to Manus: ${(err as Error).message}`,
          }, accessToken).catch((e) =>
            console.error('[linear/webhook] Failed to emit error activity:', e),
          );
          res.status(502).json({ error: (err as Error).message });
          return;
        }

        res.json({ ok: true, stopped: true });
        return;
      }

      // Acknowledge the user's message
      await createAgentActivity(agentSessionId, {
        type: 'thought',
        body: 'Forwarding your message to Manus…',
      }, accessToken).catch((err) => console.error('Failed to emit thought:', err));

      try {
        await replyToTask(manusTaskId, userMessage);
        console.log('[linear/webhook] prompted: replied to Manus task:', manusTaskId);
      } catch (err) {
        await createAgentActivity(agentSessionId, {
          type: 'error',
          body: `Failed to forward message to Manus: ${(err as Error).message}`,
        }, accessToken).catch((e) =>
          console.error('[linear/webhook] Failed to emit error activity:', e),
        );
        res.status(502).json({ error: (err as Error).message });
        return;
      }

      res.json({ ok: true, forwarded: true });
      return;
    }

    // ── Handle "created" — new agent session ──────────────────────────────
    if (payload.action !== 'created') {
      console.log('[linear/webhook] Ignoring non-created action:', payload.action);
      res.json({ ok: true, ignored: true, reason: `action=${payload.action}` });
      return;
    }

    console.log('[linear/webhook] agentSession.id:', agentSessionId);
    console.log('[linear/webhook] agentSession.issue.id:', issueId);
    if (!issueId) {
      console.error('[linear/webhook] Missing agentSession.issue.id');
      res.status(400).json({ error: 'AgentSessionEvent missing agentSession.issue.id' });
      return;
    }

    console.log('[linear/webhook] organizationId:', workspaceId);
    if (!workspaceId) {
      console.error('[linear/webhook] Missing organizationId');
      res.status(422).json({ error: 'AgentSessionEvent missing organizationId' });
      return;
    }

    let accessToken: string;
    try {
      console.log('[linear/webhook] Fetching token for workspace:', workspaceId);
      accessToken = await getValidToken(workspaceId);
      console.log('[linear/webhook] Token fetched OK');
    } catch (err) {
      console.error('[linear/webhook] getValidToken failed:', (err as Error).message);
      res.status(503).json({ error: (err as Error).message });
      return;
    }

    // Emit initial thought activity IMMEDIATELY (must be within 10s).
    // Must be non-ephemeral so Linear counts it as an acknowledgment;
    // ephemeral activities may not prevent auto-archive on reassignment.
    if (agentSessionId) {
      await createAgentActivity(agentSessionId, {
        type: 'thought',
        body: 'Received issue — preparing to delegate to Manus…',
      }, accessToken).catch((err) =>
        console.error('[linear/webhook] Failed to emit initial thought:', err),
      );
    }

    let prompt: string;
    let teamId: string | undefined =
      payload.agentSession.issue?.teamId ?? payload.agentSession.issue?.team?.id;
    let issueDetails;

    if (payload.promptContext) {
      prompt = payload.promptContext;
      try {
        issueDetails = await getIssueDetails(issueId, accessToken);
        teamId = issueDetails.teamId ?? teamId;
      } catch {
        // Non-fatal — attachments may be missing.
      }
    } else {
      try {
        issueDetails = await getIssueDetails(issueId, accessToken);
        teamId = issueDetails.teamId ?? teamId;
        prompt = buildPromptFromDetails(
          issueDetails.title,
          issueDetails.description,
          issueDetails.comments,
        );
      } catch (err) {
        if (agentSessionId) {
          await createAgentActivity(agentSessionId, {
            type: 'error',
            body: `Failed to fetch issue details: ${(err as Error).message}`,
          }, accessToken).catch((e) =>
            console.error('[linear/webhook] Failed to emit error activity:', e),
          );
        }
        res.status(502).json({ error: (err as Error).message });
        return;
      }
    }

    // Append structured guidance if provided separately from promptContext
    if (payload.guidance && payload.guidance.length > 0) {
      const guidanceLines = ['', '---', '**Workspace/Team Guidance:**', ''];
      for (const rule of payload.guidance) {
        const origin = rule.origin ?? 'workspace';
        const source = rule.teamName ?? 'workspace';
        if (rule.rule) {
          guidanceLines.push(`[${origin}: ${source}] ${rule.rule}`);
        }
      }
      prompt = prompt + guidanceLines.join('\n');
      console.log('[linear/webhook] Appended guidance rules:', payload.guidance.length);
    }

    let attachments = [] as Awaited<ReturnType<typeof buildManusAttachments>>;
    try {
      attachments = await buildManusAttachments(issueDetails ?? null);
    } catch (err) {
      console.error('[linear/webhook] Failed to build attachments:', err);
    }

    const connectors = issueDetails?.comments && shouldDisableGithubConnector(issueDetails.comments)
      ? []
      : [GITHUB_CONNECTOR_ID];

    // Clean up stale task/pending records from previous sessions for this issue
    // so re-assignment after archive starts fresh.
    removeTasksByIssue(issueId);

    let profileActivityId: string | null = null;
    if (agentSessionId) {
      const { content, signal, signalMetadata } = buildProfileSelectionElicitation();
      try {
        profileActivityId = await createAgentActivity(
          agentSessionId,
          content,
          accessToken,
          { signal, signalMetadata },
        );
      } catch (err) {
        console.error('[linear/webhook] Failed to emit profile selection:', err);
        // Fallback: emit a plain response so the user sees the profile options
        await createAgentActivity(agentSessionId, {
          type: 'response',
          body: PROFILE_GUIDANCE,
        }, accessToken).catch((e) =>
          console.error('[linear/webhook] Failed to emit fallback profile guidance:', e),
        );
      }
    }

    console.log('[linear/webhook] created: storing pending task', {
      key: issueId,
      agentSessionId: agentSessionId ?? '(none)',
      teamId: teamId ?? '(none)',
      workspaceId,
      promptLength: prompt!.length,
      attachmentCount: attachments.length,
      connectorCount: connectors.length,
      profileActivityId: profileActivityId ?? '(none)',
    });
    storePendingTask(issueId, {
      linearIssueId: issueId,
      linearTeamId: teamId,
      workspaceId,
      agentSessionId,
      prompt: prompt!,
      attachments,
      connectors,
      profileActivityId,
    });

    res.json({ ok: true, awaitingProfile: true });
    return;
  }

  // ── Path 2: Comment replies (profile selection or interactive replies) ───
  if (eventType === 'Comment') {
    const payload = body as LinearCommentPayload;
    if (payload.action !== 'create') {
      res.json({ ok: true, ignored: true, reason: `action=${payload.action}` });
      return;
    }

    const comment = payload.data;
    const parentId = comment?.parentId ?? comment?.parent?.id;
    const issueId = comment?.issueId;
    const pending = parentId ? getPendingTask(parentId) : undefined;
    const pendingByIssue = !pending && issueId
      ? findPendingTaskByIssue(issueId)
      : undefined;
    const pendingRecord = pending ?? pendingByIssue?.record;
    const pendingKey = pending ? parentId! : pendingByIssue?.commentId;

    if (pendingRecord && pendingKey) {
      const selectedProfile = parseProfileChoice(comment?.body);
      let accessToken: string;
      try {
        accessToken = await getValidToken(pendingRecord.workspaceId);
      } catch (err) {
        res.status(503).json({ error: (err as Error).message });
        return;
      }

      if (!selectedProfile) {
        await postComment(
          pendingRecord.linearIssueId,
          PROFILE_GUIDANCE,
          accessToken,
          parentId ?? undefined,
        ).catch((err) =>
          console.error('[linear/webhook] Failed to post profile guidance comment:', err),
        );
        res.json({ ok: true, awaitingProfile: true, message: 'invalid profile selection' });
        return;
      }

      consumePendingTask(pendingKey);
      try {
        const result = await finalizePendingTask(
          pendingRecord,
          selectedProfile,
          accessToken,
        );
        res.json({ ok: true, taskId: result.taskId });
      } catch (err) {
        const message = (err as Error).message;

        // Check if this is an auth error that we can handle
        const handled = await handleAuthError(pendingRecord.agentSessionId, message, accessToken);
        if (!handled) {
          await postComment(
            pendingRecord.linearIssueId,
            `Manus task creation failed: ${message}`,
            accessToken,
          ).catch((e) =>
            console.error('[linear/webhook] Failed to post failure comment:', e),
          );
        }
        res.status(502).json({ error: message });
        return;
      }
      return;
    }

    if (!parentId) {
      res.json({ ok: true, ignored: true, reason: 'no parentId' });
      return;
    }

    const questionTaskId = findTaskByQuestionCommentId(parentId);
    if (questionTaskId) {
      const record = getTask(questionTaskId);
      if (!record) {
        res.status(404).json({ error: 'Task not found for question comment' });
        return;
      }

      const replyBody = comment?.body?.trim();
      if (!replyBody) {
        res.json({ ok: true, ignored: true, reason: 'empty reply' });
        return;
      }

      let accessToken: string;
      try {
        accessToken = await getValidToken(record.workspaceId);
      } catch (err) {
        res.status(503).json({ error: (err as Error).message });
        return;
      }

      if (record.linearTeamId) {
        const inProgressState = process.env.LINEAR_IN_PROGRESS_STATE ?? 'In Progress';
        try {
          const stateId = await findStateIdByName(
            record.linearTeamId,
            inProgressState,
            accessToken,
          );
          if (stateId) {
            await updateIssueState(record.linearIssueId, stateId, accessToken);
          }
        } catch (err) {
          console.error('Failed to update issue state:', err);
        }
      }

      if (record.agentSessionId) {
        await createAgentActivity(record.agentSessionId, {
          type: 'thought',
          body: 'Forwarding your reply to Manus…',
        }, accessToken).catch((err) =>
          console.error('[linear/webhook] Failed to emit thought activity:', err),
        );
      }

      try {
        await replyToTask(questionTaskId, replyBody);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
        return;
      }

      res.json({ ok: true, forwarded: true });
      return;
    }

    res.json({ ok: true, ignored: true });
    return;
  }

  // ── Path 3: Legacy Issue assignment ───────────────────────────────────────
  const legacyPayload = body as LinearIssuePayload;
  const legacyType = legacyPayload.type?.toLowerCase();

  if (legacyType && legacyType !== 'issue') {
    res.json({ ok: true, ignored: true, reason: `type=${legacyType}` });
    return;
  }

  const issueData = extractIssueData(legacyPayload);
  const issueId = issueData?.id;
  if (!issueId) {
    res.status(400).json({ error: 'Missing issue id in webhook payload' });
    return;
  }

  if (
    legacyPayload.updatedFields?.length &&
    !legacyPayload.updatedFields.includes('assigneeId') &&
    !legacyPayload.updatedFields.includes('assignee')
  ) {
    res.json({ ok: true, ignored: true });
    return;
  }

  const assigneeId = issueData?.assignee?.id ?? issueData?.assigneeId;
  const assigneeName = issueData?.assignee?.name ?? issueData?.assigneeName;
  const assigneeType = issueData?.assignee?.type ?? issueData?.assigneeType;

  if (!isManusAssignment(assigneeId, assigneeName, assigneeType)) {
    res.json({ ok: true, ignored: true });
    return;
  }

  const workspaceId =
    legacyPayload.organizationId ??
    issueData?.organizationId ??
    issueData?.team?.organization?.id ??
    issueData?.team?.organizationId;

  if (!workspaceId) {
    res.status(422).json({ error: 'Missing workspace/organization id in webhook payload' });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getValidToken(workspaceId);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  let issueDetails;
  try {
    issueDetails = await getIssueDetails(issueId, accessToken);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  const teamId = issueDetails.teamId ?? issueData?.team?.id ?? issueData?.teamId;

  const prompt = buildPromptFromDetails(
    issueDetails.title,
    issueDetails.description,
    issueDetails.comments,
  );

  let attachments = [] as Awaited<ReturnType<typeof buildManusAttachments>>;
  try {
    attachments = await buildManusAttachments(issueDetails ?? null);
  } catch (err) {
    console.error('[linear/webhook] Failed to build attachments:', err);
  }

  const connectors = shouldDisableGithubConnector(issueDetails.comments)
    ? []
    : [GITHUB_CONNECTOR_ID];

  try {
    await postComment(
      issueId,
      PROFILE_GUIDANCE,
      accessToken,
    );
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  storePendingTask(issueId, {
    linearIssueId: issueId,
    linearTeamId: teamId ?? undefined,
    workspaceId,
    prompt,
    attachments,
    connectors,
  });

  res.json({ ok: true, awaitingProfile: true });
});

export default router;
