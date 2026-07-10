#!/usr/bin/env node
/**
 * myelin compact-resume — post-compact context re-orientation.
 *
 * Run immediately after /compact to re-establish the full working context.
 * Reads live git state from both repos and prints a structured summary.
 *
 * Usage:
 *   node ~/tokenstack/src/cli/compact-resume.mjs
 *   myelin compact-resume   (once wired into index.mjs)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? '';

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '(unavailable)';
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── headroom-lite ──────────────────────────────────────────────
const hlDir = path.join(HOME, 'Work', 'headroom-lite');
if (existsSync(hlDir)) {
  section('headroom-lite  (yehsuf/headroom-lite)');
  console.log('  Commit:  ', run('git log --oneline -1', hlDir));
  console.log('  Branch:  ', run('git branch --show-current', hlDir));

  // Package version
  try {
    const pkg = JSON.parse(readFileSync(path.join(hlDir, 'package.json'), 'utf8'));
    console.log('  Package: ', `${pkg.name}  v${pkg.version}`);
  } catch { /* skip */ }

  // Test count (quick — just count files, don't run)
  const testFiles = run('ls test/*.test.mjs | wc -l', hlDir);
  console.log('  Tests:    ~', testFiles.trim(), 'test files (run: node --test test/**/*.test.mjs)');

  console.log('\n  SHIPPED features:');
  [
    'Phase 1: /v1/compress sidecar (Anthropic format)',
    'Phase 2: transparent HTTP/HTTPS proxy (auth opaque, SSE raw-piped, RFC 7230)',
    'P0: frozen-prefix guard  P1: tool-normalization  P2: volatile-detector  P3: drift-detector',
    'Tag protector · JSON minifier · diff-noise filter',
    'OAI prompt_cache_key (opt-in) · live-zone compression (HEADROOM_LITE_COMPRESS_PROXY=true)',
    'GitHub Package @yehsuf/headroom-lite v0.3.0 — publishes on v* tag push',
  ].forEach(f => console.log('    ✔', f));
} else {
  console.log('\n  ⚠  ~/Work/headroom-lite not found');
}

// ── tokenstack ────────────────────────────────────────────────
const tsDir = path.join(HOME, 'tokenstack');
if (existsSync(tsDir)) {
  section('tokenstack  (yehsuf/myelin)');
  console.log('  Commit: ', run('git log --oneline -1', tsDir));
  console.log('  Branch: ', run('git branch --show-current', tsDir));
  const testFiles = run('ls test/*.test.mjs 2>/dev/null | wc -l', tsDir);
  console.log('  Tests:  ~', testFiles.trim(), 'test files');
} else {
  console.log('\n  ⚠  ~/tokenstack not found');
}

// ── NEXT ACTION ───────────────────────────────────────────────
section('NEXT SPRINT — Microsoft models multi-provider');
console.log(`
  Architecture approved by Opus 4.7 + GPT-5.5. Ready to implement.

  ENV API:
    HEADROOM_LITE_UPSTREAM_ANTHROPIC=https://api.anthropic.com
    HEADROOM_LITE_UPSTREAM_OPENAI=https://{resource}.openai.azure.com
    HEADROOM_LITE_UPSTREAM_GITHUB_MODELS=https://models.github.ai/inference
    HEADROOM_LITE_COMPRESS=live

  5-PR order:
    1. src/providers/detect.mjs   — path routing table
    2. Multi-upstream env wiring  — per-provider upstream
    3. format:'openai' flag       — frozenCount=0 for OpenAI
    4. Live-zone compress toggle  — HEADROOM_LITE_COMPRESS=live
    5. README provider matrix     — docs

  Start with: "implement Microsoft models multi-provider sprint"
`);

// ── BLOCKED ───────────────────────────────────────────────────
section('BLOCKED (need explicit go-ahead each time)');
console.log(`
    • Headroom physical removal from tlv-mp57i
    • Live cutover: rewire copilot_addon.py :8787 → :8790 + restart mitm
    • Windows tokenstack real-hardware activation
`);

// ── RULES ─────────────────────────────────────────────────────
section('Standing rules (carry forward always)');
console.log(`
    • Never act without explicit per-action approval
    • All changes: implement → test → 3-model review → fix → merge
    • Parallel agents MUST use separate git worktrees (never share checkouts)
    • Auth headers always fully opaque — never read/classify/rewrite
    • SSE responses always raw-piped — never buffer
    • headroom-lite is THE solution — standalone service, no mitmproxy
`);

console.log('─'.repeat(60));
console.log('  Context restored. Ready to continue.\n');
