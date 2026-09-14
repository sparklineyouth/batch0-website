import Anthropic from "@anthropic-ai/sdk";
import { DISCORD_AUTO_MODEL, DISCORD_AUTO_MAX_OUTPUT, DISCORD_AUTO_MAX_ESTIMATED_INPUT, DISCORD_AUTO_MAX_ACTUAL_INPUT, DISCORD_AUTO_RESERVATION_MICROUSD, DISCORD_AUTO_SYSTEM, buildQuestionInput, parseAutoAnswer, discordAutoCost } from "./discord-auto-policy.ts";

export type AutoGeneration = { answer: string | null; inputTokens: number; outputTokens: number };

export function createDiscordAutoAnswerer(apiKey: string, options: { fetch?: typeof fetch } = {}) {
  // Timeouts are ambiguous bills. Never automatically retry model requests.
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 20_000, fetch: options.fetch });
  return async function answer(question: string, context: string[], signal?: AbortSignal): Promise<AutoGeneration> {
    const input = {
      model: DISCORD_AUTO_MODEL, max_tokens: DISCORD_AUTO_MAX_OUTPUT,
      system: DISCORD_AUTO_SYSTEM,
      messages: [{ role: "user" as const, content: buildQuestionInput(question, context) }],
    };
    // Count first (free endpoint). Anthropic documents this as an estimate;
    // accept at most 10,000, leaving 2,000 input tokens of margin before the
    // SQL settlement ceiling. 12,000 actual input + 700 output cost $0.0155,
    // inside the fixed $0.016 reservation. Do not reclaim ambiguous failures.
    const count = await client.messages.countTokens({model:input.model,system:input.system,messages:input.messages},{signal});
    if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens > DISCORD_AUTO_MAX_ESTIMATED_INPUT || count.input_tokens < 0) {
      return {answer:null,inputTokens:0,outputTokens:0};
    }
    const response = await client.messages.create(input, { signal });
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    // Malformed/provider-discrepant usage must not produce an unaccounted
    // public answer. Throw so the caller retains the full reservation. No
    // caching, thinking, tools, or alternative models were requested.
    const cost = discordAutoCost(inputTokens, outputTokens);
    if (response.model !== DISCORD_AUTO_MODEL || inputTokens > DISCORD_AUTO_MAX_ACTUAL_INPUT || outputTokens > DISCORD_AUTO_MAX_OUTPUT || cost > DISCORD_AUTO_RESERVATION_MICROUSD ||
      (response.usage.cache_creation_input_tokens ?? 0) !== 0 || (response.usage.cache_read_input_tokens ?? 0) !== 0) {
      throw new Error("Discord AI response exceeded the reserved model usage bounds");
    }
    const raw = response.content.map(block => block.type === "text" ? block.text : "").join("");
    return {
      // Truncated JSON cannot accidentally become a public partial answer.
      answer: response.stop_reason === "end_turn" ? parseAutoAnswer(raw) : null,
      inputTokens,
      outputTokens,
    };
  };
}
