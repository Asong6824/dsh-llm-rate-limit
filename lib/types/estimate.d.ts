import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/**
 * Estimate one complete provider request for token-bucket reservation.
 * @param options - immutable model request to price.
 * @param configuredOutputTokens - fallback output allowance when the request has no explicit cap.
 * @param imageTokens - fixed allowance for each image block.
 * @returns positive safe-integer input-plus-output reservation.
 */
export declare function estimateRequestTokens(options: GenerateOptions, configuredOutputTokens: number, imageTokens: number): number;
