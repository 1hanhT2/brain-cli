export const isMemoryMarkdownPath = (path: string, memoryRoot: string): boolean =>
  path.startsWith(`${memoryRoot}/`) && path.toLocaleLowerCase().endsWith(".md");

export const isMemoryFrontmatter = (frontmatter: Record<string, unknown>): boolean =>
  frontmatter.type === "memory";
