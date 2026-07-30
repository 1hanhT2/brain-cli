import type { ExpRecordInput } from "./exp-core";

export type ExpCompletionProposalState = "ready" | "needs-score" | "failed";

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isExpCompletionCutoff = (value: string): boolean => {
  if (!value) return true;
  const match = value.match(DATE_KEY_PATTERN);
  if (!match) return false;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

export const completionDateKey = (value: string): string | null => {
  const trimmed = value.trim();
  const prefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/)?.[1];
  if (prefix && isExpCompletionCutoff(prefix)) return prefix;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
};

export const completionMeetsCutoff = (completionAt: string, cutoff: string): boolean => {
  if (!cutoff) return true;
  if (!isExpCompletionCutoff(cutoff)) return false;
  const completion = completionDateKey(completionAt);
  return completion !== null && completion >= cutoff;
};

export interface ExpCompletionProposal {
  id: string;
  path: string;
  title: string;
  completionToken: string;
  completionAt: string;
  detectedAt: string;
  state: ExpCompletionProposalState;
  input?: ExpRecordInput;
  error?: string;
  queuePath?: string;
}

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const completionProposalId = (path: string, token: string): string =>
  `${stableHash(`${path.replace(/\\/g, "/")}\u0000${token}`)}-${stableHash(token)}`;
