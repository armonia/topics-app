/**
 * The competitor facts, in one place because two pages quote them.
 *
 * Every field about a product other than ours is quoted or paraphrased from
 * that vendor's own public page, fetched on the date in READ_ON. Where a page
 * does not state something, the value is "Not stated" — never a guess, and
 * never a number we measured ourselves on someone else's software.
 *
 * The home page renders a four-column subset of this and links to the full
 * table. Having one source means the short version cannot quietly drift from
 * the long one, which is the failure mode of every comparison page that keeps
 * a "summary" beside a "details".
 */

export const READ_ON = '4 August 2026';

export interface Tool {
  name: string;
  /** True for us. The table marks our column rather than hiding the bias. */
  us?: boolean;
  url: string;
  licence: string;
  platforms: string;
  price: string;
  /** The line the whole comparison turns on. */
  where: string;
  account: string;
  agents: string;
  source: string;
  /** Shown on the home page only — the short form of the same fact. */
  shortWhere?: string;
}

export const tools: Tool[] = [
  {
    name: 'Topics',
    us: true,
    url: 'https://topics.armonia.io',
    licence: 'MIT, open source',
    platforms: 'macOS, Windows, Linux · PWA on phone',
    price: '$0 for the whole app',
    where: 'Your machine',
    shortWhere: 'Your machine. No server of ours in the path.',
    account: 'None',
    agents: 'Claude Code, Codex, OpenCode, Gemini CLI, any ACP agent, Anthropic and OpenAI APIs',
    source: 'This site',
  },
  {
    name: 'Conductor',
    url: 'https://www.conductor.build/pricing',
    licence: 'Not stated',
    platforms: '"Local workspaces on your Mac"',
    price: 'Free $0 · Pro $50/mo · Teams $60/mo/user',
    where: 'Local, or their cloud on Pro and above',
    shortWhere: 'Local, or their cloud, where chat messages are stored on their servers.',
    account: 'Required for the paid plans',
    agents: '"Bring your own subscriptions and keys"',
    source: 'conductor.build/pricing',
  },
  {
    name: 'Devin Desktop',
    url: 'https://devin.ai/desktop',
    licence: 'Not stated',
    platforms: '"Download for MacOS", no other build offered',
    price: 'Not stated on the product page',
    where: '"Fleets of local and cloud agents"',
    shortWhere: '"Fleets of local and cloud agents."',
    account: 'Sign-up required',
    agents: 'Agent Client Protocol (ACP)',
    source: 'devin.ai/desktop',
  },
  {
    name: 'Zed',
    url: 'https://zed.dev/pricing',
    licence: 'Open source',
    platforms: 'macOS, Linux, Windows',
    price: 'Personal $0 forever · Pro $10/mo · Business $30/seat/mo',
    where: 'Your machine',
    shortWhere: 'Your machine.',
    account: 'Not for the free plan',
    agents: '"Unlimited use with your API keys or external agents like Claude Agent, Codex CLI, and more"',
    source: 'zed.dev/pricing',
  },
  {
    name: 'Cline',
    url: 'https://cline.bot/pricing',
    licence: 'Open source',
    platforms: 'VS Code extension and a CLI, not a desktop app',
    price: 'Free for individuals · Enterprise on request',
    where: 'Your machine',
    shortWhere: 'Your machine, inside VS Code.',
    account: 'Not for the open-source extension',
    agents: 'Bring your own key across many providers',
    source: 'cline.bot/pricing',
  },
  {
    name: 'Claude Code alone',
    url: 'https://docs.anthropic.com/en/docs/claude-code',
    licence: 'Proprietary CLI',
    platforms: 'Any terminal',
    price: 'Your Anthropic plan or API key',
    where: 'Your machine',
    shortWhere: 'Your machine, one session at a time.',
    account: 'Anthropic account',
    agents: 'Itself',
    source: 'Anthropic docs',
  },
];

export const rows = [
  ['Licence', 'licence'],
  ['Platforms', 'platforms'],
  ['Price', 'price'],
  ['Where the work runs', 'where'],
  ['Account required', 'account'],
  ['Agents it drives', 'agents'],
] as const;

/** The four the home page has room for, in the order it shows them. */
export const HOME_SUBSET = ['Topics', 'Conductor', 'Devin Desktop', 'Zed'] as const;

export const homeTools = HOME_SUBSET.map((name) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`compare: no tool named ${name}`);
  return t;
});
