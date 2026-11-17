export type Audience = "public" | "staff";

export interface Citation {
  n: number;
  chunkId?: string;
  documentId?: string;
  title: string;
  headings?: string[];
  page?: number;
  snippet?: string;
  score?: number;
}

export interface ChatSource {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  headings: string[];
  page?: number;
  text: string;
  score: number;
  via: string[];
  audience: Audience;
}

export type ChatEvent =
  | { type: "meta"; conversationId: string; userMessageId: string }
  | {
      type: "sources";
      query: string;
      condensed: boolean;
      sources: ChatSource[];
      skipped: { kbId: string; reason: string }[];
    }
  | { type: "delta"; text: string }
  | {
      type: "done";
      messageId: string;
      citations: Citation[];
      usage: { tokensIn: number; tokensOut: number };
      finishReason: string;
      latencyMs: number;
      fallback: boolean;
    }
  | { type: "error"; code: string; message: string; messageId?: string };
