type SideMessage = { role: string; content?: string; partial?: boolean };

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
  if (!await options.sendMessage(options.sideSessionKey, options.question)) throw new Error("il turno non è partito");
  const answer = [...options.getSessionMessages(options.sideSessionKey)].reverse()
    .find((message) => message.role === "assistant" && !message.partial)?.content?.trim();
  if (!answer) throw new Error("la risposta non è arrivata");
  return answer;
}
