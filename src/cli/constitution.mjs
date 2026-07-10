import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STABLE_SECTIONS = [
  'Identity',
  'Architecture invariants',
  'Standing rules',
  'Technology',
  'Key file map',
];

const VOLATILE_SECTIONS = ['Blocked', 'Shipped', 'Deferred', 'Done'];

const CONSTITUTION_REL = '.github/copilot-instructions.md';
const LOCK_REL = '.github/.constitution.lock';

// ---------- helpers ----------

function walkUp(startDir) {
  const dirs = [];
  let d = resolve(startDir);
  while (true) {
    dirs.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return dirs;
}

export function findConstitutionFile(startDir) {
  for (const d of walkUp(startDir)) {
    const p = join(d, CONSTITUTION_REL);
    if (existsSync(p)) return p;
  }
  return null;
}

function findGitRoot(startDir) {
  for (const d of walkUp(startDir)) {
    if (existsSync(join(d, '.git'))) return d;
  }
  return null;
}

export function computeSha256(filepath) {
  const buf = readFileSync(filepath);
  return createHash('sha256').update(buf).digest('hex');
}

function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------- section parsing ----------

export function parseConstitutionSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { name: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ name: s.name, content: s.lines.join('\n') }));
}

// ---------- similarity ----------

function tokenize(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

export function similarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

// ---------- check ----------

const SECRET_PATTERNS = [
  { name: 'AWS access key', re: /AKIA[A-Z0-9]{16}/ },
  { name: 'PEM header', re: /-----BEGIN [A-Z ]+-----/ },
  { name: 'generic api key', re: /api[_-]?key\s*[:=]\s*\S{8,}/i },
  // threshold 65+ to skip SHA-1 (40 chars) and SHA-256 (64 chars) which appear in key-file-map entries
  { name: 'long hex token', re: /(?<!sha256:|commit\s|head=)[a-fA-F0-9]{65,}/i },
];

export function checkConstitution(text) {
  const errors = [];
  const warnings = [];

  if (!text.startsWith('<!-- CONSTITUTION v1')) {
    warnings.push('missing "<!-- CONSTITUTION v1" header marker');
  }

  const sections = parseConstitutionSections(text);
  const present = new Set(sections.map((s) => s.name));

  for (const req of STABLE_SECTIONS) {
    if (!present.has(req)) {
      warnings.push(`missing stable section: ## ${req}`);
    }
  }

  for (const vol of VOLATILE_SECTIONS) {
    if (present.has(vol)) {
      warnings.push(`volatile section present (belongs in compact hint): ## ${vol}`);
    }
  }

  if (Buffer.byteLength(text, 'utf8') < 1024) {
    warnings.push(`file is small (<1024 bytes) — likely under-filled`);
  }

  for (const { name, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      errors.push(`secret detected (${name}): "${m[0].slice(0, 40)}…" — remove before committing`);
    }
  }

  return { errors, warnings };
}

// ---------- append ----------

function findSectionRange(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const target = sectionName.toLowerCase();
  let startIdx = -1;
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (startIdx === -1 && m[1].trim().toLowerCase() === target) {
        startIdx = i;
      } else if (startIdx !== -1) {
        endIdx = i;
        break;
      }
    }
  }
  return { startIdx, endIdx, lines };
}

function resolveStableSection(input) {
  const q = String(input).trim().toLowerCase();
  const exact = STABLE_SECTIONS.find((s) => s.toLowerCase() === q);
  if (exact) return exact;
  const prefix = STABLE_SECTIONS.filter((s) => s.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];
  const contains = STABLE_SECTIONS.filter((s) => s.toLowerCase().includes(q));
  if (contains.length === 1) return contains[0];
  // token-based (e.g. "inv" -> "Architecture invariants")
  const tokenMatch = STABLE_SECTIONS.filter((s) =>
    s.toLowerCase().split(/\s+/).some((tok) => tok.startsWith(q)),
  );
  if (tokenMatch.length === 1) return tokenMatch[0];
  return null;
}

function extractBullets(sectionContent) {
  const bullets = [];
  for (const line of sectionContent.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.*)$/);
    if (m) {
      const body = m[1].trim();
      if (body.startsWith('<!--')) continue; // skip placeholder comments
      bullets.push(body);
    }
  }
  return bullets;
}

export function appendBullet(text, section, bullet, force = false) {
  const resolvedSection = resolveStableSection(section);
  if (!resolvedSection) {
    return {
      newText: text,
      added: false,
      reason: `unknown section "${section}" — must be one of: ${STABLE_SECTIONS.join(', ')}`,
    };
  }

  const { startIdx, endIdx, lines } = findSectionRange(text, resolvedSection);
  if (startIdx === -1) {
    return { newText: text, added: false, reason: `section "## ${resolvedSection}" not found in file` };
  }

  const sectionLines = lines.slice(startIdx + 1, endIdx);
  const sectionContent = sectionLines.join('\n');
  const existing = extractBullets(sectionContent);

  const cleanBullet = bullet.trim();
  if (existing.some((b) => b === cleanBullet)) {
    return { newText: text, added: false, reason: 'already present, skipping', section: resolvedSection };
  }

  if (!force) {
    for (const b of existing) {
      const sim = similarity(b, cleanBullet);
      if (sim >= 0.7) {
        return {
          newText: text,
          added: false,
          reason: `similar entry exists: "${b}" — use --force to add anyway`,
          section: resolvedSection,
        };
      }
    }
  }

  // Find last non-empty line in section to insert after
  let insertAt = endIdx;
  while (insertAt > startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const newLines = [...lines.slice(0, insertAt), `- ${cleanBullet}`, ...lines.slice(insertAt)];
  return {
    newText: newLines.join('\n'),
    added: true,
    reason: null,
    section: resolvedSection,
    bullet: cleanBullet,
  };
}

// ---------- init ----------

function loadTemplate() {
  const p = join(__dirname, 'constitution-template.md');
  return readFileSync(p, 'utf8');
}

function inferProjectInfo(gitRoot) {
  let name = '';
  let ownerRepo = '';
  try {
    name = execSync('git rev-parse --show-toplevel', { cwd: gitRoot, encoding: 'utf8' }).trim();
    name = name.split(/[\\/]/).pop() || '';
  } catch {}
  try {
    const url = execSync('git remote get-url origin', { cwd: gitRoot, encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m) ownerRepo = `${m[1]}/${m[2]}`;
  } catch {}
  return { name: name || '<PROJECT_NAME>', ownerRepo: ownerRepo || '<OWNER/REPO>' };
}

function fillTemplate(tpl, { name, ownerRepo }) {
  return tpl
    .replace(/<PROJECT_NAME>/g, name)
    .replace(/<OWNER\/REPO>/g, ownerRepo);
}

// ---------- gitignore check ----------

function isInGitignore(gitRoot, relPath) {
  const gi = join(gitRoot, '.gitignore');
  if (!existsSync(gi)) return false;
  const lines = readFileSync(gi, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // simple exact / prefix / glob match
    if (line === relPath) return true;
    if (line === '/' + relPath) return true;
    if (line === '.github/' && relPath.startsWith('.github/')) return true;
    if (line === '.github' && relPath.startsWith('.github/')) return true;
    if (line === '*.md' && relPath.endsWith('.md')) return true;
  }
  return false;
}

// ---------- commands ----------

function resolveRepoRoot(repoFlag, requireConstitution) {
  const start = repoFlag ? (isAbsolute(repoFlag) ? repoFlag : resolve(process.cwd(), repoFlag)) : process.cwd();
  if (requireConstitution) {
    const cf = findConstitutionFile(start);
    if (cf) {
      // Prefer the actual git root over dirname(dirname(cf)) for nested-repo safety
      const derivedRoot = dirname(dirname(cf));
      const gitRoot = existsSync(join(derivedRoot, '.git')) ? derivedRoot : (findGitRoot(start) ?? derivedRoot);
      return { gitRoot, constitutionPath: cf };
    }
    // fall back to git root
    const gr = findGitRoot(start);
    return gr ? { gitRoot: gr, constitutionPath: join(gr, CONSTITUTION_REL) } : null;
  }
  const gr = findGitRoot(start);
  return gr ? { gitRoot: gr, constitutionPath: join(gr, CONSTITUTION_REL) } : null;
}

export function cmdInit(opts = {}) {
  const found = resolveRepoRoot(opts.repo, false);
  if (!found) {
    console.error('error: no .git directory found (walked up from cwd). Use --repo <path>.');
    return 1;
  }
  const { gitRoot, constitutionPath } = found;
  if (existsSync(constitutionPath)) {
    console.log(`already exists at ${constitutionPath}`);
    return 0;
  }
  mkdirSync(dirname(constitutionPath), { recursive: true });
  const info = inferProjectInfo(gitRoot);
  const filled = fillTemplate(loadTemplate(), info);
  writeFileSync(constitutionPath, filled, 'utf8');
  console.log(`Created ${CONSTITUTION_REL} — edit to fill in Architecture invariants and Standing rules`);
  return 0;
}

export function cmdShow(opts = {}) {
  const found = resolveRepoRoot(opts.repo, true);
  if (!found || !existsSync(found.constitutionPath)) {
    console.error(`error: no ${CONSTITUTION_REL} found (walked up from cwd)`);
    return 1;
  }
  const text = readFileSync(found.constitutionPath, 'utf8');
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
  const hash = computeSha256(found.constitutionPath);
  console.log(`sha256: ${hash}`);
  return 0;
}

export function cmdCheck(opts = {}) {
  const found = resolveRepoRoot(opts.repo, true);
  if (!found || !existsSync(found.constitutionPath)) {
    console.error(`error: no ${CONSTITUTION_REL} found (walked up from cwd)`);
    return 2;
  }
  const { gitRoot, constitutionPath } = found;
  const text = readFileSync(constitutionPath, 'utf8');
  const { errors, warnings } = checkConstitution(text);

  if (isInGitignore(gitRoot, CONSTITUTION_REL)) {
    errors.push(`${CONSTITUTION_REL} is in .gitignore — constitution must be committed`);
  }

  for (const w of warnings) console.log(`WARN: ${w}`);
  for (const e of errors) console.log(`ERROR: ${e}`);

  if (errors.length > 0) return 2;
  if (warnings.length > 0) return 1;
  console.log(`OK: ${constitutionPath} passed all checks`);
  return 0;
}

export function cmdAppend(section, bullet, opts = {}) {
  if (!section || !bullet) {
    console.error('usage: myelin constitution append <section> <bullet>');
    return 1;
  }
  const found = resolveRepoRoot(opts.repo, true);
  if (!found || !existsSync(found.constitutionPath)) {
    console.error(`error: no ${CONSTITUTION_REL} found (walked up from cwd)`);
    return 1;
  }
  const { gitRoot, constitutionPath } = found;
  const text = readFileSync(constitutionPath, 'utf8');
  const result = appendBullet(text, section, bullet, Boolean(opts.force));

  if (!result.added) {
    console.log(result.reason);
    return result.reason === 'already present, skipping' ? 0 : 1;
  }

  writeFileSync(constitutionPath, result.newText, 'utf8');

  const lockPath = join(gitRoot, LOCK_REL);
  if (existsSync(lockPath)) {
    const hash = sha256Bytes(Buffer.from(result.newText, 'utf8'));
    writeFileSync(lockPath, `sha256:${hash}\n`, 'utf8');
  }
  console.log(`Added to ## ${result.section}: - ${result.bullet}`);
  return 0;
}

export function cmdLock(opts = {}) {
  const found = resolveRepoRoot(opts.repo, true);
  if (!found || !existsSync(found.constitutionPath)) {
    console.error(`error: no ${CONSTITUTION_REL} found (walked up from cwd)`);
    return 1;
  }
  const { gitRoot, constitutionPath } = found;
  const hash = computeSha256(constitutionPath);
  const lockPath = join(gitRoot, LOCK_REL);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `sha256:${hash}\n`, 'utf8');
  console.log(`lock updated: sha256:${hash}`);
  return 0;
}

// ---------- argv dispatch ----------

function parseFlags(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      opts.force = true;
    } else if (a === '--repo') {
      opts.repo = argv[++i];
    } else if (a.startsWith('--repo=')) {
      opts.repo = a.slice(7);
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

export function runConstitutionCLI(argv) {
  const { positional, opts } = parseFlags(argv);
  const sub = positional[0];
  switch (sub) {
    case 'init':
      return cmdInit(opts);
    case 'show':
      return cmdShow(opts);
    case 'check':
      return cmdCheck(opts);
    case 'append':
      return cmdAppend(positional[1], positional[2], opts);
    case 'lock':
      return cmdLock(opts);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(
        [
          'usage: myelin constitution <subcommand> [--repo <path>]',
          '',
          'subcommands:',
          '  init                          create .github/copilot-instructions.md from template',
          '  show                          print constitution + sha256',
          '  check                         validate structure, size, no volatile sections, no secrets',
          '  append <section> <bullet>     add a bullet to a stable section (idempotent)',
          '  lock                          write .github/.constitution.lock with current sha256',
          '',
          'stable sections: ' + STABLE_SECTIONS.join(', '),
        ].join('\n'),
      );
      return 0;
    default:
      console.error(`unknown subcommand: ${sub}`);
      return 1;
  }
}

// Direct-run entrypoint (only when invoked as `node constitution.mjs`)
import { realpathSync } from 'node:fs';
function isDirectRun() {
  try {
    const invoked = realpathSync(process.argv[1] || '');
    const self = realpathSync(fileURLToPath(import.meta.url));
    return invoked === self;
  } catch {
    return false;
  }
}
if (isDirectRun()) {
  const code = runConstitutionCLI(process.argv.slice(2));
  process.exit(code);
}
