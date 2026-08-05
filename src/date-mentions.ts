export interface NaturalDateQuery {
  query: string;
  start: number;
  end: number;
}

export interface NaturalDateCandidate {
  phrase: string;
  date: Date;
  isoDate: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

const cloneLocalDate = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const addLocalDays = (date: Date, days: number): Date => {
  const result = cloneLocalDate(date);
  result.setDate(result.getDate() + days);
  return result;
};

const normalizedPhrase = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/[\s-]+/g, " ");

const titlePhrase = (value: string): string =>
  value.replace(/\b\w/g, (character) => character.toLocaleUpperCase());

export const localIsoDate = (date: Date): string => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0")
].join("-");

export const findNaturalDateAtQuery = (
  value: string,
  cursor = value.length
): NaturalDateQuery | null => {
  const safeCursor = Math.min(Math.max(cursor, 0), value.length);
  const beforeCursor = value.slice(0, safeCursor);
  const spaced = beforeCursor.match(/(?:^|\s)@((?:this|next|last)[ -]+[a-z]*)$/i);
  const compact = beforeCursor.match(/(?:^|\s)@([^\s@\[\]]*)$/);
  const match = spaced ?? compact;
  if (!match) return null;
  const token = match[0].trimStart();
  return {
    query: match[1] ?? "",
    start: safeCursor - token.length,
    end: safeCursor
  };
};

export const naturalDateCandidates = (
  query: string,
  now = new Date()
): NaturalDateCandidate[] => {
  const normalizedQuery = normalizedPhrase(query);
  if (!normalizedQuery) return [];
  const today = cloneLocalDate(now);
  const definitions: Array<{ phrase: string; resolve: () => Date }> = [
    { phrase: "today", resolve: () => today },
    { phrase: "yesterday", resolve: () => addLocalDays(today, -1) },
    { phrase: "tomorrow", resolve: () => addLocalDays(today, 1) }
  ];

  for (const [weekday, phrase] of WEEKDAYS.entries()) {
    definitions.push({
      phrase,
      resolve: () => addLocalDays(today, (weekday - today.getDay() + 7) % 7)
    });
  }

  const monday = addLocalDays(today, -((today.getDay() + 6) % 7));
  for (const [weekOffset, qualifier] of [[0, "this"], [7, "next"], [-7, "last"]] as const) {
    for (const [weekday, weekdayName] of WEEKDAYS.entries()) {
      const isoWeekdayOffset = (weekday + 6) % 7;
      definitions.push({
        phrase: `${qualifier} ${weekdayName}`,
        resolve: () => addLocalDays(monday, weekOffset + isoWeekdayOffset)
      });
    }
  }

  return definitions
    .filter(({ phrase }) => normalizedPhrase(phrase).startsWith(normalizedQuery))
    .map(({ phrase, resolve }) => {
      const date = resolve();
      return { phrase: titlePhrase(phrase), date, isoDate: localIsoDate(date) };
    });
};
