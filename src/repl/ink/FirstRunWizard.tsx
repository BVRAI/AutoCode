// First-run onboarding wizard. Renders as a standalone Ink app (NOT an
// overlay on the Bridge — it runs before the agent is constructed) when
// AutoCode launches with no credentials anywhere. Three steps:
//
//   1. Top choice: Sign up at bvrai.com / BYOK / Skip
//   2. (BYOK only) Provider picker — Anthropic, OpenAI, xAI, OpenRouter, Gemini
//   3. (BYOK only) Paste API key
//
// Returns an Outcome the caller (cli.ts) uses to either continue with the
// freshly-saved BYOK config or fall through to stub mode. The wizard
// always records firstRunCompletedAt so it never re-prompts.

import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { BR } from './theme.js';
import { BYOK_PROVIDERS, BVRAI_SIGNUP_URL, type ByokProviderOption } from '../../auth/firstRun.js';

export type WizardOutcome =
  | { kind: 'byok'; provider: ByokProviderOption['id']; apiKey: string }
  | { kind: 'signup-opened' }
  | { kind: 'skipped' };

export interface FirstRunWizardProps {
  onComplete: (outcome: WizardOutcome) => void;
}

type Step = 'top' | 'byok-provider' | 'byok-paste' | 'bvrai-opened';

interface TopChoice {
  id: 'signup' | 'byok' | 'skip';
  label: string;
  hint: string;
}

const TOP_CHOICES: TopChoice[] = [
  { id: 'signup', label: 'Sign up at bvrai.com', hint: 'paid Automax · all top models · easiest' },
  { id: 'byok',   label: 'Bring your own key',   hint: 'Anthropic · OpenAI · xAI · OpenRouter · Gemini' },
  { id: 'skip',   label: 'Skip for now',          hint: 'read-only stub mode · /auth later to add a key' },
];

export function FirstRunWizard({ onComplete }: FirstRunWizardProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('top');
  const [topIdx, setTopIdx] = useState<number>(0);
  const [providerIdx, setProviderIdx] = useState<number>(0);
  const [apiKey, setApiKey] = useState<string>('');

  const selectedProvider = BYOK_PROVIDERS[providerIdx]!;

  const openSignupAndAdvance = useCallback(() => {
    // Fire-and-forget. If browser launch fails the URL is still printed in
    // the next view so the user can copy/paste manually.
    void openInDefaultBrowser(BVRAI_SIGNUP_URL);
    setStep('bvrai-opened');
  }, []);

  useInput((ch, key) => {
    if (step === 'top') {
      if (key.upArrow) {
        setTopIdx((i) => (i - 1 + TOP_CHOICES.length) % TOP_CHOICES.length);
        return;
      }
      if (key.downArrow) {
        setTopIdx((i) => (i + 1) % TOP_CHOICES.length);
        return;
      }
      if (key.return) {
        const picked = TOP_CHOICES[topIdx]!;
        if (picked.id === 'signup') {
          openSignupAndAdvance();
          return;
        }
        if (picked.id === 'byok') {
          setStep('byok-provider');
          return;
        }
        if (picked.id === 'skip') {
          onComplete({ kind: 'skipped' });
          return;
        }
      }
      if (key.escape) {
        onComplete({ kind: 'skipped' });
        return;
      }
      return;
    }

    if (step === 'byok-provider') {
      if (key.upArrow) {
        setProviderIdx((i) => (i - 1 + BYOK_PROVIDERS.length) % BYOK_PROVIDERS.length);
        return;
      }
      if (key.downArrow) {
        setProviderIdx((i) => (i + 1) % BYOK_PROVIDERS.length);
        return;
      }
      if (key.return) {
        setStep('byok-paste');
        return;
      }
      if (key.escape) {
        setStep('top');
        return;
      }
      return;
    }

    if (step === 'byok-paste') {
      if (key.return) {
        const trimmed = apiKey.trim();
        if (trimmed.length >= 8) {
          onComplete({ kind: 'byok', provider: selectedProvider.id, apiKey: trimmed });
        }
        return;
      }
      if (key.escape) {
        setApiKey('');
        setStep('byok-provider');
        return;
      }
      if (key.backspace || key.delete) {
        setApiKey((s) => s.slice(0, -1));
        return;
      }
      if (ch && ch.length > 0 && !key.meta && !key.ctrl) {
        setApiKey((s) => s + ch);
      }
      return;
    }

    if (step === 'bvrai-opened') {
      if (key.return || ch === ' ') {
        onComplete({ kind: 'signup-opened' });
        return;
      }
      if (key.escape) {
        // Same as confirming — they've seen the message.
        onComplete({ kind: 'signup-opened' });
        return;
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={BR.teal} bold>Welcome to AutoCode</Text>
      <Box height={1} />
      {step === 'top' && <TopStep idx={topIdx} />}
      {step === 'byok-provider' && <ProviderStep idx={providerIdx} />}
      {step === 'byok-paste' && <PasteStep provider={selectedProvider} apiKey={apiKey} />}
      {step === 'bvrai-opened' && <BvraiOpenedStep />}
    </Box>
  );
}

function TopStep({ idx }: { idx: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={BR.ink}>To get started, choose how to provide an LLM:</Text>
      <Box height={1} />
      {TOP_CHOICES.map((c, i) => {
        const selected = i === idx;
        return (
          <Box key={c.id}>
            <Text color={selected ? BR.teal : BR.inkFaint}>{selected ? '▸ ' : '  '}</Text>
            <Box width={28}>
              <Text color={selected ? BR.teal : BR.ink} bold={selected}>
                {c.label}
              </Text>
            </Box>
            <Text color={BR.inkDim}> · {c.hint}</Text>
          </Box>
        );
      })}
      <Box height={1} />
      <Text color={BR.inkFaint}>↑↓ pick · enter confirm · esc skip</Text>
    </Box>
  );
}

function ProviderStep({ idx }: { idx: number }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={BR.ink}>Which provider's key do you have?</Text>
      <Box height={1} />
      {BYOK_PROVIDERS.map((p, i) => {
        const selected = i === idx;
        return (
          <Box key={p.id}>
            <Text color={selected ? BR.teal : BR.inkFaint}>{selected ? '▸ ' : '  '}</Text>
            <Box width={20}>
              <Text color={selected ? BR.teal : BR.ink} bold={selected}>
                {p.label}
              </Text>
            </Box>
            {p.hint && <Text color={BR.inkDim}> · {p.hint}</Text>}
          </Box>
        );
      })}
      <Box height={1} />
      <Text color={BR.inkFaint}>↑↓ pick · enter continue · esc back</Text>
    </Box>
  );
}

function PasteStep({
  provider,
  apiKey,
}: {
  provider: ByokProviderOption;
  apiKey: string;
}): React.JSX.Element {
  // Show the buffer as-typed — keys come from clipboard paste in practice
  // and users like to see they pasted the right prefix. The terminal session
  // is local; not masking.
  const tooShort = apiKey.length > 0 && apiKey.length < 8;
  return (
    <Box flexDirection="column">
      <Text color={BR.ink}>Paste your <Text color={BR.teal}>{provider.label}</Text> API key:</Text>
      <Box height={1} />
      <Box>
        <Text color={BR.inkFaint}>{'> '}</Text>
        <Text color={BR.ink}>{apiKey}</Text>
        <Text color={BR.teal}>▌</Text>
      </Box>
      <Box height={1} />
      <Text color={BR.inkDim}>Get a key at <Text color={BR.teal}>{provider.signupUrl}</Text></Text>
      <Box height={1} />
      {tooShort
        ? <Text color={BR.amber}>Key seems too short — keep typing or paste the full value.</Text>
        : <Text color={BR.inkFaint}>enter save · esc back · backspace to edit</Text>}
    </Box>
  );
}

function BvraiOpenedStep(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={BR.ink}>Opening <Text color={BR.teal}>{BVRAI_SIGNUP_URL}</Text> in your browser…</Text>
      <Box height={1} />
      <Text color={BR.ink}>After signing up:</Text>
      <Text color={BR.inkDim}>  · Install the Automax desktop app from your dashboard for the full experience.</Text>
      <Text color={BR.inkDim}>  · Standalone CLI access via this wizard is coming soon.</Text>
      <Box height={1} />
      <Text color={BR.inkFaint}>enter to continue (AutoCode will start in stub mode; use /auth anytime to add a BYOK key)</Text>
    </Box>
  );
}

// Local browser-open helper. Mirrors src/util/host.ts osOpenCommand without
// going through the open_in_browser tool (which is intended for the agent,
// not startup-time UI). Failures are intentionally silent — the URL is
// already on screen for the user to copy/paste if their default browser is
// uncooperative.
async function openInDefaultBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process');
    const { osOpenCommand } = await import('../../util/host.js');
    const { cmd, args } = osOpenCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* user can copy/paste the URL on screen */
  }
}

// One-shot mount helper. Mounts a small standalone Ink app, awaits the
// outcome, unmounts cleanly. The wizard uses the alt-screen takeover the
// Bridge uses so we don't pollute the user's terminal scrollback.
export async function runFirstRunWizard(): Promise<WizardOutcome> {
  const { render } = await import('ink');
  process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
  let exited = false;
  const restore = (): void => {
    if (exited) return;
    exited = true;
    try {
      process.stdout.write('\x1b[?1049l');
    } catch {
      /* shell already gone */
    }
  };
  process.once('exit', restore);

  return new Promise<WizardOutcome>((resolve) => {
    let outcome: WizardOutcome | null = null;
    const Wrapped = (): React.JSX.Element => {
      const app = useApp();
      return (
        <FirstRunWizard
          onComplete={(o) => {
            outcome = o;
            app.exit();
          }}
        />
      );
    };
    const inst = render(<Wrapped />, {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: true,
      patchConsole: false,
    });
    void inst.waitUntilExit().then(() => {
      restore();
      // If the user hit Ctrl+C before completing, treat as skip — the
      // launcher should still proceed (probably into stub mode).
      resolve(outcome ?? { kind: 'skipped' });
    });
  });
}
