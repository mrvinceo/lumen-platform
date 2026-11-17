import type { ChatModel, ChatRequest } from "../llm.js";

export interface CompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
}

/** Runs a chat request to completion by collecting the stream (every adapter streams). */
export async function completeChat(model: ChatModel, req: ChatRequest): Promise<CompletionResult> {
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let finishReason = "other";
  for await (const d of model.stream(req)) {
    if (d.type === "text") text += d.text;
    else if (d.type === "usage") {
      tokensIn += d.tokensIn;
      tokensOut += d.tokensOut;
    } else if (d.type === "done") finishReason = d.finishReason;
  }
  return { text, tokensIn, tokensOut, finishReason };
}
