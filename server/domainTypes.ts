export type DomainSourceStatus = 'ok' | 'empty' | 'unavailable' | 'not_configured'
export type DomainSourceId = 'dns' | 'rdap' | 'certificates' | 'archive' | 'urlscan' | 'history' | 'relationships' | 'reputation'

export interface DomainSource {
  id: DomainSourceId
  label: string
  status: DomainSourceStatus
  message: string
  url: string
  observedAt?: string
}
export interface DomainFact {
  label: string
  value: string
  sourceId: DomainSourceId
  inferred?: boolean
}
export interface DomainFinding {
  id: string
  title: string
  detail: string
  evidence: string
  level: 'notice' | 'warning'
  sourceId: DomainSourceId
  observedAt?: string
  measurements?: Record<string, number | boolean>
}
export interface DomainConnection {
  domain: string
  kind: 'certificate' | 'request' | 'shared_identifier'
  evidence: string
  sourceId: DomainSourceId
  observedAt?: string
}
export interface DomainEvent {
  date: string
  label: string
  detail: string
  sourceId: DomainSourceId
  url?: string
}
export interface DomainDnsRecord {
  type: string
  name: string
  value: string
  ttl: number
}
export interface DomainReport {
  version: 1
  domain: string
  queriedAt: string
  cacheHit: boolean
  sources: DomainSource[]
  facts: DomainFact[]
  dns: DomainDnsRecord[]
  findings: DomainFinding[]
  connections: DomainConnection[]
  timeline: DomainEvent[]
}

export interface DomainKeys {
  URLSCAN_API_KEY?: string
  SECURITYTRAILS_API_KEY?: string
  BUILTWITH_API_KEY?: string
  VIRUSTOTAL_API_KEY?: string
}
