export type RetrievalMode = "hybrid" | "semantic" | "lexical";

export interface RetrievalFilters {
  folders?: string[];
  tags?: string[];
  properties?: Record<string, string | number | boolean>;
}

export interface SemanticChunkRecord {
  id: string;
  path: string;
  heading: string | null;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  citation: string;
  embeddingText: string;
  contentHash: string;
  metadata: Record<string, string[]>;
  sensitive: boolean;
  vector: Float32Array;
  modelId: string;
  dimensions: number;
  indexVersion: number;
  chunkerVersion: number;
  metadataVersion: number;
  updatedAt: number;
}

export interface PreparedChunk extends Omit<SemanticChunkRecord,
  "vector" | "modelId" | "dimensions" | "indexVersion" | "chunkerVersion" | "metadataVersion" | "updatedAt"> {}

export interface ScoredSemanticChunk {
  chunk: SemanticChunkRecord;
  score: number;
}

export interface EmbeddingModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: Record<string, string>;
  created?: number;
}

export interface EmbeddingBatchResult {
  vectors: Float32Array[];
  promptTokens: number;
  totalTokens: number;
}

export interface EmbeddingProvider {
  listEmbeddingModels(): Promise<EmbeddingModel[]>;
  embed(model: string, inputs: string[], signal: AbortSignal): Promise<EmbeddingBatchResult>;
}

export type SemanticJobState =
  | "disabled"
  | "idle"
  | "running"
  | "paused"
  | "cancelled"
  | "error";

export interface SemanticIndexStatus {
  enabled: boolean;
  state: SemanticJobState;
  reason: string | null;
  modelId: string;
  folders: string[];
  indexedNotes: number;
  indexedChunks: number;
  queuedNotes: number;
  completedChunks: number;
  failedChunks: number;
  skippedSensitiveNotes: number;
  promptTokens: number;
  estimatedCostUsd: number;
  startedAt: number | null;
  elapsedMs: number;
  partial: boolean;
  lastError: string | null;
}

export interface SemanticProgressListener {
  (status: SemanticIndexStatus): void;
}
