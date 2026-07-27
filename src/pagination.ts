export const DEFAULT_PAGE_SIZE = 30;

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
  outOfRange: boolean;
}

export const paginate = <T>(
  items: T[],
  requestedPage = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Page<T> => {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const outOfRange = totalItems > 0 && page > totalPages;
  const offset = (page - 1) * safePageSize;
  return {
    items: outOfRange ? [] : items.slice(offset, offset + safePageSize),
    page,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    offset,
    hasPrevious: page > 1 && !outOfRange,
    hasNext: page < totalPages && !outOfRange,
    outOfRange
  };
};

export const readLeadingPage = (parts: string[]): {
  page: number;
  remaining: string[];
} => {
  const candidate = parts[0] ?? "";
  if (!/^[1-9]\d*$/.test(candidate)) return { page: 1, remaining: parts };
  return {
    page: Number.parseInt(candidate, 10),
    remaining: parts.slice(1)
  };
};
