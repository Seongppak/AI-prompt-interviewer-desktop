import type { AIProvider, GenerateRequest, GenerateResponse } from '../../../packages/core/src'

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models'
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
const EXCLUDED_MODEL_PATTERN = /embedding|aqa|imagen|veo|tts|image|audio|live|learnlm/i
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

type Fetcher = typeof fetch

export type GeminiDiagnosticCode =
  | 'models_resolved'
  | 'model_discovery_failed'
  | 'request_started'
  | 'request_retrying'
  | 'request_succeeded'
  | 'invalid_request'
  | 'authentication'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'service_unavailable'
  | 'timeout'
  | 'network_error'
  | 'unknown_error'

export interface GeminiDiagnosticEvent {
  level: 'info' | 'warn' | 'error'
  code: GeminiDiagnosticCode
  message: string
  model?: string
  status?: number
  attempt?: number
  durationMs?: number
  retryable?: boolean
  detail?: string
}

export interface GeminiAIProviderOptions {
  apiKey: string
  fetcher?: Fetcher
  models?: string[]
  timeoutMs?: number
  maxAttemptsPerModel?: number
  retryBaseDelayMs?: number
  onDiagnostic?: (event: GeminiDiagnosticEvent) => void
}

interface ListedModel {
  name?: string
  supportedGenerationMethods?: string[]
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

export interface GeminiFailedAttempt {
  model: string
  status?: number
  code: GeminiDiagnosticCode
  detail: string
}

export class GeminiProviderError extends Error {
  readonly attempts: GeminiFailedAttempt[]

  constructor(message: string, attempts: GeminiFailedAttempt[]) {
    super(message)
    this.name = 'GeminiProviderError'
    this.attempts = attempts
  }
}

function scoreModel(name: string): number {
  let score = name.includes('flash') ? 100 : name.includes('pro') ? 70 : 40
  if (name.includes('lite')) score -= 10

  // 운영 앱은 예고 없이 교체되는 latest/preview보다 고정된 stable 모델을 우선한다.
  if (name.endsWith('-latest')) score -= 20
  else if (/preview|exp/.test(name)) score -= 35
  else score += 40

  const version = /gemini-(\d+)(?:\.(\d+))?/.exec(name)
  if (version) score += Number(version[1]) * 10 + Number(version[2] ?? 0)
  return score
}

function supportsDisabledThinking(model: string): boolean {
  // thinkingBudget=0 지원이 명시된 2.5 Flash 계열에만 보낸다.
  // -latest는 다른 세대로 바뀔 수 있으므로 기능을 추측하지 않는다.
  return /^gemini-2\.5-flash(?:-lite)?(?:$|-)/.test(model)
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
    || error instanceof Error && /timed out|timeout/i.test(error.message)
}

function hardQuotaExceeded(status: number, detail: string): boolean {
  return status === 429 && /check your plan and billing|daily quota|billing|quota[^.]*reset/i.test(detail)
}

function classifyFailure(status: number, detail: string): GeminiDiagnosticCode {
  if (status === 400) return 'invalid_request'
  if (status === 401 || status === 403) return 'authentication'
  if (hardQuotaExceeded(status, detail)) return 'quota_exceeded'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'service_unavailable'
  return 'unknown_error'
}

function friendlyFailure(attempts: GeminiFailedAttempt[]): string {
  const codes = new Set(attempts.map((attempt) => attempt.code))
  if (codes.has('authentication')) {
    return 'Gemini API 인증에 실패했습니다. 저장된 API 키와 Google Cloud 프로젝트 권한을 확인하세요.'
  }
  if (codes.has('quota_exceeded')) {
    return 'Gemini API 할당량이 초과되었습니다. Google AI Studio에서 사용량·결제를 확인하거나 할당량 초기화 후 다시 시도하세요.'
  }
  if (codes.has('rate_limited')) {
    return 'Gemini 요청 한도에 도달했습니다. 자동 재시도에도 실패했습니다. 잠시 후 다시 시도하세요.'
  }
  if (codes.has('service_unavailable')) {
    return 'Gemini 서비스가 혼잡합니다. 자동 재시도와 다른 모델 전환에도 실패했습니다. 잠시 후 다시 시도하세요.'
  }
  if (codes.has('timeout') || codes.has('network_error')) {
    return 'Gemini 연결이 시간 안에 완료되지 않았습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.'
  }
  if (codes.has('invalid_request')) {
    return '현재 Gemini 모델이 요청 옵션을 지원하지 않습니다. 로그 분석에서 실패 모델과 옵션을 확인하세요.'
  }
  return 'Gemini 요청에 실패했습니다. 로그 분석 메뉴에서 상세 원인과 권장 조치를 확인하세요.'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class GeminiAIProvider implements AIProvider {
  private readonly fetcher: Fetcher
  private readonly timeoutMs: number
  private readonly maxAttemptsPerModel: number
  private readonly retryBaseDelayMs: number
  private readonly options: GeminiAIProviderOptions
  private resolvedModels?: Promise<string[]>

  constructor(options: GeminiAIProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('Gemini API 키가 필요합니다.')
    this.options = options
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.maxAttemptsPerModel = Math.max(1, options.maxAttemptsPerModel ?? 3)
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 750)
  }

  private emit(event: GeminiDiagnosticEvent): void {
    this.options.onDiagnostic?.(event)
  }

  private endpoint(model: string): string {
    return `${API_ROOT}/${model}:generateContent`
  }

  private async discoverModels(): Promise<string[]> {
    if (this.options.models?.length) {
      this.emit({ level: 'info', code: 'models_resolved', message: '지정된 Gemini 모델 목록을 사용합니다.', detail: this.options.models.join(', ') })
      return this.options.models
    }
    try {
      const response = await this.fetcher(API_ROOT, {
        headers: { 'x-goog-api-key': this.options.apiKey },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      })
      if (!response.ok) throw new Error(`모델 목록 조회 실패 (${response.status})`)
      const data = await response.json() as { models?: ListedModel[] }
      const models = (data.models ?? [])
        .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
        .map((model) => (model.name ?? '').replace(/^models\//, ''))
        .filter((name) => name && !EXCLUDED_MODEL_PATTERN.test(name))
        .sort((a, b) => scoreModel(b) - scoreModel(a))
      const resolved = models.length ? models : FALLBACK_MODELS
      this.emit({ level: 'info', code: 'models_resolved', message: '사용 가능한 안정 Gemini 모델을 우선순위로 정렬했습니다.', detail: resolved.slice(0, 5).join(', ') })
      return resolved
    } catch (error) {
      this.emit({ level: 'warn', code: 'model_discovery_failed', message: '모델 목록 조회에 실패해 안정 모델 기본값을 사용합니다.', detail: String(error) })
      return FALLBACK_MODELS
    }
  }

  private models(): Promise<string[]> {
    this.resolvedModels ??= this.discoverModels()
    return this.resolvedModels
  }

  private request(request: GenerateRequest, model: string): Promise<Response> {
    return this.fetcher(this.endpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.options.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: request.prompt }] }],
        generationConfig: {
          ...(request.responseFormat === 'json' ? {
            responseMimeType: 'application/json',
            ...(request.schema ? { responseSchema: request.schema } : {}),
          } : {}),
          ...(supportsDisabledThinking(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
    })
  }

  private retryDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1)
    const jitter = Math.floor(Math.random() * Math.max(1, this.retryBaseDelayMs / 3))
    return exponential + jitter
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const failures: GeminiFailedAttempt[] = []
    const limit = request.purpose === 'prompt-optimization' ? 2 : 3

    for (const model of (await this.models()).slice(0, limit)) {
      for (let attempt = 1; attempt <= this.maxAttemptsPerModel; attempt++) {
        const startedAt = performance.now()
        this.emit({ level: 'info', code: 'request_started', message: 'Gemini 요청을 시작했습니다.', model, attempt })

        let response: Response
        try {
          response = await this.request(request, model)
        } catch (error) {
          const code: GeminiDiagnosticCode = isTimeout(error) ? 'timeout' : 'network_error'
          const detail = String(error)
          const retryable = attempt < this.maxAttemptsPerModel
          failures.push({ model, code, detail })
          this.emit({
            level: retryable ? 'warn' : 'error', code,
            message: code === 'timeout' ? 'Gemini 요청 시간이 초과되었습니다.' : 'Gemini 네트워크 요청에 실패했습니다.',
            model, attempt, durationMs: Math.round(performance.now() - startedAt), retryable, detail,
          })
          if (!retryable) break
          const delay = this.retryDelay(attempt)
          this.emit({ level: 'warn', code: 'request_retrying', message: `${delay}ms 후 요청을 재시도합니다.`, model, attempt, retryable: true })
          await sleep(delay)
          continue
        }

        if (response.ok) {
          const data = await response.json() as GeminiResponse
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
          if (!text) {
            const detail = '응답에 결과 텍스트가 없습니다.'
            failures.push({ model, code: 'unknown_error', detail })
            this.emit({ level: 'error', code: 'unknown_error', message: detail, model, attempt })
            break
          }
          this.emit({ level: 'info', code: 'request_succeeded', message: 'Gemini 요청이 성공했습니다.', model, attempt, durationMs: Math.round(performance.now() - startedAt) })
          return { text, model }
        }

        const detail = (await response.text().catch(() => '')).slice(0, 500)
        const code = classifyFailure(response.status, detail)
        const retryable = RETRYABLE_STATUSES.has(response.status)
          && !hardQuotaExceeded(response.status, detail)
          && attempt < this.maxAttemptsPerModel
        failures.push({ model, status: response.status, code, detail })
        this.emit({
          level: retryable ? 'warn' : 'error', code,
          message: `Gemini API가 ${response.status} 오류를 반환했습니다.`,
          model, status: response.status, attempt,
          durationMs: Math.round(performance.now() - startedAt), retryable, detail,
        })

        if (code === 'authentication') throw new GeminiProviderError(friendlyFailure(failures), failures)
        if (!retryable) break

        const delay = this.retryDelay(attempt)
        this.emit({ level: 'warn', code: 'request_retrying', message: `${delay}ms 후 요청을 재시도합니다.`, model, attempt, retryable: true })
        await sleep(delay)
      }
    }

    throw new GeminiProviderError(friendlyFailure(failures), failures)
  }
}
