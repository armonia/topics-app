export interface UsageRecord {
  timestamp: number;
  sessionKey: string;
  topicId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface DaySummary {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface ModelSummary {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface TopicSummary {
  topicId: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageSummary {
  daily: Record<string, DaySummary>;
  byModel: Record<string, ModelSummary>;
  byTopic: Record<string, TopicSummary>;
  totalCostUsd: number;
  totalTokens: number;
  totalRequests: number;
}
