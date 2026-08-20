import { describe, expect, it } from 'vitest'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateRequestTokens } from '../src/estimate.ts'

describe('request token estimation', () => {
  it('prices every core content block and optional request field', () => {
    const options: GenerateOptions = {
      provider: 'mock',
      model: 'model',
      system: '1234',
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: '1234' },
          { type: 'reasoning', text: '12345678' },
          { type: 'image', attachment: {} as never },
          { type: 'tool-call', id: CallId('call'), name: 'tool', arguments: '{}' },
          {
            type: 'tool-result',
            toolCallId: CallId('call'),
            content: [{ type: 'text', text: 'result' }],
          },
          { type: 'future', value: '1234' } as unknown as ContentBlock,
        ],
      })],
      tools: [{ name: 'tool', description: 'test', parameters: { type: 'object' } }],
      stop: ['STOP'],
      maxTokens: 17,
    }

    expect(estimateRequestTokens(options, 99, 20)).toBeGreaterThan(17)
  })

  it('uses the configured output allowance and clamps the result', () => {
    const base: GenerateOptions = { provider: 'mock', model: 'model', messages: [] }
    expect(estimateRequestTokens(base, 7, 1)).toBe(7)
    expect(estimateRequestTokens({ ...base, maxTokens: 0 }, 7, 1)).toBe(1)
    expect(estimateRequestTokens({ ...base, system: 'x'.repeat(16) }, Number.MAX_SAFE_INTEGER, 1))
      .toBe(Number.MAX_SAFE_INTEGER)
  })
})
