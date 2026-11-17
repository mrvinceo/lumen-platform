import { toProviderError } from "../errors.js";
import type { EmbeddingModel } from "../llm.js";
import { DEFAULT_TIMEOUT_MS, type ModelConfig, requireKey, runTest } from "./common.js";
import { checkDimension } from "./openai.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { total_tokens?: number };
}

/** Voyage has no official TypeScript SDK; its REST API is small enough to call directly. */
export function voyageEmbeddingModel(cfg: ModelConfig & { dimension: number }): EmbeddingModel {
  const doFetch = cfg.fetch ?? fetch;
  const embed = async (texts: string[], kind: "query" | "document") => {
    const apiKey = requireKey(cfg);
    let res: Response;
    try {
      res = await doFetch(VOYAGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          input: texts,
          input_type: kind,
          output_dimension: cfg.dimension,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw toProviderError(err, apiKey);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw toProviderError({ status: res.status, message: body.slice(0, 500) }, apiKey);
    }
    const json = (await res.json()) as VoyageResponse;
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, tokens: json.usage?.total_tokens ?? 0 };
  };
  return {
    provider: "voyage",
    model: cfg.model,
    dimension: cfg.dimension,
    maxBatch: 128,
    embed,
    test: () =>
      runTest(cfg.apiKey, async () => {
        const { vectors } = await embed(["Lumen connection test"], "query");
        return checkDimension(vectors[0]?.length ?? 0, cfg.dimension);
      }),
  };
}
