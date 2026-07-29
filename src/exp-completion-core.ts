import type { ExpRecordInput } from "./exp-core";

export type ExpCompletionProposalState = "ready" | "needs-score" | "failed";

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
