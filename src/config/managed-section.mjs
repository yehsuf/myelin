// Shared helper for writing/updating a delimited "managed section" inside a
// user-owned file (e.g. ~/.claude/CLAUDE.md, repo-level AGENTS.md) without
// clobbering any content the user added outside the markers. Re-running with
// new content replaces only what's between the markers; a backup of the
// previous file is kept alongside it.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANAGED_SECTION_START = '<!-- >>> myelin managed >>> -->';
export const MANAGED_SECTION_END = '<!-- <<< myelin managed <<< -->';

// Pre-2026-07-08 installs used shell-style `#` markers even inside Markdown
// files (CLAUDE.md/AGENTS.md), which rendered as a literal H1 heading.
// Recognise the old markers on read so existing installs get cleanly
// migrated to the HTML-comment style in place, instead of accumulating a
// duplicate block every re-run.
const LEGACY_START = '# >>> myelin managed >>>';
const LEGACY_END = '# <<< myelin managed <<<';

export function writeManagedSection(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  let existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const block = `${MANAGED_SECTION_START}\n${content}\n${MANAGED_SECTION_END}`;

  let si = existing.indexOf(MANAGED_SECTION_START);
  let ei = existing.indexOf(MANAGED_SECTION_END);
  let endLen = MANAGED_SECTION_END.length;
  if (si === -1 || ei === -1) {
    const lsi = existing.indexOf(LEGACY_START);
    const lei = existing.indexOf(LEGACY_END);
    if (lsi !== -1 && lei !== -1) { si = lsi; ei = lei; endLen = LEGACY_END.length; }
  }

  if (si !== -1 && ei !== -1) {
    existing = existing.slice(0, si) + block + existing.slice(ei + endLen);
  } else {
    existing = existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + (existing ? '\n' : '') + block + '\n';
  }
  if (existsSync(filePath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try { copyFileSync(filePath, `${filePath}.bak.${ts}`); } catch { /* best-effort backup */ }
  }
  writeFileSync(filePath, existing, 'utf8');
}
