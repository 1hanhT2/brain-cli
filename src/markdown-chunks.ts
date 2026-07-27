import type { TFile } from "obsidian";
import type { PreparedChunk, RetrievalFilters, SemanticChunkRecord } from "./semantic-types";

const NOISY_FRONTMATTER = new Set([
  "id",
  "uid",
  "created",
  "createdat",
  "updated",
  "updatedat",
  "modified",
  "completeddate",
  "datecreated",
  "datemodified",
  "history",
  "events",
  "recurrence",
  "rrule"
]);

export const normalizeVaultPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");

export const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const scalarValues = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (["string", "number", "boolean"].includes(typeof value)) return [String(value)];
  return [];
};

export const normalizeMetadata = (
  frontmatter: Record<string, unknown> | undefined
): Record<string, string[]> => {
  const metadata: Record<string, string[]> = {};
  for (const [rawKey, value] of Object.entries(frontmatter ?? {})) {
    const key = rawKey.trim().toLocaleLowerCase();
    if (!key || NOISY_FRONTMATTER.has(key.replace(/[_ -]/g, ""))) continue;
    const values = scalarValues(value).map((item) => item.trim()).filter(Boolean);
    if (values.length > 0) metadata[key] = values;
  }
  return metadata;
};

const metadataText = (metadata: Record<string, string[]>): string =>
  Object.entries(metadata)
    .map(([key, values]) => `${key}: ${values.join(", ")}`)
    .join("\n");

export const prepareMarkdownChunks = (
  file: Pick<TFile, "path" | "basename">,
  content: string,
  frontmatter: Record<string, unknown> | undefined,
  sensitive: boolean
): PreparedChunk[] => {
  const path = normalizeVaultPath(file.path);
  const metadata = normalizeMetadata(frontmatter);
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closing > 0) {
      for (let index = 0; index <= closing; index += 1) lines[index] = "";
    }
  }
  const chunks: PreparedChunk[] = [];
  let heading: string | null = null;
  let headingOrdinal = 0;
  let chunkOrdinal = 0;
  let start = 0;
  let buffer: string[] = [];

  const flush = (end: number) => {
    const excerpt = buffer.join("\n").trim();
    if (!excerpt) {
      buffer = [];
      start = end + 1;
      return;
    }
    const target = path.replace(/\.md$/i, "");
    const identity = `${path}|${heading ?? ""}|${headingOrdinal}|${chunkOrdinal}`;
    const prefix = [
      `Note: ${file.basename}`,
      `Path: ${path}`,
      metadataText(metadata),
      heading ? `Heading: ${heading}` : ""
    ].filter(Boolean).join("\n");
    chunks.push({
      id: `${stableHash(path)}:${headingOrdinal}:${chunkOrdinal}:${stableHash(identity)}`,
      path,
      heading,
      lineStart: start + 1,
      lineEnd: end + 1,
      excerpt,
      citation: `[[${target}${heading ? `#${heading}` : ""}]]`,
      embeddingText: `${prefix}\n\n${excerpt}`,
      contentHash: stableHash(`${prefix}\n${excerpt}`),
      metadata,
      sensitive
    });
    buffer = [];
    start = end + 1;
    chunkOrdinal += 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (headingMatch) {
      if (buffer.length > 0) flush(index - 1);
      heading = headingMatch[1];
      headingOrdinal += 1;
      chunkOrdinal = 0;
      start = index;
    }
    buffer.push(lines[index]);
    const bufferedLength = buffer.reduce((total, line) => total + line.length + 1, 0);
    if (bufferedLength >= 1_400 || (lines[index].trim() === "" && bufferedLength >= 700)) {
      flush(index);
    }
  }
  if (buffer.length > 0) flush(lines.length - 1);
  return chunks;
};

const normalizedValues = (values: string[]): string[] =>
  values.map((value) => value.toLocaleLowerCase());

export const chunkMatchesFilters = (
  chunk: Pick<SemanticChunkRecord, "path" | "metadata">,
  filters: RetrievalFilters
): boolean => {
  if (filters.folders?.length) {
    const path = normalizeVaultPath(chunk.path);
    if (!filters.folders.some((folder) => {
      const normalized = normalizeVaultPath(folder);
      return normalized === "" || path === normalized || path.startsWith(`${normalized}/`);
    })) return false;
  }
  if (filters.tags?.length) {
    const tags = normalizedValues(chunk.metadata.tags ?? []);
    if (!filters.tags.every((tag) => tags.includes(tag.replace(/^#/, "").toLocaleLowerCase()))) return false;
  }
  for (const [rawKey, expected] of Object.entries(filters.properties ?? {})) {
    const values = normalizedValues(chunk.metadata[rawKey.toLocaleLowerCase()] ?? []);
    if (!values.includes(String(expected).toLocaleLowerCase())) return false;
  }
  return true;
};
