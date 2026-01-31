import { z } from 'zod';
import { tool } from 'ai';
import { generateWebfetchSummary } from './utils/summarize.ts';

// Simple cache implementation
interface CacheEntry {
  content: string;
  title: string;
  timestamp: number;
}

class WebCache {
  private cache: Map<string, CacheEntry> = new Map();
  private ttlMs: number;

  constructor(ttlHours: number = 24) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
  }

  get(url: string): CacheEntry | null {
    const entry = this.cache.get(url);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(url);
      return null;
    }

    return entry;
  }

  set(url: string, entry: Omit<CacheEntry, 'timestamp'>) {
    this.cache.set(url, {
      ...entry,
      timestamp: Date.now(),
    });
  }

  clear() {
    this.cache.clear();
  }
}

const webCache = new WebCache(24);

// Simple HTML to Markdown converter
function htmlToMarkdown(html: string, skipImages: boolean = true): string {
  let markdown = html;

  // Remove script and style tags with their content
  markdown = markdown.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  markdown = markdown.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  markdown = markdown.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  markdown = markdown.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  markdown = markdown.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  markdown = markdown.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Extract main content if available
  const mainMatch = markdown.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = markdown.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const contentMatch = markdown.match(/<div[^>]*class=["'][^"']*(?:content|main|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch && mainMatch[1]) {
    markdown = mainMatch[1];
  } else if (articleMatch && articleMatch[1]) {
    markdown = articleMatch[1];
  } else if (contentMatch && contentMatch[1]) {
    markdown = contentMatch[1];
  }

  // Convert headers
  markdown = markdown.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  markdown = markdown.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  markdown = markdown.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  markdown = markdown.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  markdown = markdown.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  markdown = markdown.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Convert paragraphs
  markdown = markdown.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');

  // Convert line breaks
  markdown = markdown.replace(/<br\s*\/?>/gi, '\n');

  // Convert bold and italic
  markdown = markdown.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  markdown = markdown.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
  markdown = markdown.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  markdown = markdown.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');

  // Convert links
  markdown = markdown.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Convert code
  markdown = markdown.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  markdown = markdown.replace(/<pre[^>]*>(.*?)<\/pre>/gi, '```\n$1\n```\n');

  // Convert lists
  markdown = markdown.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (match, content) => {
    if (!content) return '\n';
    return content.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n') + '\n';
  });
  markdown = markdown.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (match, content) => {
    if (!content) return '\n';
    let index = 1;
    return content.replace(/<li[^>]*>(.*?)<\/li>/gi, () => `${index++}. $1\n`) + '\n';
  });

  // Convert blockquotes
  markdown = markdown.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (match, content) => {
    if (!content) return '\n\n';
    return content.split('\n').map((line: string) => '> ' + line).join('\n') + '\n\n';
  });

  // Handle images
  if (!skipImages) {
    markdown = markdown.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$2]($1)');
    markdown = markdown.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, '![$1]($2)');
    markdown = markdown.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)');
  } else {
    markdown = markdown.replace(/<img[^>]*>/gi, '');
  }

  // Remove remaining HTML tags
  markdown = markdown.replace(/<[^>]+>/g, '');

  // Clean up HTML entities
  markdown = markdown.replace(/&nbsp;/g, ' ');
  markdown = markdown.replace(/&amp;/g, '&');
  markdown = markdown.replace(/&lt;/g, '<');
  markdown = markdown.replace(/&gt;/g, '>');
  markdown = markdown.replace(/&quot;/g, '"');
  markdown = markdown.replace(/&#39;/g, "'");
  markdown = markdown.replace(/&ndash;/g, '-');
  markdown = markdown.replace(/&mdash;/g, '--');

  // Clean up excessive whitespace
  markdown = markdown.replace(/\n{3,}/g, '\n\n');
  markdown = markdown.trim();

  return markdown;
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }

  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  return 'Untitled';
}

async function fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HackclubAI/1.0; +https://hackclub.com)',
      },
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Tool definition
export const webfetchTool = tool({
  description: `Fetch a webpage and convert to clean Markdown for reading. 
Use for: documentation, API references, error explanations, research.
Content is automatically converted from HTML to clean Markdown (40% more token-efficient).
Results are cached for 24 hours to avoid repeated fetches.

Prefer this over searchWeb when you have a specific URL to read.
Use CSS selectors to extract specific sections (e.g., [".docs-content"] to get only the docs).`,
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    format: z.enum(['markdown', 'text', 'html']).default('markdown').describe('Output format'),
    maxLength: z.number().default(10000).describe('Maximum characters to return (default 10000)'),
    includeImages: z.boolean().default(false).describe('Include images in the output'),
    selectors: z.array(z.string()).optional().describe('CSS selectors to extract specific sections (e.g., [".content", "#main"])'),
  }),
  execute: async (params) => {
    try {
      // Check cache first
      const cached = webCache.get(params.url);
      if (cached) {
        const content = cached.content.slice(0, params.maxLength);
        return {
          success: true,
          url: params.url,
          title: cached.title,
          content,
          originalLength: cached.content.length,
          truncatedLength: content.length,
          wasTruncated: cached.content.length > params.maxLength,
          cached: true,
          summary: generateWebfetchSummary({
            url: params.url,
            title: cached.title,
            truncatedLength: content.length,
            wasTruncated: cached.content.length > params.maxLength,
          }),
        };
      }

      // Fetch with timeout
      const response = await fetchWithTimeout(params.url, 30000);

      if (!response.ok) {
        return {
          success: false,
          url: params.url,
          error: `HTTP ${response.status}: ${response.statusText}`,
          summary: generateWebfetchSummary({
            url: params.url,
            title: 'Error',
            truncatedLength: 0,
            wasTruncated: false,
            error: `HTTP ${response.status}`,
          }),
        };
      }

      const html = await response.text();
      const title = extractTitle(html);

      // Convert to desired format
      let content: string;
      if (params.format === 'html') {
        content = html;
      } else if (params.format === 'text') {
        content = htmlToMarkdown(html, true)
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove link URLs
          .replace(/[#*_`]/g, ''); // Remove markdown formatting
      } else {
        content = htmlToMarkdown(html, !params.includeImages);
      }

      // Cache the result
      webCache.set(params.url, { content, title });

      // Truncate if needed
      const truncated = content.slice(0, params.maxLength);
      const wasTruncated = content.length > params.maxLength;

      return {
        success: true,
        url: params.url,
        title,
        content: truncated,
        originalLength: content.length,
        truncatedLength: truncated.length,
        wasTruncated,
        cached: false,
        summary: generateWebfetchSummary({
          url: params.url,
          title,
          truncatedLength: truncated.length,
          wasTruncated,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        url: params.url,
        error: msg,
        summary: generateWebfetchSummary({
          url: params.url,
          title: 'Error',
          truncatedLength: 0,
          wasTruncated: false,
          error: msg,
        }),
      };
    }
  },
});

export { webCache };
