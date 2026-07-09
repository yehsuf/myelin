export function shouldWarnOnRawShellSearchCommand(command = '') {
  const rawTools = new Set(['cat', 'grep', 'find', 'head', 'tail', 'wc']);
  const passthroughCommands = new Set(['env', 'command', 'builtin']);
  const commandSeparators = new Set([';', '&', '&&', '||', '|', '|&', '(', ')']);

  function isAssignmentWord(word) {
    return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
  }

  function normalizeCommandWord(word) {
    return word.split(/[\\/]/).at(-1)?.replace(/\.(exe|cmd|bat|ps1)$/i, '') ?? word;
  }

  function tokenize(input) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escaped = false;

    const pushWord = () => {
      if (!current) return;
      tokens.push({ type: 'word', value: current });
      current = '';
    };

    const pushOperator = (value) => {
      pushWord();
      tokens.push({ type: 'operator', value });
    };

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      const next = input[i + 1];

      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }

      if (quote) {
        if (ch === '\\' && quote === '"') {
          escaped = true;
          continue;
        }
        if (ch === quote) {
          quote = null;
          continue;
        }
        current += ch;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quote = ch;
        continue;
      }

      if (ch === '\n') {
        pushOperator(';');
        continue;
      }
      if (/\s/.test(ch)) {
        pushWord();
        continue;
      }

      if ((ch === '&' || ch === '|') && next === ch) {
        pushOperator(ch + next);
        i += 1;
        continue;
      }
      if (ch === '|' && next === '&') {
        pushOperator('|&');
        i += 1;
        continue;
      }
      if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '&') {
        pushOperator(ch);
        continue;
      }

      current += ch;
    }

    pushWord();
    return tokens;
  }

  let expectCommand = true;
  let passthrough = false;

  for (const token of tokenize(String(command))) {
    if (token.type === 'operator') {
      if (commandSeparators.has(token.value)) {
        expectCommand = true;
        passthrough = false;
      }
      continue;
    }

    const word = token.value;
    const normalized = normalizeCommandWord(word);
    if (!expectCommand) continue;

    if (passthrough) {
      if (passthroughCommands.has(normalized)) continue;
      if (word === '--' || word.startsWith('-') || isAssignmentWord(word)) continue;
      if (rawTools.has(normalized)) return true;
      if (normalized === 'rtk') {
        expectCommand = false;
        passthrough = false;
        continue;
      }
      expectCommand = false;
      passthrough = false;
      continue;
    }

    if (isAssignmentWord(word)) continue;
    if (passthroughCommands.has(normalized)) {
      passthrough = true;
      continue;
    }
    if (rawTools.has(normalized)) return true;
    expectCommand = false;
  }

  return false;
}

export function buildBashBanRawHookSource() {
  return `#!/usr/bin/env node
// Myelin: advisory warning on raw cat/grep/find in Bash
import { readFileSync } from 'node:fs';
${shouldWarnOnRawShellSearchCommand.toString()}
let input = {};
try { input = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}
if (input?.tool_name === 'Bash') {
  const cmd = input?.tool_input?.command ?? '';
  if (shouldWarnOnRawShellSearchCommand(cmd)) {
    process.stderr.write('[myelin] Prefer serena_search_for_pattern_in_files over raw shell search.\\n');
  }
}
process.exit(0);
`;
}
