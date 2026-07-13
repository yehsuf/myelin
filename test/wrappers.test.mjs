import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCopilotWrapper,
  buildClaudeWrapper,
  buildServiceEnvUnsetLines,
  COPILOT_FORBIDDEN_ENV,
  CLAUDE_FORBIDDEN_ENV,
  SERVER_FORBIDDEN_ENV,
} from '../src/service/wrappers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const platforms = ['windows', 'darwin', 'linux'];

/**
 * Return true when `wrapperText` contains an ASSIGNMENT of `varName` to a
 * value (as opposed to a mention inside an `unset`, `env -u`, `$null`
 * clear, or save/restore of the surrounding shell state).
 */
function assignsVar(wrapperText, varName) {
  // Windows: `$env:X = "..."` or `$env:X = '...'` with non-empty content.
  // Excludes `$env:X = $null` (clear) and `$env:X = $saved_X` (restore).
  const winAssign = new RegExp(`\\$env:${varName}\\s*=\\s*["'][^"']+["']`);
  if (winAssign.test(wrapperText)) return true;
  // POSIX: strip out `-u X` unset flags first, then look for `X=value`.
  const stripped = wrapperText.replace(new RegExp(`-u\\s+${varName}\\b`, 'g'), '');
  const posixAssign = new RegExp(`(^|\\s|;)(export\\s+)?${varName}=[^\\s\\\\;]`);
  return posixAssign.test(stripped);
}

// -----------------------------------------------------------------------------
// Provider isolation — the CORE invariant.
// -----------------------------------------------------------------------------

describe('wrappers — Claude never pollutes Copilot', () => {
  for (const os of platforms) {
    it(`_copilot (${os}) never ASSIGNS ANTHROPIC_BASE_URL (unsets are allowed)`, () => {
      const w = buildCopilotWrapper({ os });
      assert.ok(!assignsVar(w, 'ANTHROPIC_BASE_URL'),
        `_copilot must NOT set ANTHROPIC_BASE_URL — it would route Copilot's Anthropic-SDK calls to headroom, bypassing mitmproxy.`);
    });
    it(`_copilot (${os}) never ASSIGNS ENABLE_PROMPT_CACHING_1H`, () => {
      const w = buildCopilotWrapper({ os });
      assert.ok(!assignsVar(w, 'ENABLE_PROMPT_CACHING_1H'));
    });
    it(`_copilot (${os}) ACTIVELY UNSETS forbidden Anthropic vars (defense against inherited shell env)`, () => {
      const w = buildCopilotWrapper({ os });
      for (const v of COPILOT_FORBIDDEN_ENV) {
        // Windows uses save-and-restore; POSIX uses `env -u`
        const hasWinUnset = w.includes(`$env:${v} = $null`);
        const hasPosixUnset = w.includes(`-u ${v}`);
        assert.ok(hasWinUnset || hasPosixUnset,
          `_copilot must unset '${v}' in its wrapper so an inherited value cannot leak into copilot.`);
      }
    });
  }
});

describe('wrappers — Copilot never pollutes Claude', () => {
  for (const os of platforms) {
    it(`_claude (${os}) never ASSIGNS HTTPS_PROXY`, () => {
      const w = buildClaudeWrapper({ os });
      assert.ok(!assignsVar(w, 'HTTPS_PROXY'),
        `_claude must NOT set HTTPS_PROXY — would double-route Claude through mitmproxy.`);
    });
    it(`_claude (${os}) never ASSIGNS NO_PROXY`, () => {
      const w = buildClaudeWrapper({ os });
      assert.ok(!assignsVar(w, 'NO_PROXY'));
    });
    it(`_claude (${os}) ACTIVELY UNSETS forbidden Copilot vars (defense against inherited shell env)`, () => {
      const w = buildClaudeWrapper({ os });
      for (const v of CLAUDE_FORBIDDEN_ENV) {
        const hasWinUnset = w.includes(`$env:${v} = $null`);
        const hasPosixUnset = w.includes(`-u ${v}`);
        assert.ok(hasWinUnset || hasPosixUnset,
          `_claude must unset '${v}' in its wrapper so an inherited value cannot leak into claude.`);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Correctness — each wrapper sets what it should set.
// -----------------------------------------------------------------------------

describe('_copilot wrapper — sets its own env per-invocation', () => {
  for (const os of platforms) {
    describe(os, () => {
      const w = buildCopilotWrapper({ os });
      it('sets HTTPS_PROXY pointing at mitmproxy port', () => {
        assert.ok(assignsVar(w, 'HTTPS_PROXY') && w.includes('127.0.0.1:8888'));
      });
      it('scopes/unsets HTTPS_PROXY so it does not persist in the shell', () => {
        if (os === 'windows') {
          assert.ok(w.includes('$env:HTTPS_PROXY = $null'));
          assert.ok(w.includes('$env:NO_PROXY = $null'));
        } else {
          // POSIX: env-prefix on the copilot line scopes it to that command
          assert.match(w, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:8888 \\/);
        }
      });
      it('honours a custom port', () => {
        const custom = buildCopilotWrapper({ os, mitmPort: 9999 });
        assert.ok(custom.includes('127.0.0.1:9999'));
      });
      if (os !== 'windows') {
        it('single-quotes the NO_PROXY value so zsh does not glob its * patterns', () => {
          // NO_PROXY contains wildcard hosts (e.g. *.akamai.com, *.local). As an
          // unquoted argument to `env`, zsh performs filename globbing on them and
          // aborts with "no matches found" when nothing matches (bash tolerates it,
          // zsh does not). The value MUST be single-quoted.
          assert.match(w, /NO_PROXY='[^']*\*[^']*' \\/,
            '_copilot POSIX wrapper must single-quote NO_PROXY to prevent zsh glob expansion.');
          // And must NOT emit the bare unquoted form.
          assert.ok(!/NO_PROXY=[^'"\s]*\*/.test(w),
            '_copilot must not emit an unquoted NO_PROXY value containing glob characters.');
        });
      }
    });
  }
});

describe('_claude wrapper — sets its own env per-invocation', () => {
  for (const os of platforms) {
    describe(os, () => {
      const w = buildClaudeWrapper({ os });
      it('sets ANTHROPIC_BASE_URL pointing at headroom port', () => {
        assert.ok(assignsVar(w, 'ANTHROPIC_BASE_URL') && w.includes('127.0.0.1:8787'));
      });
      it('sets ENABLE_PROMPT_CACHING_1H (Claude token-caching improvement)', () => {
        assert.ok(assignsVar(w, 'ENABLE_PROMPT_CACHING_1H'));
      });
      it('scopes/unsets ANTHROPIC_BASE_URL so it does not persist in the shell', () => {
        if (os === 'windows') {
          assert.ok(w.includes('$env:ANTHROPIC_BASE_URL = $null'),
            'Windows _claude must unset ANTHROPIC_BASE_URL after the call.');
          assert.ok(w.includes('$env:ENABLE_PROMPT_CACHING_1H = $null'));
        } else {
          assert.match(w, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787 \\/);
        }
      });
      it('honours a custom port', () => {
        const custom = buildClaudeWrapper({ os, headroomPort: 9797 });
        assert.ok(custom.includes('127.0.0.1:9797'));
      });
      it('falls back to plain `claude` when headroom is offline', () => {
        if (os === 'windows') {
          assert.ok(w.includes('Test-NetConnection'));
          assert.ok(w.includes('& claude @args'));
        } else {
          assert.ok(w.includes('nc -z 127.0.0.1'));
          assert.ok(w.includes('claude "$@"'));
        }
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Service isolation — long-running services must unset client-side vars.
// -----------------------------------------------------------------------------

describe('buildServiceEnvUnsetLines — server-side isolation', () => {
  it('windows emits SetEnvironmentVariable($null, "Process") lines', () => {
    const s = buildServiceEnvUnsetLines({ os: 'windows' });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(`SetEnvironmentVariable('${v}', $null, 'Process')`),
        `Missing Windows unset for '${v}'`);
    }
  });
  it('linux emits systemd UnsetEnvironment= directives', () => {
    const s = buildServiceEnvUnsetLines({ os: 'linux' });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(`UnsetEnvironment=${v}`), `Missing systemd unset for '${v}'`);
    }
  });
  it('darwin emits POSIX `unset X` prefix', () => {
    const s = buildServiceEnvUnsetLines({ os: 'darwin' });
    assert.match(s, /^unset\s+ANTHROPIC_BASE_URL\b/);
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(v), `Missing '${v}' in darwin unset line`);
    }
  });
  it('accepts a custom vars list', () => {
    const s = buildServiceEnvUnsetLines({ os: 'linux', vars: ['FOO', 'BAR'] });
    assert.ok(s.includes('UnsetEnvironment=FOO'));
    assert.ok(s.includes('UnsetEnvironment=BAR'));
  });
});

// -----------------------------------------------------------------------------
// Regression test — src/install.mjs must NEVER re-introduce ANTHROPIC_BASE_URL
// into any globally-visible env-var location. This is the July 2026
// "418 to api.anthropic.com" regression guard.
// -----------------------------------------------------------------------------

describe('install.mjs regression — no global ANTHROPIC_BASE_URL', () => {
  const installSrc = readFileSync(join(__dirname, '..', 'src', 'install.mjs'), 'utf8');

  it('Windows registry (HKCU\\Environment) block excludes ANTHROPIC_BASE_URL', () => {
    const match = installSrc.match(/const registryVars = \{[\s\S]*?\};/);
    assert.ok(match, 'registryVars object literal not found in install.mjs');
    assert.ok(!match[0].includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be persisted to Windows registry — it makes Copilot CLI bypass mitmproxy. Only _claude wrapper may set it (per-invocation).');
  });

  it('Windows PowerShell $PROFILE block (psEnv) excludes ANTHROPIC_BASE_URL', () => {
    const match = installSrc.match(/const psEnv = `[^`]*`;/);
    assert.ok(match, 'psEnv template literal not found');
    assert.ok(!match[0].includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be exported in Windows PowerShell $PROFILE — it leaks into every PS-launched process (including Copilot CLI). Only _claude wrapper may set it.');
  });

  it('POSIX shell profile block excludes ANTHROPIC_BASE_URL', () => {
    const posixStart = installSrc.indexOf('block = `\\n# >>> myelin managed >>>\\nexport HEADROOM_PORT');
    assert.ok(posixStart >= 0, 'POSIX shell-block assignment not found');
    const posixEnd = installSrc.indexOf('`;', posixStart);
    assert.ok(posixEnd >= 0, 'POSIX shell-block template not terminated');
    const posixBlock = installSrc.slice(posixStart, posixEnd);
    assert.ok(!posixBlock.includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be exported in .bashrc/.zshrc — it leaks into every shell-launched process (including copilot). Only _claude wrapper may set it.');
  });
});

