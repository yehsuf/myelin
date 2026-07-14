import { homedir } from 'node:os';
import { managedPaths, joinManaged, isWindowsStylePath } from '../shared/myelin-paths.mjs';

export const LITELLM_SERVICE_NAME = 'myelin-litellm';

/**
 * Generate the LiteLLM proxy config YAML content.
 * Pure function — no side effects, fully testable.
 */
export function generateLiteLLMConfig({
  headroomPort = 8787,
  litellmPort = 4000,
  cheapModel = 'claude-haiku-4-5',
  complexModel = 'claude-sonnet-4-6',
  // No default — Copilot's API host depends on the user's account tier
  // (Individual → api.githubcopilot.com; Business/Enterprise →
  // api.business.githubcopilot.com). Hardcoding either one silently
  // misroutes traffic and leaks the maintainer's tier into fresh installs.
  // Caller must pass an explicit apiBase; empty causes litellm to fail
  // loudly at startup which is the right signal for "you didn't configure me".
  apiBase = '',
} = {}) {
  return `# Myelin LiteLLM proxy config — managed by myelin install
# Edit via: myelin config set budget_routing.*
# Restart: myelin restart

model_list:
  - model_name: ${complexModel}
    litellm_params:
      model: anthropic/${complexModel}
      api_base: ${apiBase}
  - model_name: ${cheapModel}
    litellm_params:
      model: anthropic/${cheapModel}
      api_base: ${apiBase}

guardrails:
  - guardrail_name: headroom
    litellm_params:
      guardrail: headroom
      mode: pre_call
      api_base: http://127.0.0.1:${headroomPort}

general_settings:
  master_key: sk-myelin-local
  port: ${litellmPort}

litellm_settings:
  num_retries: 2
  fallbacks:
    - ${complexModel}:
        - ${cheapModel}
`;
}

/**
 * Build the LiteLLM start invocation as an executable + argv ARRAY (never a
 * shell string). Uses the myelin venv Python (where litellm is installed).
 * Returning `{ file, args }` keeps the managed venv-python and config paths as
 * discrete arguments, so no shell parses them even when the managed root
 * contains spaces, `$()`, backticks, or quotes. Run via execFileSync(file,args).
 */
export function generateLiteLLMStartCommand({ venvPath, configPath, port = 4000 } = {}) {
  // Derive the venv layout from the managed root's own path style rather than
  // the host process.platform, and extend it with joinManaged so a relocated
  // cross-style root keeps one consistent separator (never `D:\managed/venv/...`
  // or `/srv/managed\venv\...`).
  const python = isWindowsStylePath(venvPath)
    ? joinManaged(venvPath, 'Scripts', 'python.exe')
    : joinManaged(venvPath, 'bin', 'python');
  return { file: python, args: ['-m', 'litellm', '--config', configPath, '--port', String(port)] };
}

export function liteLLMConfigPath(home = homedir(), env = process.env) {
  return joinManaged(managedPaths({ home, env }).root, 'litellm-config.yaml');
}
