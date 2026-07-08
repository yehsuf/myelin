// Registry of managed-section instruction snippets injected into agent
// instruction files (~/.claude/CLAUDE.md — global — and repo-level
// AGENTS.md — per-project). Mirrors how Myelin's own skills/tools are
// scoped: each snippet independently declares WHERE it may appear
// (global/repo), WHICH provider(s)/model(s) it applies to, its priority
// PLACEMENT within the assembled block, and the config flag that gates it
// (so `myelin config set output_style.<key> false` turns it off without
// touching code).
//
// Placement matters for prompt attention, not just cache stability: 'top'
// snippets are emitted before 'end' snippets in the final block.

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function globMatch(pattern, value) {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

export const INSTRUCTION_SNIPPETS = [
  {
    id: 'token_efficiency',
    configKey: 'output_style.token_efficiency',
    scope: ['global', 'repo'],
    providers: ['*'],
    models: ['*'],
    placement: 'top',
    title: 'Token efficiency',
    render: () => `- **Read narrowly.** Use offset+limit on Read/view. Read only sections relevant to the task.
- **grep before reading.** Locate exact lines with grep/serena before opening a file.
- **No exploratory reads.** Don't read files "just for context" — work from what's already known.
- **No whole-file rewrites.** Always use Edit (diff-only) for existing files.
- **Targeted tests only.** Run only the spec/test that changed, not the full suite.
- **No end-of-response summaries.** The diff speaks for itself.
- **Agents only when necessary.** Spawn subagents only for genuinely parallel independent tasks.
- **No redundant verification.** Don't re-read a file after editing; don't run unaffected tests.`,
  },
  {
    id: 'code_navigation',
    configKey: 'output_style.code_navigation',
    scope: ['global', 'repo'],
    providers: ['*'],
    models: ['*'],
    placement: 'top',
    title: 'Efficient Navigation (Myelin-powered)',
    render: () => `- Prefer MCP tools: \`serena.*\` (structural), \`semble.*\` (semantic) over file reads.
- Shell commands are RTK-compressed — do NOT pipe through head/tail unnecessarily.
- For code review: call \`mcp-git.*\` tools instead of reading both file versions.
- For cross-file patterns: use ast-grep, not grep loops.
- Never use raw \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\` in the Bash tool — use Serena.`,
  },
  {
    id: 'caveman_output_protocol',
    configKey: 'output_style.caveman_rules',
    scope: ['global', 'repo'],
    providers: ['*'],
    models: ['*'],
    placement: 'end',
    title: 'Output Protocol',
    render: () => `- Terse. No preamble. Patch format for file edits. No "I will now...".
- Bullet lists over prose.`,
  },
];

/**
 * Render the assembled managed-section body for a given injection target.
 * @param {object} opts
 * @param {'global'|'repo'} opts.target - which file tier is being written
 * @param {string} opts.provider - 'claude' | 'copilot' | any future target
 * @param {string} [opts.model] - specific model id, matched against each
 *   snippet's `models` glob list (e.g. ['claude-opus-*'])
 * @param {object} opts.cfg - loaded Myelin config (schema.mjs shape)
 * @param {string[]} [opts.extraSections] - additional pre-rendered
 *   `## Title\ncontent` blocks appended after registry snippets (e.g. a
 *   dynamic "Session" section with a live port number)
 */
export function renderManagedBlock({ target, provider, model = '*', cfg, extraSections = [] }) {
  const matched = INSTRUCTION_SNIPPETS.filter(s => {
    if (!s.scope.includes(target)) return false;
    if (!s.providers.includes('*') && !s.providers.includes(provider)) return false;
    if (!s.models.includes('*') && !s.models.some(m => globMatch(m, model))) return false;
    const enabled = getPath(cfg, s.configKey);
    return enabled !== false; // default-on unless explicitly disabled
  });

  const order = { top: 0, end: 1 };
  matched.sort((a, b) => (order[a.placement] ?? 0) - (order[b.placement] ?? 0));

  const rendered = matched.map(s => `## ${s.title}\n${s.render()}`);
  return [...rendered, ...extraSections].join('\n\n');
}
