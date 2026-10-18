import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;

// Hosted hub. Override with --hub or VIBECREW_HUB.
export const DEFAULT_HUB = 'http://localhost:8787';

export const DEFAULTS = Object.freeze({
  assign_mode: 'hybrid',
  approvals: Object.freeze({ master_prompt: 'all' }),
  claim_mode: 'ask',
  claim_ttl_min: 30,
});

export const ASSIGN_MODES = ['self', 'agent', 'hybrid'];
export const APPROVAL_RULES = ['all', 'majority', 'owner'];
export const CLAIM_MODES = ['ask', 'block', 'warn'];

export const PROMPT_SECTIONS = [
  'Idea',
  'Who it is for',
  'Must-haves',
  'Not doing',
  'Tech stack',
  'Look and feel',
  'Done means',
  'Conventions',
];

export const TASK_STATUSES = ['proposed', 'open', 'assigned', 'in_progress', 'done'];

// Kinds that reach a member's agent right away (after an edit), not just on the next prompt.
export const URGENT_KINDS = [
  'ask',
  'reply',
  'task_proposed',
  'task_assigned',
  'task_unblocked',
  'prompt_submitted',
  'prompt_locked',
  'member_removed',
];

export const LIMITS = Object.freeze({
  text: 8000,
  section: 20000,
  body: 262144,
  tasks_per_plan: 100,
  members: 50,
});

export const ONLINE_MS = 150_000;
export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const ASK_WAIT_MAX_S = 20;
export const HOOK_TIMEOUT_MS = 3000;
