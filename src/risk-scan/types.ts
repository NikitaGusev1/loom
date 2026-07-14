export const RISK_REGISTRY_SCHEMA_VERSION = 1 as const;

export type RiskLens = 'integration' | 'reliability' | 'trust-boundaries' | 'maintainability';
export type RiskKind = 'bug' | 'risk' | 'improvement';
export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskConfidence = 'high' | 'medium' | 'low';
export type RiskStatus = 'open' | 'accepted' | 'fixed' | 'dismissed' | 'deferred';

export interface RiskScanDiffMetadata {
  committed: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface RiskScanContext {
  repositoryRoot: string;
  projectSlug: string;
  branch: string | null;
  head: string;
  baseRef: string;
  baseCommit: string;
  mergeBase: string;
  workingTreeStatus: string[];
  seedSource: 'diff' | 'explicit';
  seedPaths: string[];
  noSeeds: boolean;
  diff: RiskScanDiffMetadata;
}

export interface RiskRegistryEntry {
  id: string;
  fingerprint: string;
  lens: RiskLens;
  kind: RiskKind;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  status: RiskStatus;
  title: string;
  evidence: string[];
  affectedPaths: string[];
  seedRelationship: string;
  failureScenario: string;
  suggestedAction: string;
  rootCause?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceReports: string[];
}

export interface RiskRegistryPersistenceDiagnostic {
  code: 'lock-release-failed';
  message: string;
}

export interface RiskRegistry {
  schemaVersion: typeof RISK_REGISTRY_SCHEMA_VERSION;
  projectSlug: string;
  updatedAt: string;
  entries: RiskRegistryEntry[];
}

export interface RiskCandidateEntry {
  lens: RiskLens;
  kind: RiskKind;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  status?: 'open' | 'deferred';
  title: string;
  evidence: string[];
  affectedPaths: string[];
  seedRelationship: string;
  failureScenario: string;
  suggestedAction: string;
  primaryAnchor?: string;
  rootCause?: string;
}

export interface RiskCandidateSet {
  schemaVersion: typeof RISK_REGISTRY_SCHEMA_VERSION;
  projectSlug: string;
  entries: RiskCandidateEntry[];
}

export interface RiskRegistryMergeSummary {
  registryPath: string;
  projectSlug: string;
  added: number;
  refreshed: number;
  total: number;
  report: string;
}
