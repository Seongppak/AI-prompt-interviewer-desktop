import { describe, expect, it } from 'vitest'
import { analyzeDiagnostics, type DiagnosticEntry } from '../src/diagnostics'

function entry(code: string, level: DiagnosticEntry['level'] = 'error'): DiagnosticEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    source: 'gemini',
    code,
    message: code,
  }
}

describe('desktop diagnostics analysis', () => {
  it('groups repeated failures into actionable issues', () => {
    const issues = analyzeDiagnostics([
      entry('quota_exceeded'),
      entry('quota_exceeded'),
      entry('service_unavailable', 'warn'),
      entry('request_succeeded', 'info'),
    ])

    expect(issues.map((issue) => issue.code)).toEqual(['quota_exceeded', 'service_unavailable'])
    expect(issues[0]).toMatchObject({ count: 2, severity: 'error' })
    expect(issues[0]?.action).toContain('Google AI Studio')
  })

  it('does not report informational retry progress as a problem', () => {
    expect(analyzeDiagnostics([
      entry('request_started', 'info'),
      entry('request_retrying', 'warn'),
      entry('request_succeeded', 'info'),
    ])).toEqual([])
  })
})
