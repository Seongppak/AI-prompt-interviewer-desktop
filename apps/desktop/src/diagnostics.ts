import type { GeminiDiagnosticCode, GeminiDiagnosticEvent } from '../../../adapters/gemini/src'

const STORAGE_KEY = 'aipi_desktop_diagnostics_v1'
const CHANGE_EVENT = 'aipi-diagnostics-change'
const MAX_ENTRIES = 300

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticEntry {
  id: string
  timestamp: string
  level: DiagnosticLevel
  source: string
  code: string
  message: string
  model?: string
  status?: number
  attempt?: number
  durationMs?: number
  retryable?: boolean
  detail?: string
}

export interface DiagnosticIssue {
  code: string
  severity: 'warning' | 'error'
  title: string
  cause: string
  action: string
  count: number
  lastSeen: string
}

type NewDiagnostic = Omit<DiagnosticEntry, 'id' | 'timestamp'> & { timestamp?: string }

function safeEntries(value: string | null): DiagnosticEntry[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed as DiagnosticEntry[] : []
  } catch {
    return []
  }
}

export function getDiagnostics(): DiagnosticEntry[] {
  return safeEntries(localStorage.getItem(STORAGE_KEY))
}

export function recordDiagnostic(entry: NewDiagnostic): void {
  const next: DiagnosticEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    detail: entry.detail?.slice(0, 1000),
  }
  try {
    const updated = [...getDiagnostics(), next].slice(-MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: updated }))
  } catch {
    // 진단 저장 실패가 본 작업까지 중단시키면 안 된다.
  }
}

export function recordGeminiDiagnostic(event: GeminiDiagnosticEvent): void {
  recordDiagnostic({ ...event, source: 'gemini' })
}

export function clearDiagnostics(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: [] }))
}

export function subscribeDiagnostics(listener: (entries: DiagnosticEntry[]) => void): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<DiagnosticEntry[]>).detail ?? getDiagnostics())
  }
  window.addEventListener(CHANGE_EVENT, handle)
  return () => window.removeEventListener(CHANGE_EVENT, handle)
}

interface IssueDefinition {
  title: string
  cause: string
  action: string
  severity: DiagnosticIssue['severity']
}

const ISSUE_DEFINITIONS: Partial<Record<GeminiDiagnosticCode | 'app_error', IssueDefinition>> = {
  authentication: {
    severity: 'error',
    title: 'API 인증 또는 권한 오류',
    cause: 'API 키가 만료·삭제되었거나 프로젝트에 Gemini API 권한이 없습니다.',
    action: '저장된 API 키를 다시 확인하고 Google AI Studio에서 키 상태를 점검하세요.',
  },
  quota_exceeded: {
    severity: 'error',
    title: 'Gemini 할당량 초과',
    cause: '일일 사용량이나 결제 기반 할당량이 소진되었습니다.',
    action: 'Google AI Studio의 Usage/Rate limits와 결제를 확인하거나 할당량 초기화를 기다리세요.',
  },
  rate_limited: {
    severity: 'warning',
    title: '요청 속도 제한',
    cause: '짧은 시간에 요청 또는 토큰 사용량이 한도를 넘었습니다.',
    action: '자동 재시도가 끝난 뒤 잠시 기다렸다가 다시 실행하세요.',
  },
  service_unavailable: {
    severity: 'warning',
    title: 'Gemini 서버 혼잡',
    cause: 'Gemini 서비스가 일시적으로 과부하 상태이거나 응답할 수 없습니다.',
    action: '앱이 자동 재시도하고 다른 모델로 전환합니다. 계속 실패하면 잠시 후 다시 시도하세요.',
  },
  timeout: {
    severity: 'warning',
    title: '응답 시간 초과',
    cause: '20초 안에 Gemini 응답을 받지 못했습니다.',
    action: '인터넷 연결을 확인하세요. 서버 혼잡이면 잠시 후 다시 시도하세요.',
  },
  network_error: {
    severity: 'error',
    title: '네트워크 연결 오류',
    cause: 'Gemini 서버까지 요청을 전달하지 못했습니다.',
    action: '인터넷·VPN·방화벽 설정을 확인한 뒤 다시 시도하세요.',
  },
  invalid_request: {
    severity: 'error',
    title: '모델 옵션 호환 오류',
    cause: '선택된 Gemini 모델이 요청 옵션 또는 JSON 스키마를 지원하지 않습니다.',
    action: '현재 버전에서는 모델별 옵션을 자동 판별합니다. 반복되면 상세 로그를 다운로드해 확인하세요.',
  },
  model_discovery_failed: {
    severity: 'warning',
    title: '모델 목록 조회 실패',
    cause: '사용 가능한 모델 목록을 불러오지 못해 기본 안정 모델을 사용했습니다.',
    action: '기본 모델도 실패하면 API 키 권한과 네트워크를 확인하세요.',
  },
  unknown_error: {
    severity: 'error',
    title: '분류되지 않은 Gemini 오류',
    cause: 'Gemini가 예상하지 못한 응답을 반환했습니다.',
    action: '상세 로그를 다운로드해 응답 코드와 메시지를 확인하세요.',
  },
  app_error: {
    severity: 'error',
    title: '앱 처리 오류',
    cause: 'Gemini 외의 앱 처리 과정에서 오류가 발생했습니다.',
    action: '최신 상세 로그를 확인하고 같은 동작에서 반복되는지 점검하세요.',
  },
}

export function analyzeDiagnostics(entries: DiagnosticEntry[]): DiagnosticIssue[] {
  const grouped = new Map<string, DiagnosticEntry[]>()
  for (const entry of entries) {
    if (entry.level === 'info' || !ISSUE_DEFINITIONS[entry.code as keyof typeof ISSUE_DEFINITIONS]) continue
    const current = grouped.get(entry.code) ?? []
    current.push(entry)
    grouped.set(entry.code, current)
  }

  return [...grouped.entries()].map(([code, matching]) => {
    const definition = ISSUE_DEFINITIONS[code as keyof typeof ISSUE_DEFINITIONS]!
    return {
      code,
      ...definition,
      count: matching.length,
      lastSeen: matching.at(-1)!.timestamp,
    }
  }).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return Date.parse(b.lastSeen) - Date.parse(a.lastSeen)
  })
}
