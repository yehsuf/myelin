#!/usr/bin/env node
'use strict';
/**
 * compact-prepare — generic /compact hint generator.
 *
 * Reads live session state (workspace.yaml, todos.json / session.db, plan.md,
 * checkpoints, compact.yaml, git) and emits a dense COMPACT_STATE_V1 hint
 * ready to paste after /compact.
 *
 * Usage:
 *   node compact-prepare.mjs [prepare|emit|resume]
 *
 * Exit codes:
 *   0 = ok
 *   2 = session unresolvable
 *   3 = session dir missing
 *   4 = workspace.yaml unreadable
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectClipboardCandidates } from '../detect/clipboard.mjs';

const HOME = process.env.HOME ?? os.homedir();
const SESSION_ROOT = process.env.COPILOT_AGENT_SESSION_ROOT ?? path.join(HOME, '.copilot', 'session-state');
const MAX_HINT = 4000; // Copilot CLI customInstructions hard cap

// ─── small helpers ────────────────────────────────────────────
function tryRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function stripNonAscii(s) {
  return (s ?? '').replace(/[^\x20-\x7E\n]/g, '').replace(/\r/g, '');
}

function truncate(s, n, suffix = '…') {
  s = s ?? '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - suffix.length)) + suffix;
}

function firstLine(s) {
  if (!s) return '';
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// ─── YAML parsers (minimal, no deps) ──────────────────────────
export function parseWorkspaceYaml(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim() || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) out[m[1]] = v;
  }
  return out;
}

export function parseCompactYaml(text) {
  const out = { repos: [], rules: [], next: '', notes: '' };
  if (!text) return out;
  const lines = text.split('\n');
  let section = null; // 'repos' | 'rules' | null
  let currentRepo = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '');
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    // Top-level key (no leading spaces)
    const top = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (top && !raw.startsWith(' ') && !raw.startsWith('\t')) {
      const key = top[1];
      const val = top[2].trim();
      if (key === 'repos') { section = 'repos'; currentRepo = null; continue; }
      if (key === 'rules') { section = 'rules'; continue; }
      if (key === 'next') {
        section = null;
        out.next = unquote(val);
        continue;
      }
      if (key === 'notes') {
        section = null;
        out.notes = unquote(val);
        continue;
      }
      section = null;
      continue;
    }

    // List item
    const listStart = raw.match(/^\s+-\s*(.*)$/);
    if (listStart) {
      const rest = listStart[1];
      if (section === 'rules') {
        out.rules.push(unquote(rest.trim()));
      } else if (section === 'repos') {
        currentRepo = {};
        out.repos.push(currentRepo);
        // maybe inline "path: foo"
        const inline = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
        if (inline) currentRepo[inline[1]] = unquote(inline[2].trim());
        else if (rest.trim()) currentRepo._value = unquote(rest.trim());
      }
      continue;
    }

    // Nested key inside current repo
    const nested = raw.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (nested && section === 'repos' && currentRepo) {
      currentRepo[nested[1]] = unquote(nested[2].trim());
    }
  }
  return out;
}

function unquote(v) {
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseGlobalDefaults(text) {
  const out = { rules: [] };
  if (!text) return out;
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (top && !line.startsWith(' ') && !line.startsWith('\t')) {
      section = top[1] === 'rules' ? 'rules' : null;
      continue;
    }
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && section === 'rules') out.rules.push(unquote(item[1].trim()));
  }
  return out;
}

// ─── session resolution ───────────────────────────────────────
function resolveSessionId() {
  if (process.env.COPILOT_AGENT_SESSION_ID) return process.env.COPILOT_AGENT_SESSION_ID;

  if (!existsSync(SESSION_ROOT)) return null;
  const cwd = process.cwd();
  let entries;
  try { entries = readdirSync(SESSION_ROOT); } catch { return null; }

  const candidates = [];
  for (const name of entries) {
    const dir = path.join(SESSION_ROOT, name);
    const wsPath = path.join(dir, 'workspace.yaml');
    let st;
    try { st = statSync(wsPath); } catch { continue; }
    const ws = parseWorkspaceYaml(tryRead(wsPath) ?? '');
    if (ws.cwd && ws.cwd === cwd) candidates.push({ name, mtime: st.mtimeMs });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].name;
}

// ─── todos ────────────────────────────────────────────────────
function loadTodos(sessionDir) {
  const db = path.join(sessionDir, 'session.db');
  const sql = "SELECT id,title,COALESCE(description,'') AS description,status FROM todos "
    + "WHERE status IN ('in_progress','pending','blocked') "
    + "ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, updated_at DESC";
  if (existsSync(db)) {
    try {
      const raw = execFileSync('sqlite3', ['-json', db, sql], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (raw) return JSON.parse(raw);
      return [];
    } catch { /* fallthrough */ }
  }
  const fallback = path.join(sessionDir, 'files', 'todos.json');
  const text = tryRead(fallback);
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    if (j.generatedAt) {
      const age = Date.now() - Date.parse(j.generatedAt);
      if (isFinite(age) && age > 30 * 60 * 1000) return [];
    }
    return Array.isArray(j.todos) ? j.todos : [];
  } catch { return []; }
}

// ─── plan.md ──────────────────────────────────────────────────
function loadPlanNext(cwd) {
  const p = path.join(cwd, 'plan.md');
  const text = tryRead(p);
  if (!text) return { path: null, lines: 0, next: '' };
  const lines = text.split('\n').length;
  const m = text.match(/(?:^|\n)##\s+Next\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  const next = m ? m[1].trim() : '';
  return { path: p, lines, next };
}

// ─── checkpoints ──────────────────────────────────────────────
function loadCheckpoints(sessionDir) {
  const p = path.join(sessionDir, 'checkpoints', 'index.md');
  const text = tryRead(p);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:\|\s*)?(\d{3}-\S+)\s*(?:\|)?\s*(.*)$/);
    if (m) {
      const rest = m[2].replace(/\|.*$/, '').trim();
      out.push(rest || m[1]);
    }
  }
  return out.slice(-3).reverse();
}

// ─── git per repo ─────────────────────────────────────────────
function repoInfo(repoPath) {
  if (!existsSync(repoPath)) return null;
  const head = runGit(['log', '--oneline', '-1'], repoPath);
  if (!head) return null;
  const [sha, ...subjParts] = head.split(' ');
  const subj = subjParts.join(' ');
  const branch = runGit(['branch', '--show-current'], repoPath);
  const porcelain = runGit(['status', '--porcelain=v1'], repoPath);
  const dirtyLines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
  const dirtyFiles = dirtyLines.map(l => l.slice(3)).slice(0, 6);
  const worktreeRaw = runGit(['worktree', 'list', '--porcelain'], repoPath);
  const worktrees = [];
  let cur = null;
  for (const line of worktreeRaw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) worktrees.push(cur);
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (cur) worktrees.push(cur);
  const extraWorktrees = worktrees.filter(w =>
    path.resolve(w.path) !== path.resolve(repoPath));

  const since = runGit(['log', '--since=24 hours ago', '--pretty=%h %s', '--max-count=5'], repoPath);
  const recent = since ? since.split('\n').filter(Boolean) : [];

  return {
    path: repoPath, sha7: sha, subj, branch,
    dirtyCount: dirtyLines.length, dirtyFiles,
    extraWorktrees, recent,
  };
}

// ─── build sections ───────────────────────────────────────────
export function buildHintSections(data) {
  const s = {};
  const sid8 = (data.sid || '').slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);
  s.header = `COMPACT_STATE_V1 sid=${sid8} cwd=${data.cwd || ''} updated=${today}`;

  if (data.primaryRepo) {
    const r = data.primaryRepo;
    const subj = truncate(stripNonAscii(r.subj), 60);
    const repoLabel = data.repoLabel || path.basename(r.path);
    s.repo = `REPO:   ${repoLabel}  branch=${r.branch}  head=${r.sha7} "${subj}"`;
    if (r.dirtyCount > 0) {
      let files = r.dirtyFiles.slice(0, 6).join(', ');
      if (r.dirtyCount > 6) files += ` +${r.dirtyCount - 6} more`;
      s.dirty = `DIRTY:  ${r.dirtyCount} files (${files})`;
    }
    if (r.extraWorktrees && r.extraWorktrees.length) {
      s.worktrees = 'WORKTREES: ' + r.extraWorktrees
        .map(w => `${w.path}@${w.branch || '?'}`).join(', ');
    }
    if (r.recent && r.recent.length) {
      s.done = 'DONE-24H: ' + r.recent
        .map(l => stripNonAscii(l).replace(/\s+/g, ' '))
        .join(' | ');
    }
  }

  if (data.extraRepos && data.extraRepos.length) {
    const parts = data.extraRepos.map(r =>
      `${r.label || path.basename(r.path)}@${r.branch || '?'}@${r.sha7 || '?'}`);
    s.extraRepos = 'EXTRA-REPOS: ' + parts.join(', ');
  }

  const todos = data.todos || [];
  const inProg = todos.filter(t => t.status === 'in_progress');
  const pending = todos.filter(t => t.status === 'pending');
  const blocked = todos.filter(t => t.status === 'blocked');

  if (inProg.length) {
    const lines = inProg.slice(0, 8).map(t => {
      const title = truncate(stripNonAscii(t.title || ''), 100);
      const desc = truncate(stripNonAscii(firstLine(t.description || '')), 100);
      return desc ? `- [${t.id}] ${title} — ${desc}` : `- [${t.id}] ${title}`;
    });
    if (inProg.length > 8) lines.push(`+${inProg.length - 8} more`);
    s.inProgress = 'IN-PROGRESS:\n' + lines.join('\n');
  }
  if (pending.length) {
    const lines = pending.slice(0, 8).map(t =>
      `- [${t.id}] ${truncate(stripNonAscii(t.title || ''), 100)}`);
    if (pending.length > 8) lines.push(`+${pending.length - 8} more`);
    s.pending = 'PENDING:\n' + lines.join('\n');
  }
  if (blocked.length) {
    const lines = blocked.slice(0, 6).map(t => {
      const title = truncate(stripNonAscii(t.title || ''), 100);
      const desc = truncate(stripNonAscii(firstLine(t.description || '')), 80);
      return desc ? `- [${t.id}] ${title} — ${desc}` : `- [${t.id}] ${title}`;
    });
    if (blocked.length > 6) lines.push(`+${blocked.length - 6} more`);
    s.blocked = 'BLOCKED:\n' + lines.join('\n');
  }

  const nextText = data.planNext || data.compactNext || '';
  if (nextText) {
    s.next = 'NEXT:\n' + truncate(stripNonAscii(nextText).trim(), 600);
  }

  if (data.constitutionLoaded) {
    s.rules = 'CONSTITUTION: see .github/copilot-instructions.md';
  } else {
    const allRules = [...(data.globalRules || []), ...(data.sessionRules || [])];
    if (allRules.length) {
      s.rules = 'RULES:\n' + allRules
        .map(r => `- ${stripNonAscii(r)}`)
        .join('\n');
    }
  }

  if (data.compactNotes) {
    s.pinned = 'PINNED: ' + truncate(stripNonAscii(data.compactNotes), 400);
  }

  if (data.checkpoints && data.checkpoints.length) {
    s.checkpoints = 'CHECKPOINTS: ' + data.checkpoints
      .map(c => stripNonAscii(c)).join(' | ');
  }

  return s;
}

const SECTION_ORDER = [
  'header', 'repo', 'dirty', 'worktrees', 'extraRepos',
  'inProgress', 'pending', 'blocked',
  'done', 'next', 'rules', 'pinned', 'checkpoints',
];

export function renderHint(sections) {
  const parts = [];
  for (const key of SECTION_ORDER) {
    if (sections[key]) parts.push(sections[key]);
  }
  let out = parts.join('\n\n');
  out = stripNonAscii(out);
  if (out.length > MAX_HINT) {
    const marker = '\n[TRUNCATED — see session files for full state]';
    out = out.slice(0, MAX_HINT - marker.length) + marker;
  }
  return out;
}

/**
 * Copy text to clipboard using the first available platform tool.
 * Returns the tool name used, or null if none available.
 * @param {string} text
 */
function copyToClipboard(text) {
  const candidates = detectClipboardCandidates();
  for (const { cmd, args } of candidates) {
    try {
      execFileSync(cmd, args, {
        input: text,
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 3000,
      });
      return cmd;
    } catch { /* not available or failed — try next */ }
  }
  return null;
}

// ─── collect all data ─────────────────────────────────────────
function collectData(sid, sessionDir) {
  const wsRaw = tryRead(path.join(sessionDir, 'workspace.yaml'));
  if (wsRaw === null) {
    console.error('compact-prepare: cannot read workspace.yaml at ' + sessionDir);
    process.exit(4);
  }
  const ws = parseWorkspaceYaml(wsRaw);
  const cwd = ws.cwd || process.cwd();
  const gitRoot = ws.git_root || cwd;

  const compactRaw = tryRead(path.join(sessionDir, 'compact.yaml'));
  const compact = parseCompactYaml(compactRaw || '');

  const defaultsRaw = tryRead(path.join(HOME, '.copilot', 'compact.defaults.yaml'));
  const defaults = parseGlobalDefaults(defaultsRaw || '');

  const primary = repoInfo(gitRoot);
  const extraRepos = [];
  for (const r of compact.repos) {
    let p = r.path;
    if (!p) continue;
    if (p.startsWith('~')) p = path.join(HOME, p.slice(1));
    if (path.resolve(p) === path.resolve(gitRoot)) continue;
    const info = repoInfo(p);
    if (info) extraRepos.push({ ...info, label: r.label });
  }

  const todos = loadTodos(sessionDir);
  const plan = loadPlanNext(sessionDir);
  const checkpoints = loadCheckpoints(sessionDir);

  const constitutionLoaded = existsSync(path.join(gitRoot, '.github', 'copilot-instructions.md'));

  return {
    sid,
    sessionDir,
    cwd,
    gitRoot,
    workspace: ws,
    repoLabel: ws.repository,
    primaryRepo: primary,
    extraRepos,
    todos,
    plan,
    planNext: plan.next,
    compactNext: compact.next,
    compactNotes: compact.notes,
    sessionRules: compact.rules,
    globalRules: defaults.rules,
    checkpoints,
    constitutionLoaded,
  };
}

// ─── output modes ─────────────────────────────────────────────
function dashboard(data, hintChars) {
  const bar = '='.repeat(64);
  const name = data.workspace.name || path.basename(data.cwd);
  const sid8 = (data.sid || '').slice(0, 8);
  console.log(bar);
  console.log(`  compact-prepare — session ${name} (${sid8})`);
  console.log(bar);
  if (data.primaryRepo) {
    console.log(`  Repo:     ${data.repoLabel || path.basename(data.primaryRepo.path)} @ ${data.primaryRepo.branch}  head=${data.primaryRepo.sha7}`);
    console.log(`  Dirty:    ${data.primaryRepo.dirtyCount} files`);
  } else {
    console.log('  Repo:     (not a git repo)');
  }
  const inProg = data.todos.filter(t => t.status === 'in_progress').length;
  const pending = data.todos.filter(t => t.status === 'pending').length;
  const blocked = data.todos.filter(t => t.status === 'blocked').length;
  console.log(`  Todos:    ${inProg} in-progress / ${pending} pending / ${blocked} blocked`);
  if (data.plan.path) {
    console.log(`  Plan:     ${data.plan.path} (${data.plan.lines} lines)`);
  } else {
    console.log('  Plan:     not found');
  }
  if (data.constitutionLoaded) {
    console.log('  Rules:    from constitution');
  } else {
    const g = data.globalRules.length;
    const s = data.sessionRules.length;
    console.log(`  Rules:    ${g + s} (${g} global + ${s} session)`);
  }
  console.log(`  Hint:     ${hintChars} chars`);
}

function modePrepare(data) {
  const sections = buildHintSections(data);
  const hint = renderHint(sections);
  dashboard(data, hint.length);
  console.log('-'.repeat(64));
  console.log('  SESSION STATE BRIEF — agent, use this + your session memory');
  console.log('  to compose the actual compact hint (HARD CAP: 4000 chars).');
  console.log('-'.repeat(64));
  console.log('');
  console.log('<<<SESSION_STATE_BRIEF>>>');
  console.log(hint);
  console.log('<<<END_SESSION_STATE_BRIEF>>>');
  console.log('');
  console.log('-'.repeat(64));
  console.log('  Agent instructions:');
  console.log('  1. Read the SESSION STATE BRIEF above (facts).');
  console.log('  2. Compose the actual /compact hint using your session memory.');
  console.log(`  3. HARD LIMIT: hint body must be ≤${MAX_HINT} chars.`);
  console.log('     Copilot CLI enforces this — exceeding it aborts /compact');
  console.log('     with: "customInstructions exceeds maximum length of 4000"');
  console.log(`  4. Write the hint to: ~/.copilot/session-state/$COPILOT_AGENT_SESSION_ID/files/compact-hint.txt`);
  console.log('     Then run:');
  console.log('       node ~/.copilot/skills/myelin-compact/compact-prepare.mjs clipboard \\');
  console.log('         ~/.copilot/session-state/$COPILOT_AGENT_SESSION_ID/files/compact-hint.txt');
  console.log('     This enforces the cap, copies /compact <hint> to clipboard,');
  console.log('     and prints the full ready-to-run command.');
  console.log('='.repeat(64));
}

/**
 * clipboard mode: reads a hint from a file path (argv[3]),
 * enforces the 4000-char hard cap, prepends "/compact ",
 * tries to copy to clipboard, and prints the full ready-to-run command.
 */
function modeClipboard(hintFile) {
  if (!hintFile) {
    console.error('compact-prepare clipboard: missing file path argument');
    console.error('Usage: compact-prepare.mjs clipboard <path-to-hint-file>');
    process.exit(1);
  }
  if (!existsSync(hintFile)) {
    console.error(`compact-prepare clipboard: file not found: ${hintFile}`);
    process.exit(1);
  }

  let hint;
  try {
    hint = readFileSync(hintFile, 'utf8').trim();
  } catch (err) {
    console.error(`compact-prepare clipboard: cannot read file: ${err.message}`);
    process.exit(1);
  }
  hint = stripNonAscii(hint);

  // Hard-enforce the 4000-char cap — prevent "customInstructions exceeds
  // maximum length" abort. Cache original length before any truncation.
  const originalLength = hint.length;
  if (hint.length > MAX_HINT) {
    console.error(
      `compact-prepare clipboard: hint is ${originalLength} chars; `
      + `maximum is ${MAX_HINT}. Edit ${hintFile} and try again.`,
    );
    process.exitCode = 2;
    return;
  }

  const fullCommand = `/compact ${hint}`;

  // Try to copy to clipboard
  const tool = copyToClipboard(fullCommand);
  if (tool) {
    console.log(`✓ Copied to clipboard (${tool})`);
  } else {
    console.log('⚠  Clipboard unavailable — copy the command below manually.');
  }

  console.log('─'.repeat(64));
  console.log(`  Hint: ${hint.length}/${MAX_HINT} chars`);
  console.log('  Paste this as your next message:');
  console.log('─'.repeat(64));
  console.log('');
  console.log(fullCommand);
  console.log('');
  console.log('─'.repeat(64));
  console.log('  After /compact completes, run:');
  console.log('    node ~/.copilot/skills/myelin-compact/compact-prepare.mjs resume');
  console.log('─'.repeat(64));
}

function modeEmit(data) {
  const sections = buildHintSections(data);
  const hint = renderHint(sections);
  process.stdout.write(hint + '\n');
}

function modeResume(data) {
  const sections = buildHintSections(data);
  const hint = renderHint(sections);
  console.log('─'.repeat(64));
  console.log('  ── CONTEXT RESTORED ──');
  console.log('─'.repeat(64));
  dashboard(data, hint.length);
  console.log('─'.repeat(64));
  const inProg = data.todos.filter(t => t.status === 'in_progress');
  if (inProg.length) {
    const t = inProg[0];
    const title = truncate(stripNonAscii(t.title || ''), 100);
    const desc = truncate(stripNonAscii(firstLine(t.description || '')), 80);
    if (desc) console.log(`  Top priority: ${title} — ${desc}`);
    else console.log(`  Top priority: ${title}`);
  } else {
    const nextText = firstLine((data.planNext || data.compactNext || '').trim());
    if (nextText) console.log(`  No in-progress todos. Next: ${truncate(nextText, 200)}`);
    else console.log('  No in-progress todos. No next-action recorded.');
  }
  console.log('─'.repeat(64));
}

// ─── main ─────────────────────────────────────────────────────
function main() {
  const mode = process.argv[2] || 'prepare';
  if (!['prepare', 'emit', 'resume', 'clipboard'].includes(mode)) {
    console.error(`compact-prepare: unknown mode "${mode}" (expected prepare|emit|resume|clipboard)`);
    process.exit(1);
  }

  if (mode === 'clipboard') {
    modeClipboard(process.argv[3]);
    return;
  }

  const sid = resolveSessionId();
  if (!sid) {
    console.error('compact-prepare: cannot resolve session — COPILOT_AGENT_SESSION_ID not set and no session matches cwd');
    process.exit(2);
  }
  const sessionDir = path.join(SESSION_ROOT, sid);
  if (!existsSync(sessionDir)) {
    console.error(`compact-prepare: session directory missing: ${sessionDir}`);
    process.exit(3);
  }

  const data = collectData(sid, sessionDir);

  if (mode === 'prepare') modePrepare(data);
  else if (mode === 'emit') modeEmit(data);
  else if (mode === 'resume') modeResume(data);
}

// Only run main if invoked directly (not imported for tests).
// Use realpathSync on argv[1] so symlinks are resolved before comparing
// against import.meta.url (which Node.js always resolves to the real path).
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const _scriptReal = fileURLToPath(import.meta.url);
const _argvReal = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return path.resolve(process.argv[1]); } })() : '';
const isDirect = _argvReal === _scriptReal;
if (isDirect) main();

export { resolveSessionId, collectData, loadTodos, loadPlanNext, loadCheckpoints, repoInfo, MAX_HINT };
