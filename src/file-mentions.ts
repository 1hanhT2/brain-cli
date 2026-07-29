export interface AtQuery {
  query: string;
  start: number;
  end: number;
}

export const findAtQuery = (value: string, cursor = value.length): AtQuery | null => {
  const safeCursor = Math.min(Math.max(cursor, 0), value.length);
  const beforeCursor = value.slice(0, safeCursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@\[\]]*)$/);
  if (!match) return null;
  const token = match[0].trimStart();
  const start = safeCursor - token.length;
  return {
    query: match[1] ?? "",
    start,
    end: safeCursor
  };
};

export const fileMention = (path: string): string =>
  `@[[${path.replace(/\\/g, "/")}]]`;

export const extractFileMentions = (value: string): string[] =>
  [...new Set([...value.matchAll(/@\[\[([^\]\r\n]+)\]\]/g)]
    .map((match) => (match[1] ?? "")
      .split("|")[0]
      .split("#")[0]
      .trim()
      .replace(/\\/g, "/"))
    .filter(Boolean))];
