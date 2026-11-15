// Labels and limits come from config/backend.yaml; the API base comes from VITE_API_BASE.
import { describe, expect, it } from 'vitest'
import { API_PREFIX, apiBaseFrom, CLIENT, HEALTH_TIMEOUT_MS, JOB_TIMEOUT_MS, LIVE_LABEL, OFFLINE_LABEL } from './config'
import { createApiClient } from './client'

describe('live config', () => {
  it('labels are the exact spec texts', () => {
    expect(LIVE_LABEL).toBe('Computed live · not part of the validated scorecard')
    expect(OFFLINE_LABEL).toBe('Live planning is offline · showing precomputed plans')
  })

  it('limits from config/backend.yaml', () => {
    expect(API_PREFIX).toBe('/api/v1')
    expect(HEALTH_TIMEOUT_MS).toBe(2000)
    expect(JOB_TIMEOUT_MS).toBe(600_000)
  })

  it('no single request may be held open near the 95 s cap; polling never exceeds the request timeout', () => {
    expect(CLIENT.requestTimeoutMs).toBeLessThan(95_000)
    expect(CLIENT.pollMaxMs).toBeLessThan(CLIENT.requestTimeoutMs)
  })

  it('VITE_API_BASE: default http://localhost:8012, trailing slash dropped', () => {
    expect(apiBaseFrom(undefined)).toBe('http://localhost:8012')
    expect(apiBaseFrom('  ')).toBe('http://localhost:8012')
    expect(apiBaseFrom('https://api.example.org/')).toBe('https://api.example.org')
  })

  it('client root and result base URLs', () => {
    const c = createApiClient({ base: 'https://api.example.org/' })
    expect(c.root).toBe('https://api.example.org/api/v1')
    expect(c.resultBase({ hash: '0123456789abcdef', result_url: '/api/v1/results/0123456789abcdef/' })).toBe(
      'https://api.example.org/api/v1/results/0123456789abcdef',
    )
    expect(c.resultBase({ hash: 'fedcba9876543210', result_url: null })).toBe('https://api.example.org/api/v1/results/fedcba9876543210')
  })
})
