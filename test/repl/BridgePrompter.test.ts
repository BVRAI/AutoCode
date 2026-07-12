import { describe, expect, it } from 'vitest';
import { BridgePrompter } from '../../src/repl/ink/BridgePrompter.js';
import { BridgeStore, type PromptRequest } from '../../src/repl/ink/store.js';

// The prompter opens its overlay one microtask after the call (its internal
// queue chains through a .then) — flush before reading the store.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function pendingRequest(store: BridgeStore): PromptRequest {
  const overlay = store.get().overlay;
  if (overlay?.kind !== 'prompt') throw new Error(`expected prompt overlay, got ${JSON.stringify(overlay)}`);
  return overlay.request;
}

describe('BridgePrompter', () => {
  it('approve() opens an approval overlay and resolves with the verdict', async () => {
    const store = new BridgeStore();
    const prompter = new BridgePrompter(store);

    const pending = prompter.approve('Run edit_file?');
    await tick();
    const req = pendingRequest(store);
    expect(req.type).toBe('approve');
    if (req.type !== 'approve') return;
    expect(req.label).toBe('Run edit_file?');

    req.resolve({ decision: 'revise', guidance: 'smaller edit' });
    await expect(pending).resolves.toEqual({ decision: 'revise', guidance: 'smaller edit' });
    expect(store.get().overlay).toBeNull();
  });

  it('does NOT auto-accept: the promise stays pending until the user resolves', async () => {
    const store = new BridgeStore();
    const prompter = new BridgePrompter(store);

    let settled = false;
    const pending = prompter.confirm('Allow?').then((v) => {
      settled = true;
      return v;
    });
    // Give the microtask queue several turns — an auto-accepting prompter
    // would have resolved by now.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);

    const req = pendingRequest(store);
    if (req.type === 'confirm') req.resolve(false);
    await expect(pending).resolves.toBe(false);
  });

  it('serializes overlapping prompts — second overlay waits for the first', async () => {
    const store = new BridgeStore();
    const prompter = new BridgePrompter(store);

    const first = prompter.confirm('first?');
    const second = prompter.confirm('second?');
    // Let the queue settle so the first overlay is mounted.
    await tick();

    let req = pendingRequest(store);
    expect(req.type === 'confirm' && req.message).toBe('first?');
    if (req.type === 'confirm') req.resolve(true);
    await expect(first).resolves.toBe(true);

    // Second only appears after the first resolved.
    await tick();
    req = pendingRequest(store);
    expect(req.type === 'confirm' && req.message).toBe('second?');
    if (req.type === 'confirm') req.resolve(false);
    await expect(second).resolves.toBe(false);
    expect(store.get().overlay).toBeNull();
  });

  it('choose() resolves the picked indices and clears the overlay', async () => {
    const store = new BridgeStore();
    const prompter = new BridgePrompter(store);

    const pending = prompter.choose('Pick', ['a', 'b', 'c'], true);
    await tick();
    const req = pendingRequest(store);
    expect(req.type).toBe('choose');
    if (req.type === 'choose') {
      expect(req.options).toEqual(['a', 'b', 'c']);
      req.resolve([0, 2]);
    }
    await expect(pending).resolves.toEqual([0, 2]);
    expect(store.get().overlay).toBeNull();
  });

  it('ask() resolves the typed answer', async () => {
    const store = new BridgeStore();
    const prompter = new BridgePrompter(store);

    const pending = prompter.ask('Guidance:');
    await tick();
    const req = pendingRequest(store);
    if (req.type === 'ask') req.resolve('do it differently');
    await expect(pending).resolves.toBe('do it differently');
  });
});
