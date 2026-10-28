// Builds a fictional sandbox for README screenshots:
//   home/code/acme-*      real git repos, with uncommitted edits matching the transcripts
//   home/.claude/projects Claude transcripts the app replays as history
//   userData/overcli.json projects + conversations pointing at both
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

// Usage: node seed.mjs <workDir> <userDataDir> [dark|light]
const [ROOT, USERDATA, THEME = 'dark'] = process.argv.slice(2);
const HOME = path.join(ROOT, 'home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
const realHome = fs.realpathSync(HOME);

const sh = (cmd, cwd) =>
  execSync(cmd, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      HOME: realHome,
      GIT_AUTHOR_NAME: 'Dana Reyes',
      GIT_AUTHOR_EMAIL: 'dana@acme.dev',
      GIT_COMMITTER_NAME: 'Dana Reyes',
      GIT_COMMITTER_EMAIL: 'dana@acme.dev',
    },
  }).toString();

function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body.replace(/^\n/, ''));
  }
}

function repo(name, commits) {
  const dir = path.join(realHome, 'code', name);
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -q -b main', dir);
  for (const [msg, files] of commits) {
    write(dir, files);
    sh(`git add -A && git commit -q -m ${JSON.stringify(msg)}`, dir);
  }
  return dir;
}

// ---------------------------------------------------------------- repos

const PROMO_BEFORE = `
import { useState } from 'react';
import { useCart } from '../cart/useCart';
import { formatMoney } from '../lib/money';

export function CheckoutSummary() {
  const { items, subtotal, shipping } = useCart();
  const total = subtotal + shipping;

  return (
    <section className="summary">
      <h2>Order summary</h2>
      <ul>
        {items.map((i) => (
          <li key={i.sku}>
            {i.name} × {i.qty}
            <span>{formatMoney(i.price * i.qty)}</span>
          </li>
        ))}
      </ul>
      <dl>
        <dt>Subtotal</dt>
        <dd>{formatMoney(subtotal)}</dd>
        <dt>Shipping</dt>
        <dd>{formatMoney(shipping)}</dd>
        <dt>Total</dt>
        <dd className="total">{formatMoney(total)}</dd>
      </dl>
    </section>
  );
}
`;

const PROMO_AFTER = `
import { useState } from 'react';
import { useCart } from '../cart/useCart';
import { formatMoney } from '../lib/money';
import { PromoCodeField } from './PromoCodeField';
import { usePromo } from './usePromo';

export function CheckoutSummary() {
  const { items, subtotal, shipping } = useCart();
  const promo = usePromo(subtotal);
  const total = Math.max(0, subtotal - promo.discount) + shipping;

  return (
    <section className="summary">
      <h2>Order summary</h2>
      <ul>
        {items.map((i) => (
          <li key={i.sku}>
            {i.name} × {i.qty}
            <span>{formatMoney(i.price * i.qty)}</span>
          </li>
        ))}
      </ul>
      <PromoCodeField onApply={promo.apply} error={promo.error} pending={promo.pending} />
      <dl>
        <dt>Subtotal</dt>
        <dd>{formatMoney(subtotal)}</dd>
        {promo.discount > 0 && (
          <>
            <dt>Promo ({promo.code})</dt>
            <dd className="discount">−{formatMoney(promo.discount)}</dd>
          </>
        )}
        <dt>Shipping</dt>
        <dd>{formatMoney(shipping)}</dd>
        <dt>Total</dt>
        <dd className="total">{formatMoney(total)}</dd>
      </dl>
    </section>
  );
}
`;

const USE_PROMO = `
import { useState } from 'react';
import { api } from '../lib/api';

export interface PromoState {
  code: string | null;
  discount: number;
  error: string | null;
  pending: boolean;
  apply: (code: string) => Promise<void>;
}

/** Validates a promo code server-side and returns the discount in cents. */
export function usePromo(subtotal: number): PromoState {
  const [code, setCode] = useState<string | null>(null);
  const [discount, setDiscount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function apply(raw: string) {
    const next = raw.trim().toUpperCase();
    if (!next) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.post('/v2/promos/validate', { code: next, subtotal });
      setCode(next);
      setDiscount(res.discountCents);
    } catch (e) {
      setDiscount(0);
      setError(e instanceof api.NotFound ? 'That code isn\\'t valid.' : 'Couldn\\'t check that code.');
    } finally {
      setPending(false);
    }
  }

  return { code, discount, error, pending, apply };
}
`;

const PROMO_FIELD = `
import { useState } from 'react';

interface Props {
  onApply: (code: string) => void;
  error: string | null;
  pending: boolean;
}

export function PromoCodeField({ onApply, error, pending }: Props) {
  const [value, setValue] = useState('');
  return (
    <form
      className="promo"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(value);
      }}
    >
      <input
        aria-label="Promo code"
        placeholder="Promo code"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button disabled={pending || !value.trim()}>{pending ? 'Checking…' : 'Apply'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
`;

const PROMO_TEST = `
import { renderHook, act } from '@testing-library/react';
import { usePromo } from './usePromo';
import { api } from '../lib/api';

vi.mock('../lib/api');

describe('usePromo', () => {
  it('applies a valid code', async () => {
    vi.mocked(api.post).mockResolvedValue({ discountCents: 1500 });
    const { result } = renderHook(() => usePromo(12000));
    await act(() => result.current.apply(' spring15 '));
    expect(result.current.code).toBe('SPRING15');
    expect(result.current.discount).toBe(1500);
  });

  it('clears the discount on an unknown code', async () => {
    vi.mocked(api.post).mockRejectedValue(new api.NotFound());
    const { result } = renderHook(() => usePromo(12000));
    await act(() => result.current.apply('NOPE'));
    expect(result.current.discount).toBe(0);
    expect(result.current.error).toBe("That code isn't valid.");
  });
});
`;

const storefront = repo('acme-storefront', [
  [
    'chore: scaffold storefront',
    {
      'package.json': JSON.stringify(
        { name: 'acme-storefront', private: true, scripts: { dev: 'vite', test: 'vitest run' } },
        null,
        2,
      ),
      'README.md': '# acme-storefront\n\nThe Acme web shop.\n',
      'src/lib/money.ts':
        "export const formatMoney = (cents: number) =>\n  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);\n",
      'src/lib/api.ts':
        "class NotFound extends Error {}\nexport const api = {\n  NotFound,\n  async post(url: string, body: unknown) {\n    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });\n    if (res.status === 404) throw new NotFound();\n    return res.json();\n  },\n};\n",
      'src/cart/useCart.ts': 'export function useCart() {\n  return { items: [], subtotal: 0, shipping: 0 };\n}\n',
    },
  ],
  ['feat(checkout): order summary', { 'src/checkout/CheckoutSummary.tsx': PROMO_BEFORE }],
  ['feat(cart): persist cart across sessions', { 'src/cart/storage.ts': "export const CART_KEY = 'acme.cart.v2';\n" }],
]);
// The turn's edits, left uncommitted so the changes bar and diff have something to show.
write(storefront, {
  'src/checkout/CheckoutSummary.tsx': PROMO_AFTER,
  'src/checkout/usePromo.ts': USE_PROMO,
  'src/checkout/PromoCodeField.tsx': PROMO_FIELD,
  'src/checkout/usePromo.test.ts': PROMO_TEST,
});

const apiRepo = repo('acme-api', [
  [
    'chore: scaffold api',
    {
      'package.json': JSON.stringify({ name: 'acme-api', private: true }, null, 2),
      'src/routes/orders.ts': "import { Router } from 'express';\nexport const orders = Router();\norders.get('/', (_req, res) => res.json([]));\n",
      'src/routes/promos.ts': "import { Router } from 'express';\nexport const promos = Router();\n",
    },
  ],
]);
const billing = repo('acme-billing', [
  [
    'chore: scaffold billing',
    {
      'README.md': '# acme-billing\n\nInvoices, retries, dunning.\n',
      'jobs/invoice_retry.py': 'def run():\n    pass\n',
    },
  ],
]);
const docsRepo = repo('acme-docs', [['docs: init', { 'README.md': '# Acme docs\n' }]]);

// ---------------------------------------------------------- transcripts

const now = Date.now();
let clock = now - 1000 * 60 * 9;
const tick = (s = 4) => new Date((clock += s * 1000)).toISOString();
const uid = () => crypto.randomUUID();

function transcript(cwd, sessionId, rows) {
  const slug = fs.realpathSync(cwd).replaceAll('/', '-').replaceAll('.', '-').replaceAll(' ', '-');
  const dir = path.join(realHome, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  let parent = null;
  const lines = rows.map((r) => {
    const id = uid();
    const line = { parentUuid: parent, isSidechain: false, cwd, sessionId, uuid: id, timestamp: tick(r.dt), ...r.row };
    parent = id;
    return JSON.stringify(line);
  });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

const user = (text, dt = 2) => ({ dt, row: { type: 'user', message: { role: 'user', content: text } } });
const asst = (content, dt = 3) => ({
  dt,
  row: {
    type: 'assistant',
    message: {
      id: 'msg_' + uid().slice(0, 12),
      role: 'assistant',
      model: 'claude-opus-5-5',
      type: 'message',
      content,
      usage: { input_tokens: 2400, output_tokens: 610, cache_read_input_tokens: 41000 },
    },
  },
});
const results = (pairs, dt = 2) => ({
  dt,
  row: {
    type: 'user',
    message: {
      role: 'user',
      content: pairs.map(([id, content, is_error]) => ({ type: 'tool_result', tool_use_id: id, content, is_error: !!is_error })),
    },
  },
});
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const think = (thinking) => ({ type: 'thinking', thinking, signature: 'x' });
const text = (t) => ({ type: 'text', text: t });

const P = (rel) => rel;
const heroSession = uid();
transcript(storefront, heroSession, [
  user(
    'Add a promo code field to checkout. Validate the code against POST /v2/promos/validate, show the discount as its own line in the summary, and cover the hook with tests.',
  ),
  asst([
    think(
      'Checkout totals live in CheckoutSummary. The API client already throws NotFound on a 404, so an unknown code can map to a friendly error without string-matching. I\'ll keep the network logic in a hook so the component stays presentational and the hook is easy to test.',
    ),
    text("I'll start by looking at how checkout computes the total and how the API client reports errors."),
    tool('t1', 'Grep', { pattern: 'subtotal|NotFound', path: 'src', output_mode: 'files_with_matches' }),
  ]),
  results([['t1', 'src/checkout/CheckoutSummary.tsx\nsrc/cart/useCart.ts\nsrc/lib/api.ts']]),
  asst([tool('t2', 'Read', { file_path: P('src/checkout/CheckoutSummary.tsx') })]),
  results([['t2', PROMO_BEFORE.trim()]]),
  asst([
    text('The total is computed inline, so the discount slots in there. Creating the hook first:'),
    tool('t3', 'Write', { file_path: P('src/checkout/usePromo.ts'), content: USE_PROMO.trim() }),
  ]),
  results([['t3', 'File created successfully at: ' + P('src/checkout/usePromo.ts')]]),
  asst([tool('t4', 'Write', { file_path: P('src/checkout/PromoCodeField.tsx'), content: PROMO_FIELD.trim() })]),
  results([['t4', 'File created successfully at: ' + P('src/checkout/PromoCodeField.tsx')]]),
  asst([
    text('Now wiring it into the summary:'),
    tool('t5', 'Edit', {
      file_path: P('src/checkout/CheckoutSummary.tsx'),
      old_string: "import { formatMoney } from '../lib/money';\n\nexport function CheckoutSummary() {\n  const { items, subtotal, shipping } = useCart();\n  const total = subtotal + shipping;",
      new_string:
        "import { formatMoney } from '../lib/money';\nimport { PromoCodeField } from './PromoCodeField';\nimport { usePromo } from './usePromo';\n\nexport function CheckoutSummary() {\n  const { items, subtotal, shipping } = useCart();\n  const promo = usePromo(subtotal);\n  const total = Math.max(0, subtotal - promo.discount) + shipping;",
    }),
  ]),
  results([['t5', 'The file has been updated.']]),
  asst([
    tool('t6', 'Edit', {
      file_path: P('src/checkout/CheckoutSummary.tsx'),
      old_string: '      </ul>\n      <dl>\n        <dt>Subtotal</dt>\n        <dd>{formatMoney(subtotal)}</dd>',
      new_string:
        '      </ul>\n      <PromoCodeField onApply={promo.apply} error={promo.error} pending={promo.pending} />\n      <dl>\n        <dt>Subtotal</dt>\n        <dd>{formatMoney(subtotal)}</dd>\n        {promo.discount > 0 && (\n          <>\n            <dt>Promo ({promo.code})</dt>\n            <dd className="discount">−{formatMoney(promo.discount)}</dd>\n          </>\n        )}',
    }),
  ]),
  results([['t6', 'The file has been updated.']]),
  asst([tool('t7', 'Write', { file_path: P('src/checkout/usePromo.test.ts'), content: PROMO_TEST.trim() })]),
  results([['t7', 'File created successfully at: ' + P('src/checkout/usePromo.test.ts')]]),
  asst([tool('t8', 'Bash', { command: 'npx vitest run src/checkout', description: 'Run checkout tests' })]),
  results(
    [
      [
        't8',
        ' RUN  v3.2.4 ~/code/acme-storefront\n\n ✓ src/checkout/usePromo.test.ts (2 tests) 14ms\n   ✓ usePromo > applies a valid code\n   ✓ usePromo > clears the discount on an unknown code\n ✓ src/checkout/CheckoutSummary.test.tsx (4 tests) 38ms\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)\n   Duration  612ms',
      ],
    ],
    6,
  ),
  asst(
    [
      text(`Promo codes are in, and all 6 checkout tests pass.

## What changed

| File | Change |
|---|---|
| \`src/checkout/usePromo.ts\` | New hook — validates against \`POST /v2/promos/validate\`, normalises the code, maps a 404 to a friendly error |
| \`src/checkout/PromoCodeField.tsx\` | New input + Apply button, disabled while a check is in flight |
| \`src/checkout/CheckoutSummary.tsx\` | Discount gets its own line; the total never goes below zero |
| \`src/checkout/usePromo.test.ts\` | Covers a valid code and an unknown one |

## Worth knowing

- Codes are trimmed and upper-cased before they're sent, so \` spring15 \` works.
- The discount is **re-validated by the server at payment time** — this hook only previews it.
- A failed check clears any previous discount rather than leaving a stale one applied.

Want me to loop a reviewer on this before you merge?`),
    ],
    5,
  ),
]);

const shortChat = (cwd, title, answer, hoursAgo = 3, turns = 3) => {
  const sid = uid();
  clock = now - hoursAgo * 3600_000;
  const rows = [];
  for (let i = 0; i < turns; i++) rows.push(user(i ? 'Keep going.' : title, 60 * 17), asst([text(answer)], 90));
  transcript(cwd, sid, rows);
  return sid;
};

const s2 = shortChat(storefront, 'Why is the cart totals test flaky?', 'It depends on `Date.now()` for the sale window. I pinned the clock with `vi.setSystemTime` in the suite setup.', 1.5, 4);
const s3 = shortChat(apiRepo, 'Rate-limit the /v2/orders endpoint', 'Added a token-bucket limiter (60 req/min per API key) in front of the orders router, with a `Retry-After` header on 429s.', 6.5, 6);
const s4 = shortChat(apiRepo, 'Add OpenAPI docs for promos', 'Documented `POST /v2/promos/validate` with request/response schemas and the 404 case.', 4.5, 3);
const s5 = shortChat(billing, 'Explain the invoice retry job', 'The retry job runs hourly and backs off 1h → 6h → 24h before handing the invoice to dunning.', 7.5, 2);
const s6 = shortChat(docsRepo, 'Draft the Q4 changelog', 'Drafted `CHANGELOG.md` with the promo codes, saved carts and the new orders rate limit.', 3, 5);

// ---------------------------------------------------------------- store

const conv = (name, sessionId, extra = {}) => ({
  id: uid(),
  name,
  sessionId,
  createdAt: now - 1000 * 60 * 60 * (2 + Math.random() * 20),
  lastActiveAt: now - 1000 * 60 * (2 + Math.random() * 300),
  totalCostUSD: 0,
  turnCount: 1,
  currentModel: 'claude-opus-5-5',
  permissionMode: 'acceptEdits',
  primaryBackend: 'claude',
  claudeModel: 'claude-opus-5-5',
  ...extra,
});

const hero = conv('Promo codes at checkout', heroSession, { lastActiveAt: now - 60_000, lastPromptAt: now - 9 * 60_000 });
const project = (name, dir, conversations) => ({ id: uid(), name, path: dir, conversations, lastOpenedAt: now });
const projects = [
  project('acme-storefront', storefront, [hero, conv('Why is the cart totals test flaky?', s2)]),
  project('acme-api', apiRepo, [
    conv('Rate-limit the /v2/orders endpoint', s3, { primaryBackend: 'claude', claudeModel: 'claude-sonnet-5-5', currentModel: 'claude-sonnet-5-5' }),
    conv('Add OpenAPI docs for promos', s4),
  ]),
  project('acme-billing', billing, [conv('Explain the invoice retry job', s5)]),
  project('acme-docs', docsRepo, [conv('Draft the Q4 changelog', s6)]),
];

const state = {
  projects,
  workspaces: [],
  colosseums: [],
  settings: { theme: THEME },
  selectedConversationId: hero.id,
};
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(USERDATA, { recursive: true });
fs.writeFileSync(path.join(USERDATA, 'overcli.json'), JSON.stringify(state, null, 2));
fs.writeFileSync(path.join(ROOT, 'seed-ids.json'), JSON.stringify({ hero: hero.id, home: realHome, storefront }, null, 2));

