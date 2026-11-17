import type { ChatMessage, ChatModel } from "../llm.js";
import { completeChat } from "./complete.js";

const SYSTEM = `You turn the latest message in a conversation into a standalone search query for a document search engine.
Resolve pronouns and references using the earlier conversation ("it", "that one", "what about digital ones?").
Keep the user's wording and any names, codes or numbers. Reply with the query only: no quotes, no explanation.`;

/**
 * Rewrites a follow-up question so it can be searched on its own. First questions are returned unchanged, and
 * any failure falls back to the original question: condensing improves retrieval but must never block an answer.
 */
export async function condenseQuestion(
  model: ChatModel,
  history: ChatMessage[],
  question: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ query: string; condensed: boolean; tokensIn: number; tokensOut: number }> {
  if (history.length === 0) return { query: question, condensed: false, tokensIn: 0, tokensOut: 0 };
  const transcript = history
    .slice(-6)
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content}`,
    )
    .join("\n");
  try {
    const r = await completeChat(model, {
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${transcript}\n\nLatest message: ${question}\n\nStandalone search query:`,
        },
      ],
      maxTokens: 2_000,
      signal: opts.signal,
    });
    const query = r.text.trim().replace(/^["'“]|["'”]$/g, "");
    if (!query || query.length > 500)
      return { query: question, condensed: false, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    return { query, condensed: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch {
    return { query: question, condensed: false, tokensIn: 0, tokensOut: 0 };
  }
}
