import * as fs from 'fs';
import * as path from 'path';

export interface AgentsMdContext {
  content: string;
  lastModified: number;
  sections: Map<string, string>;
}

export class AgentsMdLoader {
  private cache: AgentsMdContext | null = null;
  private cachePath: string | null = null;

  async load(projectPath: string): Promise<AgentsMdContext | null> {
    const agentsMdPath = path.join(projectPath, 'AGENTS.md');

    try {
      const stats = await fs.promises.stat(agentsMdPath);

      // Check if cached version is still valid
      if (this.cache && this.cachePath === agentsMdPath && this.cache.lastModified >= stats.mtimeMs) {
        return this.cache;
      }

      const content = await fs.promises.readFile(agentsMdPath, 'utf-8');
      const sections = this.parseSections(content);

      this.cache = {
        content,
        lastModified: stats.mtimeMs,
        sections,
      };
      this.cachePath = agentsMdPath;

      return this.cache;
    } catch {
      return null;
    }
  }

  private parseSections(content: string): Map<string, string> {
    const sections = new Map<string, string>();
    const lines = content.split('\n');
    let currentSection = '';
    let currentContent: string[] = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (currentSection) {
          sections.set(currentSection, currentContent.join('\n'));
        }
        currentSection = line.replace('## ', '').trim();
        currentContent = [];
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections.set(currentSection, currentContent.join('\n'));
    }

    return sections;
  }

  getSection(sectionName: string): string | undefined {
    return this.cache?.sections.get(sectionName);
  }

  invalidateCache() {
    this.cache = null;
    this.cachePath = null;
  }
}

export const agentsMdLoader = new AgentsMdLoader();

export function formatAgentsMdForContext(context: AgentsMdContext | null, maxLength: number = 2000): string {
  if (!context) {
    return '';
  }

  const trimmedContent = context.content.slice(0, maxLength);
  const isTruncated = context.content.length > maxLength;

  return `
## Project Context (from AGENTS.md)

${trimmedContent}${isTruncated ? '\n\n... (truncated)' : ''}
`;
}
