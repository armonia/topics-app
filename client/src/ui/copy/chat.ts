/**
 * Chat with the AI: the list of chats, a new chat, a conversation, the chat
 * inside a card, and the sentences of the answers. The answers are built from
 * the data of the organization (`ui-gallery/orbit/model/assistant.ts`); here
 * live only the words around that data. A function that takes a token
 * (`ChatSeg`) returns the line as pieces, so the token stays clickable.
 * Values in `i18n-ui-chat-it.ts` and `i18n-ui-chat-en.ts`.
 */
import type { ChatSeg } from '../chat/model';

/** The ideas a question is recognised by: each holds the beginnings of words (lowercase, no accents) that name it. */
export type ChatWord =
  | 'stuck' | 'due' | 'mine' | 'summary' | 'missing' | 'approver' | 'value' | 'contract' | 'flow' | 'town';

export interface ChatCopy {
  title: string;
  newChat: string;
  allChats: string;
  /** The age of a chat under a minute, in the sidebar. */
  justNow: string;
  /** How long ago a chat moved, in the sidebar: «17 h fa», «ieri», a weekday. */
  age: { minutes: (n: number) => string; hours: (n: number) => string; yesterday: string; weekdays: string[] };
  /** Words a short chat title never ends on (articles, prepositions). */
  titleStop: string[];
  /** The title of an example chat, shorter than its question. */
  exampleTitle: { due: string; flow: (name: string) => string };
  untitled: string;
  list: {
    count: (n: number) => string;
    open: (title: string) => string;
  };
  start: {
    title: (org: string) => string;
    body: string;
    suggestions: string;
  };
  composer: { placeholder: string; cardPlaceholder: string };
  typing: string;
  card: {
    heading: string;
    context: string;
    contextHint: string;
    original: (n: number, first: string) => string;
    step: (n: number, total: number, title: string) => string;
    questions: { summary: string; missing: string; approver: string; value: (label: string) => string };
  };
  /** Questions the chat suggests, built from the data of the organization. */
  examples: {
    stuck: string;
    due: string;
    mine: string;
    contract: (counterparty: string) => string;
    flow: (name: string) => string;
  };
  /** How a question is recognised. */
  words: Record<ChatWord, string[]>;
  /** The answers. */
  reply: {
    scope: { flow: (name: string) => string; town: (name: string) => string };
    stuckNone: (scope?: string) => string;
    stuckIntro: (n: number, scope?: string) => string;
    stuckSince: (age: string) => string;
    stuckOver: (stage: string, limit: string) => string;
    /** The link that opens the whole list when an answer shows only the first few: `place` is the page it opens. */
    moreLink: (total: number, place: string, feminine: boolean) => string;
    places: { inbox: string; flows: string; contracts: string };
    dueIntro: (n: number, to: string, scope?: string) => string;
    dueNone: (to: string, scope?: string) => string;
    overdueIntro: (n: number) => string;
    contractDatesIntro: (n: number) => string;
    dueLine: (days: number, day: string) => string;
    dateKind: { end: string; notice: string };
    mineNone: (who?: string) => string;
    mineIntro: (n: number, who?: string) => string;
    contractsWaiting: (n: number, who?: string) => string;
    contractsIntro: (n: number) => string;
    contractMany: (n: number) => string;
    contractHead: (contract: ChatSeg, status: string, counterparty: string, from: string, to?: string) => ChatSeg[];
    contractValue: (money: string, period: 'anno' | 'totale' | 'mese') => string;
    renewal: {
      none: string;
      tacit: (months: number, notice: string, days: number) => string;
      option: (months: number, notice: string, days: number) => string;
    };
    nextDate: (what: string, day: string, days: number) => string;
    nothingAhead: string;
    waitsFor: (who: string, action: string) => string;
    variant: (title: string) => string;
    linkedCards: string;
    flowsIntro: (n: number) => string;
    flowHead: (flow: ChatSeg, trigger: string) => ChatSeg[];
    flowFrom: (source: string) => string;
    flowGives: (outcome: string) => string;
    flowSteps: (n: number) => string;
    actorRule: string;
    flowNow: (open: number, stopped: number) => string;
    townIntro: (name: string, n: number) => string;
    townNone: (name: string) => string;
    townContracts: (name: string) => string;
    /** The summary of a card, in sentences: where it is, who it waits for, what comes next. */
    summary: {
      is: (card: ChatSeg, stage: string, flow: ChatSeg, n: number, total: number, step: string) => ChatSeg[];
      isDone: (card: ChatSeg, flow: ChatSeg) => ChatSeg[];
      blocked: (age: string, reason: string) => string;
      stuck: (age: string, stage: string) => string;
      worker: (who: string, doing: string) => string;
      waitsCheck: (who: string) => string;
      waitsApprove: (who: string) => string;
      proposal: (text: string) => string;
      due: (day: string, days: number) => string;
      values: (n: number) => string;
    };
    cardStopped: (age: string, reason: string) => string;
    /** The first line of an answer about a card: which card, and what is asked of it. */
    about: { missing: (card: ChatSeg) => ChatSeg[]; approver: (card: ChatSeg) => ChatSeg[]; value: (card: ChatSeg) => ChatSeg[] };
    missingDone: string;
    missingStopped: (reason: string, age: string) => string;
    missingLow: (labels: string[]) => string;
    missingSteps: (n: number) => string;
    missingNothing: string;
    approverNow: (who: string, stage: string) => string;
    approverCheck: (who: string, step: string) => string;
    approverApprove: (who: string, step: string) => string;
    approverNone: string;
    approverDue: (day: string, days: number) => string;
    approverNoDue: string;
    valueIs: (label: string, value: string, confidence: number) => string;
    valueFrom: (original: ChatSeg) => ChatSeg[];
    valuesIntro: (n: number) => string;
    valuesNone: string;
    unknownIntro: (org: string) => string;
    abilities: string[];
    unknownTry: string;
  };
}
