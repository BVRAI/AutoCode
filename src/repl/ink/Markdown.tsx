// Markdown.tsx — render an assistant markdown string as styled Ink elements.
//
// Shared by BOTH UIs (inline's <Static> scrollback + the cockpit viewport).
// It renders NATIVELY with Ink's own <Text> styling props (bold / color /
// italic) — never raw ANSI — so it's safe inside <Static> and adds ZERO
// flicker: a rendered block is committed once exactly like a plain <Text>
// line, just prettier. Styling is unrelated to repainting.
//
// Parsing leans on marked's lexer (already a dependency, used by the plain
// console renderer too) for robustness; we only map the token tree onto Ink.
// Anything unrecognised falls back to plain text, and a parse failure renders
// the original string unchanged — markdown is never allowed to break output.
//
// Terminal reality: there is no font-size, so headings get their weight from
// CAPS + bold + accent colour (+ a hairline rule for h1/h2), not size — the
// same constraint applies to inline and cockpit alike.

import React from 'react';
import { Box, Text } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { useTheme, type Theme } from './theme.js';
import { glyphs } from './glyphs.js';

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const t = useTheme();
  let blocks: Token[];
  try {
    blocks = marked.lexer(text);
  } catch {
    return <Text color={t.ink}>{text}</Text>;
  }
  // Drop pure-whitespace 'space' tokens; spacing comes from each block's margin.
  const visible = blocks.filter((b) => b.type !== 'space');
  return (
    <Box flexDirection="column">
      {visible.map((b, i) => (
        <Block key={i} token={b} t={t} first={i === 0} />
      ))}
    </Box>
  );
}

// ── block-level tokens ────────────────────────────────────────────────────

function Block({ token, t, first }: { token: Token; t: Theme; first: boolean }): React.JSX.Element {
  const g = glyphs();
  const top = first ? 0 : 1;

  switch (token.type) {
    case 'heading': {
      const h = token as Tokens.Heading;
      // No font sizes in a terminal — weight comes from CAPS + bold + accent.
      // h1/h2 also get a hairline rule beneath for extra separation.
      const label = h.text.toUpperCase();
      return (
        <Box flexDirection="column" marginTop={top}>
          <Text bold color={t.accent}>{label}</Text>
          {h.depth <= 2 && (
            <Text color={t.rule}>{(g.rich ? '─' : '-').repeat(Math.min(label.length, 48))}</Text>
          )}
        </Box>
      );
    }
    case 'paragraph': {
      const p = token as Tokens.Paragraph;
      return (
        <Box marginTop={top}>
          <Text color={t.ink}>{inlineNodes(p.tokens, t)}</Text>
        </Box>
      );
    }
    case 'list': {
      const l = token as Tokens.List;
      return (
        <Box flexDirection="column" marginTop={top}>
          {l.items.map((item, idx) => (
            <ListRow
              key={idx}
              t={t}
              marker={l.ordered ? `${(typeof l.start === 'number' ? l.start : 1) + idx}.` : g.rich ? '•' : '-'}
              item={item}
            />
          ))}
        </Box>
      );
    }
    case 'code': {
      const c = token as Tokens.Code;
      const lines = c.text.replace(/\n$/, '').split('\n');
      return (
        <Box flexDirection="column" marginTop={top} marginLeft={2}>
          {c.lang ? <Text color={t.inkFaint}>{c.lang}</Text> : null}
          {lines.map((ln, i) => (
            <Box key={i}>
              <Text color={t.ruleStrong}>{g.diffGuide} </Text>
              <Text color={t.accent}>{ln || ' '}</Text>
            </Box>
          ))}
        </Box>
      );
    }
    case 'blockquote': {
      const bq = token as Tokens.Blockquote;
      return (
        <Box marginTop={top}>
          <Text color={t.ruleStrong}>{g.diffGuide} </Text>
          <Box flexGrow={1}>
            <Text color={t.inkDim}>{inlineNodes(bq.tokens, t)}</Text>
          </Box>
        </Box>
      );
    }
    case 'hr':
      return (
        <Box marginTop={top}>
          <Text color={t.rule}>{(g.rich ? '─' : '-').repeat(48)}</Text>
        </Box>
      );
    case 'text': {
      const tx = token as Tokens.Text;
      return (
        <Box marginTop={top}>
          <Text color={t.ink}>{tx.tokens ? inlineNodes(tx.tokens, t) : tx.text}</Text>
        </Box>
      );
    }
    default: {
      // Unknown block (table, html, …) — render its raw text rather than drop it.
      const raw = (token as { raw?: string }).raw ?? '';
      return (
        <Box marginTop={top}>
          <Text color={t.ink}>{raw}</Text>
        </Box>
      );
    }
  }
}

// A single list item: marker in accent, content (inline) flowing beside it.
function ListRow({ t, marker, item }: { t: Theme; marker: string; item: Tokens.ListItem }): React.JSX.Element {
  return (
    <Box>
      <Text color={t.accent}>{marker} </Text>
      <Box flexGrow={1}>
        <Text color={t.ink}>{itemInline(item.tokens, t)}</Text>
      </Box>
    </Box>
  );
}

// Flatten a list item's child tokens into inline nodes. Items usually hold a
// single 'text' block whose own .tokens are the inline run; nested lists/blocks
// are rendered via their raw text (rare in assistant replies).
function itemInline(tokens: Token[], t: Theme): React.ReactNode {
  return tokens.map((tok, i) => {
    if (tok.type === 'text') {
      const tt = tok as Tokens.Text;
      return <React.Fragment key={i}>{tt.tokens ? inlineNodes(tt.tokens, t) : tt.text}</React.Fragment>;
    }
    return <React.Fragment key={i}>{inlineNodes([tok], t)}</React.Fragment>;
  });
}

// ── inline tokens (rendered as nested <Text> spans so Ink wraps them as one
// flowing line; a span with no colour inherits the parent's) ────────────────

function inlineNodes(tokens: Token[] | undefined, t: Theme): React.ReactNode {
  if (!tokens) return null;
  return tokens.map((tok, i) => <InlineSpan key={i} token={tok} t={t} />);
}

function InlineSpan({ token, t }: { token: Token; t: Theme }): React.JSX.Element {
  switch (token.type) {
    case 'text': {
      const tt = token as Tokens.Text;
      if (tt.tokens && tt.tokens.length > 0) return <>{inlineNodes(tt.tokens, t)}</>;
      return <Text>{tt.text}</Text>;
    }
    case 'strong':
      return <Text bold>{inlineNodes((token as Tokens.Strong).tokens, t)}</Text>;
    case 'em':
      return <Text italic>{inlineNodes((token as Tokens.Em).tokens, t)}</Text>;
    case 'del':
      return <Text strikethrough>{inlineNodes((token as Tokens.Del).tokens, t)}</Text>;
    case 'codespan':
      return <Text color={t.accent} backgroundColor={t.codeBg}>{(token as Tokens.Codespan).text}</Text>;
    case 'link': {
      const lk = token as Tokens.Link;
      return (
        <>
          <Text color={t.accent} underline>{inlineNodes(lk.tokens, t)}</Text>
          {lk.href && lk.href !== lk.text ? <Text color={t.inkFaint}> ({lk.href})</Text> : null}
        </>
      );
    }
    case 'br':
      return <Text>{'\n'}</Text>;
    case 'escape':
      return <Text>{(token as Tokens.Escape).text}</Text>;
    default:
      return <Text>{(token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? ''}</Text>;
  }
}
