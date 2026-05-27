// First-run wizard trigger logic. Pure functions, no I/O beyond reading
// what ConfigStore already returns. Decides whether the open-source
// onboarding overlay should fire at startup; the actual Ink overlay lives
// in src/repl/ink/FirstRunWizard.tsx and is mounted from cli.ts.
//
// AutoCode intentionally ships with NO bundled credentials of any kind.
// The wizard exists to present the only two supported auth paths — sign up
// at bvrai.com or BYOK — in a way that doesn't dump first-time users into
// a cryptic "stub mode" warning.

import type { AutocodeConfig } from './ConfigStore.js';

// Env vars AuthResolver checks. Mirrors ConfigStore.envKeyFor so we don't
// double-define; AUTOMAX_PROXY_TOKEN is the V6-embedded path.
const CRED_ENV_VARS = [
  'AUTOMAX_PROXY_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
] as const;

// True iff *any* credential AutoCode can use is set, either in process env
// or persisted in the config file. Treats "configured for any provider" as
// "user has been here before."
export function hasAnyCredentials(config: AutocodeConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const name of CRED_ENV_VARS) {
    const v = env[name];
    if (v && v.length > 0) return true;
  }
  const keys = config.apiKeys ?? {};
  for (const v of Object.values(keys)) {
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}

export interface WizardTriggerInputs {
  config: AutocodeConfig;
  env?: NodeJS.ProcessEnv;
  // True for the interactive Bridge path; false for headless (-p), the
  // --automax bridge mode, or any non-TTY stdout. The wizard requires a
  // real interactive TTY to make sense.
  interactive: boolean;
}

// The single gate. Returns true iff the wizard should fire at startup.
// Suppressed once any of: firstRunCompletedAt is set, the user has *any*
// credential anywhere, or we're not in an interactive TTY.
export function shouldRunFirstRunWizard(inputs: WizardTriggerInputs): boolean {
  if (!inputs.interactive) return false;
  if (inputs.config.firstRunCompletedAt) return false;
  if (hasAnyCredentials(inputs.config, inputs.env)) return false;
  return true;
}

// What providers the wizard offers in the BYOK sub-step. Order matters —
// these render top-to-bottom in the picker. Free-tier providers carry a
// hint string the wizard surfaces inline; AutoCode never recommends any of
// them, just notes which ones have a free path so users who want zero cost
// can find it themselves.
export interface ByokProviderOption {
  id: 'anthropic' | 'openai' | 'xai' | 'openrouter' | 'google';
  label: string;
  envKey: string;
  // Where the user obtains a key. Shown next to the paste prompt.
  signupUrl: string;
  // Optional one-line hint shown next to the option in the picker.
  hint?: string;
}

export const BYOK_PROVIDERS: ByokProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Claude models · paid',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    hint: 'GPT models · paid',
  },
  {
    id: 'xai',
    label: 'xAI',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai/',
    hint: 'Grok models · paid',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    hint: '100+ models, free tier available',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    hint: 'Free tier (1500 reqs/day)',
  },
];

// Where the wizard's "Sign up at bvrai.com" option sends the user. Kept as
// a single constant so the domain decision (bvrai.com vs automax.com vs
// other) is a one-line change later.
export const BVRAI_SIGNUP_URL = 'https://bvrai.com';
