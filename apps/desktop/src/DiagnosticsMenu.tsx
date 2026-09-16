import { useEffect, useMemo, useState } from 'react'
import {
  analyzeDiagnostics,
  clearDiagnostics,
  getDiagnostics,
  subscribeDiagnostics,
  type DiagnosticEntry,
} from './diagnostics'

function download(entries: DiagnosticEntry[]) {
  const contents = entries.map((entry) => JSON.stringify(entry)).join('\n')
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/x-ndjson;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `aipi-diagnostics-${new Date().toISOString().slice(0, 10)}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function DiagnosticsMenu({ onOpenGemini }: { onOpenGemini: () => void }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<DiagnosticEntry[]>(getDiagnostics)
  const issues = useMemo(() => analyzeDiagnostics(entries), [entries])
  const errorCount = entries.filter((entry) => entry.level === 'error').length

  useEffect(() => subscribeDiagnostics(setEntries), [])
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  return <>
    <button className="log-menu-button" type="button" onClick={() => setOpen(true)}>
      로그 분석 <span>{errorCount}</span>
    </button>

    {open && <div className="log-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setOpen(false)
    }}>
      <aside className="log-drawer" role="dialog" aria-modal="true" aria-label="앱 로그 분석">
        <header>
          <div><span className="step-label">DIAGNOSTICS</span><h2>로그 분석</h2>
            <p>API 키와 프롬프트는 기록하지 않습니다. 최근 로그 {entries.length}개를 보관합니다.</p></div>
          <button type="button" className="log-close" onClick={() => setOpen(false)} aria-label="로그 닫기">×</button>
        </header>

        <section className={`diagnostic-summary ${issues.length ? 'has-issues' : 'is-healthy'}`}>
          <strong>{issues.length ? `감지된 문제 ${issues.length}개` : '현재 감지된 문제 없음'}</strong>
          <span>{issues.length ? '아래 원인과 권장 조치를 순서대로 확인하세요.' : 'Gemini 요청 실패가 발생하면 자동으로 원인을 분류합니다.'}</span>
        </section>

        {issues.length > 0 && <div className="diagnostic-issues">
          {issues.map((issue) => <article className={`diagnostic-issue ${issue.severity}`} key={issue.code}>
            <div><strong>{issue.title}</strong><span>{issue.count}회 · 최근 {new Date(issue.lastSeen).toLocaleString('ko-KR')}</span></div>
            <p><b>원인</b>{issue.cause}</p><p><b>조치</b>{issue.action}</p>
          </article>)}
          <button className="open-ai-studio" type="button" onClick={onOpenGemini}>Google AI Studio 열기 ↗</button>
        </div>}

        <div className="log-toolbar"><span>{entries.length} entries · error {errorCount}</span><div>
          <button type="button" onClick={() => download(entries)} disabled={!entries.length}>다운로드</button>
          <button type="button" onClick={clearDiagnostics} disabled={!entries.length}>지우기</button>
        </div></div>

        <div className="log-list">{entries.length === 0
          ? <p className="empty-logs">기록된 로그가 없습니다.</p>
          : entries.slice().reverse().map((entry) => <article className={`log-entry log-${entry.level}`} key={entry.id}>
            <div className="log-entry-meta"><span>{entry.level}</span><code>{entry.source}:{entry.code}</code>
              <time>{new Date(entry.timestamp).toLocaleTimeString('ko-KR')}</time></div>
            <p>{entry.message}</p>
            <div className="log-facts">
              {entry.model && <span>model {entry.model}</span>}{entry.status && <span>HTTP {entry.status}</span>}
              {entry.attempt && <span>시도 {entry.attempt}</span>}{entry.durationMs !== undefined && <span>{entry.durationMs}ms</span>}
            </div>
            {entry.detail && <details><summary>상세 응답</summary><pre>{entry.detail}</pre></details>}
          </article>)}
        </div>
      </aside>
    </div>}
  </>
}
