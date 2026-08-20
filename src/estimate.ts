import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const MESSAGE_OVERHEAD = 4

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Price model content recursively without resolving attachment bytes. */
function contentTokens(blocks: readonly ContentBlock[], imageTokens: number): number {
  let total = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        total += textTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'image':
        total += imageTokens + BLOCK_OVERHEAD
        break
      case 'tool-call':
        total += textTokens(block.name) + textTokens(block.arguments) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        total += contentTokens(block.content, imageTokens) + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks retain a
        // conservative structural JSON price under the fixed heuristic.
        total += textTokens(JSON.stringify(block)) + BLOCK_OVERHEAD
    }
  }
  return total
}

/**
 * Estimate one complete provider request for token-bucket reservation.
 * @param options - immutable model request to price.
 * @param configuredOutputTokens - fallback output allowance when the request has no explicit cap.
 * @param imageTokens - fixed allowance for each image block.
 * @returns positive safe-integer input-plus-output reservation.
 */
export function estimateRequestTokens(
  options: GenerateOptions,
  configuredOutputTokens: number,
  imageTokens: number,
): number {
  let total = options.system === undefined ? 0 : textTokens(options.system) + MESSAGE_OVERHEAD
  for (const message of options.messages) {
    total += contentTokens(message.content, imageTokens) + MESSAGE_OVERHEAD
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    total += textTokens(JSON.stringify(options.tools)) + BLOCK_OVERHEAD
  }
  if (options.stop !== undefined && options.stop.length > 0) {
    total += textTokens(JSON.stringify(options.stop)) + BLOCK_OVERHEAD
  }
  total += options.maxTokens ?? configuredOutputTokens
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, total))
}
