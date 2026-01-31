/**
 * Tool result summarization utilities for context efficiency
 * Reduces token usage by generating human-readable summaries
 */

export interface ToolResult<T> {
  data: T;
  summary: string;
  dataTokens: number;
  summaryTokens: number;
}

export function createSummarizedResult<T>(
  data: T,
  summaryGenerator: (data: T) => string
): ToolResult<T> {
  const summary = summaryGenerator(data);

  return {
    data,
    summary,
    dataTokens: estimateTokens(JSON.stringify(data)),
    summaryTokens: estimateTokens(summary),
  };
}

export function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token on average
  return Math.ceil(text.length / 4);
}

export function estimateObjectTokens(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj));
}

// Summary generators for specific tool types
export function generateReadFileSummary(result: {
  filePath: string;
  totalLines: number;
  truncated: boolean;
  error?: string;
}): string {
  if (result.error) {
    return `Failed to read ${result.filePath}: ${result.error}`;
  }
  return `Read ${result.totalLines} lines from ${result.filePath}${result.truncated ? ' (truncated)' : ''}`;
}

export function generateListFilesSummary(result: {
  count: number;
  path: string;
  error?: string;
}): string {
  if (result.error) {
    return `Failed to list files: ${result.error}`;
  }
  return `Found ${result.count} entries in ${result.path || '.'}`;
}

export function generateSearchCodebaseSummary(result: {
  query: string;
  matches: number;
  truncated: boolean;
  error?: string;
}): string {
  if (result.error) {
    return `Search failed: ${result.error}`;
  }
  return `Searched "${result.query}": ${result.matches} match${result.matches !== 1 ? 'es' : ''}${result.truncated ? ' (truncated)' : ''}`;
}

export function generateRunCommandSummary(result: {
  requestedCommand: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  error?: string;
}): string {
  if (result.error) {
    return `Command "${result.requestedCommand}" failed: ${result.error}`;
  }
  if (result.timedOut) {
    return `Command "${result.requestedCommand}" timed out`;
  }
  return `Ran "${result.requestedCommand}": exit code ${result.exitCode} (${result.success ? 'success' : 'failed'})`;
}

export function generateWriteFileSummary(result: {
  filePath: string;
  success: boolean;
  bytesWritten: number;
  overwritten: boolean;
  error?: string;
}): string {
  if (result.error) {
    return `Write failed: ${result.error}`;
  }
  return `Wrote ${result.bytesWritten} bytes to ${result.filePath}${result.overwritten ? ' (overwritten)' : ''}`;
}

export function generateEditFileSummary(result: {
  file: string;
  success: boolean;
  editsApplied: number;
  error?: string;
}): string {
  if (result.error) {
    return `Edit failed: ${result.error}`;
  }
  return `Applied ${result.editsApplied} edit${result.editsApplied !== 1 ? 's' : ''} to ${result.file}`;
}

export function generateWebfetchSummary(result: {
  url: string;
  title: string;
  truncatedLength: number;
  wasTruncated: boolean;
  error?: string;
}): string {
  if (result.error) {
    return `Failed to fetch ${result.url}: ${result.error}`;
  }
  const domain = new URL(result.url).hostname;
  return `Fetched "${result.title}" from ${domain} (${result.truncatedLength} chars${result.wasTruncated ? ', truncated' : ''})`;
}

export function generateTodoSummary(result: {
  action: string;
  todoTitle: string;
  status?: string;
  error?: string;
}): string {
  if (result.error) {
    return `Todo operation failed: ${result.error}`;
  }
  return `${result.action}: "${result.todoTitle}"${result.status ? ` (${result.status})` : ''}`;
}

export function generateQuestionSummary(result: {
  question: string;
  answer: string;
  error?: string;
}): string {
  if (result.error) {
    return `Question failed: ${result.error}`;
  }
  return `Asked: "${result.question.substring(0, 50)}..." -> Answered: "${result.answer.substring(0, 30)}..."`;
}

export function generateLSPSummary(result: {
  method: string;
  filePath: string;
  resultCount: number;
  error?: string;
}): string {
  if (result.error) {
    return `LSP ${result.method} failed: ${result.error}`;
  }
  return `LSP ${result.method} on ${result.filePath}: ${result.resultCount} result${result.resultCount !== 1 ? 's' : ''}`;
}
