type SideMessage = { role: string; content?: string; partial?: boolean };

/** Why a side question gave no answer; the panel turns the code into the reader's language. */
export class SideQuestionError extends Error {
  constructor(readonly code: "not-started" | "no-answer") { super(code); }
}

export async function askSideQuestion(options: {
  mainSessionKey: string;
  sideSessionKey: string;
  question: string;
  loadHistory: (sessionKey: string) => Promise<unknown>;
  sendMessage: (sessionKey: string, content: string) => Promise<boolean>;
  getSessionMessages: (sessionKey: string) => SideMessage[];
}): Promise<string> {
  if (options.mainSessionKey === options.sideSessionKey) throw new Error("side question must use its forked session");
  await options.loadHistory(options.sideSessionKey);
  if (!await options.sendMessage(options.sideSessionKey, options.question)) throw new SideQuestionError("not-started");
  const answer = [...options.getSessionMessages(options.sideSessionKey)].reverse()
    .find((message) => message.role === "assistant" && !message.partial)?.content?.trim();
  if (!answer) throw new SideQuestionError("no-answer");
  return answer;
}
