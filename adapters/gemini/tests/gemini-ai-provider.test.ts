import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiAIProvider } from '../src'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GeminiAIProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('binds the browser fetch function to globalThis', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(jsonResponse({
        candidates: [{ content: { parts: [{ text: '바인딩된 응답' }] } }],
      }))
    })
    const provider = new GeminiAIProvider({ apiKey: 'test-secret', models: ['gemini'] })

    await expect(provider.generate({ purpose: 'prompt-optimization', prompt: 'x' }))
      .resolves.toEqual({ text: '바인딩된 응답', model: 'gemini' })
  })

  it('sends the Core optimization prompt to Gemini and returns rewritten text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: '새로 작성된 최종 프롬프트' }] } }],
    }))
    const provider = new GeminiAIProvider({
      apiKey: 'test-secret',
      models: ['gemini-flash-latest'],
      fetcher,
    })

    const result = await provider.generate({
      purpose: 'prompt-optimization',
      prompt: '원문과 인터뷰 결정을 통합해서 새 프롬프트를 작성하라',
      responseFormat: 'text',
    })

    expect(result).toEqual({ text: '새로 작성된 최종 프롬프트', model: 'gemini-flash-latest' })
    const [, init] = fetcher.mock.calls[0]!
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'test-secret' })
    expect(String(init?.body)).toContain('원문과 인터뷰 결정을 통합')
  })

  it('does not guess thinkingConfig support for a latest alias', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] } }],
    }))
    const provider = new GeminiAIProvider({
      apiKey: 'test-secret',
      models: ['gemini-flash-latest'],
      fetcher,
    })

    await provider.generate({ purpose: 'interview-questions', prompt: '질문 생성', responseFormat: 'json' })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('thinkingBudget')
  })

  it('disables thinking only for a known compatible 2.5 Flash model', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] } }],
    }))
    const provider = new GeminiAIProvider({ apiKey: 'test-secret', models: ['gemini-2.5-flash-lite'], fetcher })

    await provider.generate({ purpose: 'interview-questions', prompt: '질문 생성', responseFormat: 'json' })

    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('thinkingBudget')
  })

  it('retries a transient 503 response and emits diagnostic events', async () => {
    const diagnostics = vi.fn()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'high demand' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [{ text: '성공' }] } }] }))
    const provider = new GeminiAIProvider({
      apiKey: 'test-secret', models: ['gemini-2.5-flash'], fetcher,
      retryBaseDelayMs: 0, onDiagnostic: diagnostics,
    })

    await expect(provider.generate({ purpose: 'prompt-optimization', prompt: 'x' }))
      .resolves.toEqual({ text: '성공', model: 'gemini-2.5-flash' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: 'request_retrying' }))
  })

  it('returns a short actionable message for exhausted quota', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: { message: 'You exceeded your current quota, please check your plan and billing details' },
    }, 429))
    const provider = new GeminiAIProvider({ apiKey: 'test-secret', models: ['gemini-2.5-flash'], fetcher })

    await expect(provider.generate({ purpose: 'prompt-optimization', prompt: 'x' }))
      .rejects.toThrow('할당량이 초과되었습니다')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not include the API key in authentication errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 403))
    const provider = new GeminiAIProvider({ apiKey: 'never-log-this', models: ['gemini'], fetcher })
    await expect(provider.generate({ purpose: 'prompt-optimization', prompt: 'x' }))
      .rejects.not.toThrow('never-log-this')
  })
})
