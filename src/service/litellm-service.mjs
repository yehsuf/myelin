import { join } from 'node:path';
import { homedir } from 'node:os';

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
  apiBase = 'https://api.business.githubcopilot.com',
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
 * Generate the shell command to start LiteLLM.
 * Uses the myelin venv Python (where litellm is installed).
 */
export function generateLiteLLMStartCommand({ venvPath, configPath, port = 4000 } = {}) {
  const isWin = process.platform === 'win32';
  const python = isWin
    ? join(venvPath, 'Scripts', 'python.exe')
    : join(venvPath, 'bin', 'python');
  return `"${python}" -m litellm --config "${configPath}" --port ${port}`;
}

export function liteLLMConfigPath(home = homedir()) {
  return join(home, '.myelin', 'litellm-config.yaml');
}
