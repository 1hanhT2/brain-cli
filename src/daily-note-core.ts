export interface DailyNoteSettings {
  folder: string;
  format: string;
  template: string;
}

export const DEFAULT_DAILY_NOTE_SETTINGS: DailyNoteSettings = {
  folder: "",
  format: "YYYY-MM-DD",
  template: ""
};

const stringSetting = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/\\/g, "/") : "";

export const parseDailyNoteSettings = (raw: string | null): DailyNoteSettings => {
  if (raw === null || raw.trim() === "") return { ...DEFAULT_DAILY_NOTE_SETTINGS };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Daily Notes configuration must be a JSON object.");
  }
  const values = parsed as Record<string, unknown>;
  return {
    folder: stringSetting(values.folder).replace(/^\/+|\/+$/g, ""),
    format: stringSetting(values.format) || DEFAULT_DAILY_NOTE_SETTINGS.format,
    template: stringSetting(values.template).replace(/^\/+|\/+$/g, "")
  };
};

export const dailyNotePath = (
  settings: DailyNoteSettings,
  formattedDate: string
): string => {
  const relative = formattedDate.replace(/\\/g, "/").replace(/^\/+/, "");
  const path = settings.folder ? `${settings.folder}/${relative}` : relative;
  return path.toLocaleLowerCase().endsWith(".md") ? path : `${path}.md`;
};

export const dailyTemplatePaths = (template: string): string[] => {
  const normalized = stringSetting(template).replace(/^\/+|\/+$/g, "");
  if (!normalized) return [];
  return normalized.toLocaleLowerCase().endsWith(".md")
    ? [normalized]
    : [`${normalized}.md`, normalized];
};

export const renderDailyTemplate = (
  template: string,
  formatDate: (format: string) => string,
  formatTime: (format: string) => string
): string => template
  .replace(/\{\{date(?::([^}]+))?\}\}/gi, (_match, format: string | undefined) =>
    formatDate(format?.trim() || "YYYY-MM-DD")
  )
  .replace(/\{\{time(?::([^}]+))?\}\}/gi, (_match, format: string | undefined) =>
    formatTime(format?.trim() || "HH:mm")
  );

export type DailyNoteCreationResult<T> =
  | { status: "denied" }
  | { status: "existing"; file: T }
  | { status: "created"; file: T };

export const createDailyNoteSafely = async <T>(options: {
  confirm: () => Promise<boolean>;
  findExisting: () => T | null | Promise<T | null>;
  create: () => Promise<T>;
}): Promise<DailyNoteCreationResult<T>> => {
  if (!await options.confirm()) return { status: "denied" };
  const existing = await options.findExisting();
  if (existing) return { status: "existing", file: existing };
  try {
    return { status: "created", file: await options.create() };
  } catch (error) {
    const raced = await options.findExisting();
    if (raced) return { status: "existing", file: raced };
    throw error;
  }
};
