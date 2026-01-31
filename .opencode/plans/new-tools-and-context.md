# Implementation Plan: New Tools and Context Management

## Executive Summary

This plan outlines the addition of four new tools (LSP, Todo, Question, Webfetch) and significant context management improvements inspired by OpenCode, Claude Code, and Codex best practices.

---

## Part 1: New Tools Implementation

### 1. LSP Tool (Build & Plan Agents)

**Purpose**: Language Server Protocol integration for code intelligence - diagnostics, go-to-definition, find references, type information.

**Why**: Agents need to understand code semantics beyond text search. LSP provides real-time type errors, symbol navigation, and code intelligence without loading entire files into context.

**Architecture**:
```typescript
// tools/lsp.ts
interface LSPClient {
  server: ChildProcess;
  projectRoot: string;
  capabilities: LSPServerCapabilities;
}

interface LSPRequest {
  method: 'diagnostics' | 'definition' | 'references' | 'hover' | 'completion';
  filePath: string;
  line?: number;
  character?: number;
  symbol?: string;
}

interface LSPResponse {
  method: string;
  filePath: string;
  result: Diagnostic[] | Location[] | HoverInfo | CompletionItem[];
  summary: string; // Brief summary for context management
}
```

**Implementation Steps**:
1. Create `tools/lsp.ts` with LSP client management
2. Support TypeScript (tsserver), Python (pylsp), Go (gopls), Rust (rust-analyzer)
3. Implement lazy server startup - only start when tool is called
4. Cache server connections per project root
5. Auto-shutdown after inactivity (5 minutes)

**Tool Definition**:
```typescript
export const lspTool = tool({
  description: `Code intelligence via Language Server Protocol. 
Use for: finding definitions, references, type information, diagnostics.
ALWAYS prefer this over searchCodebase for semantic code understanding.
Provides precise results without loading file contents into context.`,
  inputSchema: z.object({
    method: z.enum(['diagnostics', 'definition', 'references', 'hover', 'completion']),
    filePath: z.string(),
    line: z.number().optional(),
    character: z.number().optional(),
    symbol: z.string().optional(),
  }),
  execute: async (params) => {
    // Connect to appropriate LSP server
    // Execute request
    // Return summarized results
  }
});
```

**Context Efficiency**:
- Returns structured data (locations, types) not full file contents
- Summarizes large result sets (e.g., "47 references found in 12 files")
- Allows drilling down with follow-up calls
- No file content loaded into LLM context unless explicitly read

**Agent Assignment**:
- **Plan Agent**: Use for architecture understanding, exploring code structure
- **Build Agent**: Use for implementing changes, finding references to update

---

### 2. Todo Tool (Build Agent Only)

**Purpose**: Track implementation tasks within a session, providing structured task management without external state.

**Why**: Build agent needs to track multi-step implementations. A todo system provides:
- Clear progress tracking
- Recovery from interruptions
- Context summarization (only active todos need full detail)

**Architecture**:
```typescript
// tools/todo.ts
interface Todo {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  createdAt: number;
  completedAt?: number;
  dependsOn?: string[];
  fileContext?: string[]; // Related files
  notes?: string;
}

interface TodoManager {
  todos: Map<string, Todo>;
  currentTodoId?: string;
}
```

**Implementation Steps**:
1. Create `tools/todo.ts` with in-memory todo management
2. Persist todos in agent context (not external storage - session-scoped)
3. Support CRUD operations via tool calls
4. Auto-generate todo list from implementation plans
5. Integrate with agent stop conditions (check todos complete)

**Tool Definitions**:
```typescript
export const createTodoTool = tool({
  description: 'Create a new todo item for tracking implementation tasks',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    dependsOn: z.array(z.string()).optional(),
  }),
  execute: async (params) => {
    const todo: Todo = {
      id: generateId(),
      ...params,
      status: 'pending',
      createdAt: Date.now(),
    };
    todoManager.add(todo);
    return { todo, message: `Created todo: ${todo.title}` };
  }
});

export const updateTodoTool = tool({
  description: 'Update todo status (mark in_progress, completed, blocked)',
  inputSchema: z.object({
    todoId: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
    notes: z.string().optional(),
  }),
  execute: async (params) => {
    const todo = todoManager.update(params.todoId, params.status, params.notes);
    return { todo, message: `Updated todo ${todo.title} to ${params.status}` };
  }
});

export const listTodosTool = tool({
  description: 'List all todos with filtering options',
  inputSchema: z.object({
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    limit: z.number().default(20),
  }),
  execute: async (params) => {
    const todos = todoManager.list(params);
    return { 
      todos, 
      summary: generateSummary(todos), // Brief summary for context
      count: todos.length 
    };
  }
});
```

**Context Efficiency**:
- Only active/in-progress todos include full descriptions
- Completed todos are summarized (title + completion time only)
- Todo list is pruned after 50 items (archive old completed)
- Critical for long-running Build agent sessions

**Agent Assignment**:
- **Build Agent**: Full access - create todos from plan, update as implementing
- **Plan Agent**: Read-only - can view todos but not modify (planning shouldn't create todos, only the implementation should)

---

### 3. Question Tool (Build & Plan Agents)

**Purpose**: Interactive clarification questions when agents need user input to proceed.

**Why**: Prevents agents from making incorrect assumptions. Instead of guessing, ask the user:
- Clarify ambiguous requirements
- Choose between implementation options
- Confirm destructive operations
- Provide missing information

**Architecture**:
```typescript
// tools/question.ts
interface Question {
  id: string;
  type: 'single_choice' | 'multiple_choice' | 'text' | 'confirmation';
  question: string;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
  allowCustom?: boolean; // For "Other" option
  required: boolean;
  context?: string; // Why is this question being asked
}

interface Answer {
  questionId: string;
  values: string[]; // Selected values or text input
  customAnswer?: string; // If "Other" selected
}
```

**Implementation Steps**:
1. Create `tools/question.ts` with question formatting
2. Design question UI for terminal (formatted with colors, emojis)
3. Implement input handling (keyboard navigation for choices)
4. Timeout handling (default option after 30 seconds if not required)
5. Store Q&A in conversation context for reference

**Tool Definition**:
```typescript
export const questionTool = tool({
  description: `Ask the user a question to clarify requirements or make decisions.
Use when:
- Requirements are ambiguous
- Multiple valid implementation approaches exist
- Need confirmation before destructive operations
- Missing critical information to proceed

The agent will PAUSE execution and wait for user response.`,
  inputSchema: z.object({
    type: z.enum(['single_choice', 'multiple_choice', 'text', 'confirmation']),
    question: z.string(),
    options: z.array(z.object({
      label: z.string(),
      value: z.string(),
      description: z.string().optional(),
    })).optional(),
    allowCustom: z.boolean().optional(),
    required: z.boolean().default(true),
    context: z.string().optional(),
  }),
  execute: async (params) => {
    // Format question for terminal display
    // Handle user input
    // Return answer to agent
    // Note: This pauses the agent loop until answered
  }
});
```

**UI Design**:
```
┌─────────────────────────────────────────────────────┐
│  ◆ The Build agent has a question                   │
│                                                      │
│  Which database should I use for the user store?    │
│                                                      │
│  Context: The implementation plan mentions using    │
│  a database, but doesn't specify which one.         │
│                                                      │
│  Options:                                           │
│    [1] PostgreSQL - Robust, transactional           │
│    [2] MongoDB - Flexible schema                    │
│    [3] Redis - High performance cache               │
│    [4] Other (specify)                              │
│                                                      │
│  Select (1-4) or type custom answer: _              │
└─────────────────────────────────────────────────────┘
```

**Context Efficiency**:
- Q&A pairs are summarized in context (not full dialog)
- Store only: question type + chosen option label
- Critical for preventing agent from going down wrong path

**Agent Assignment**:
- **Plan Agent**: Ask about architecture decisions, requirement clarifications
- **Build Agent**: Ask about implementation details, confirm before destructive ops

---

### 4. Webfetch Tool (All Agents)

**Purpose**: Fetch web content (HTML pages, documentation) and convert to clean Markdown for the LLM.

**Why**: Agents need access to current documentation, API docs, error messages, and references. HTML is too noisy for LLM context - Markdown is cleaner and more token-efficient.

**Architecture**:
```typescript
// tools/webfetch.ts
import { convert } from 'html-to-markdown'; // Using bun-html-to-markdown

interface WebfetchRequest {
  url: string;
  format: 'markdown' | 'text' | 'html';
  maxLength?: number; // Default: 10000 chars
  includeImages?: boolean;
  selectors?: string[]; // CSS selectors to extract specific sections
  timeout?: number; // Default: 30000ms
}

interface WebfetchResponse {
  url: string;
  title: string;
  content: string; // Markdown/text content
  originalLength: number;
  truncatedLength: number;
  extractedAt: string;
  selectors?: string[]; // Which selectors were used
}
```

**Implementation Steps**:
1. Add dependency: `bun add html-to-markdown` (or similar lightweight converter)
2. Create `tools/webfetch.ts` with fetch + convert pipeline
3. Implement content sanitization (remove scripts, styles)
4. Support selective extraction via CSS selectors
5. Implement caching (24-hour TTL) to avoid re-fetching
6. Respect robots.txt and rate limits

**Tool Definition**:
```typescript
export const webfetchTool = tool({
  description: `Fetch a webpage and convert to Markdown for reading.
Use for: documentation, API references, error explanations, research.
Content is automatically converted from HTML to clean Markdown.
Results are cached for 24 hours to avoid repeated fetches.

Prefer this over searchWeb when you have a specific URL to read.`,
  inputSchema: z.object({
    url: z.string().url(),
    format: z.enum(['markdown', 'text', 'html']).default('markdown'),
    maxLength: z.number().default(10000),
    includeImages: z.boolean().default(false),
    selectors: z.array(z.string()).optional(),
  }),
  execute: async (params) => {
    // Check cache first
    const cached = await cache.get(params.url);
    if (cached) return cached;
    
    // Fetch with timeout
    const response = await fetchWithTimeout(params.url, params.timeout);
    
    // Convert HTML to Markdown
    const markdown = await convert(response.html, {
      skipImages: !params.includeImages,
    });
    
    // Extract specific sections if selectors provided
    let content = markdown;
    if (params.selectors) {
      content = extractSections(markdown, params.selectors);
    }
    
    // Truncate if needed
    const truncated = content.slice(0, params.maxLength);
    
    // Cache result
    await cache.set(params.url, result, { ttl: 86400 });
    
    return {
      url: params.url,
      title: extractTitle(response.html),
      content: truncated,
      originalLength: content.length,
      truncatedLength: truncated.length,
      wasTruncated: content.length > params.maxLength,
    };
  }
});
```

**Conversion Pipeline**:
```
HTML Input
  ↓
[Remove scripts, styles, nav, ads]
  ↓
[Extract main content using readability algorithm]
  ↓
[Convert to Markdown]
  ↓
[Clean up tables, code blocks]
  ↓
[Truncate to maxLength]
  ↓
Markdown Output
```

**Context Efficiency**:
- Markdown is ~40% more token-efficient than HTML
- Selective extraction via CSS selectors (e.g., only `.docs-content`)
- Default 10k char limit prevents huge pages from overwhelming context
- Smart truncation at paragraph boundaries

**Agent Assignment**:
- **Plan Agent**: Fetch architecture docs, API specifications
- **Build Agent**: Fetch library documentation, error solutions
- **Default Agent**: General web reading, research

---

## Part 2: Context Management Improvements

### Overview: Context Management Strategy

Based on analysis of OpenCode, Claude Code, and Codex, we'll implement a multi-layered context management system:

1. **Persistent Project Context (AGENTS.md)** - Cross-session memory
2. **Session Context Management** - Smart compaction and summaries
3. **Tool Output Summarization** - Reduce context bloat from tool results
4. **Subagent Pattern** - Isolate complex tasks in separate context windows
5. **Lazy Loading** - Load skills/docs only when needed

---

### 1. AGENTS.md - Project Context File

**Purpose**: Persistent project memory that persists across sessions, like CLAUDE.md in Claude Code.

**Why**: Projects have conventions, patterns, and requirements that agents need to know every session. AGENTS.md stores this knowledge centrally.

**File Structure**:
```markdown
# AGENTS.md - Project Context for HackclubAI

## Project Overview
- **Name**: hackclub-ai-sdk
- **Type**: TypeScript CLI tool
- **Purpose**: AI SDK for Hack Club with agent support

## Architecture
- Built on Vercel AI SDK with ToolLoopAgent
- Two primary agents: Plan (analysis) and Build (implementation)
- Tool-based architecture with specialized tools
- Skill system for loading specialized knowledge

## Code Conventions

### TypeScript
- Use strict type checking
- Prefer interfaces over types for object shapes
- Use Zod for runtime validation
- Error handling: always return structured results, never throw in tools

### File Organization
- `tools.ts` - All tool definitions
- `agents.ts` - Agent configurations
- `skills.ts` - Skill registry
- `prompts/` - Agent system prompts

### Naming
- Tools: `verbNounTool` (e.g., `readFileTool`)
- Functions: camelCase
- Types/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE

## Dependencies
- `ai` - Vercel AI SDK
- `zod` - Schema validation
- `@openrouter/ai-sdk-provider` - Model provider

## Build & Test
- Build: `bun run build`
- Test: `bun test`
- Lint: `bun run lint`

## Common Patterns
- All tools return structured objects with success/error fields
- Use `executeWithRateLimit` for all API calls
- Always validate paths with `isPathSafe` before file operations
- Prefer editFileTool over writeFileTool for modifications

## Important Notes
- Rate limited to 450 requests per 30 minutes
- Always check file existence before reading
- Never execute destructive commands
- MCP servers available for extended functionality
```

**Implementation**:
```typescript
// context/agents-md.ts
export interface AgentsMdContext {
  content: string;
  lastModified: number;
  sections: Map<string, string>; // Parsed sections for quick access
}

export class AgentsMdLoader {
  private cache: AgentsMdContext | null = null;
  
  async load(projectPath: string): Promise<AgentsMdContext | null> {
    const agentsMdPath = path.join(projectPath, 'AGENTS.md');
    
    try {
      const stats = await fs.promises.stat(agentsMdPath);
      
      // Check if cached version is still valid
      if (this.cache && this.cache.lastModified >= stats.mtimeMs) {
        return this.cache;
      }
      
      const content = await fs.promises.readFile(agentsMdPath, 'utf-8');
      const sections = this.parseSections(content);
      
      this.cache = {
        content,
        lastModified: stats.mtimeMs,
        sections,
      };
      
      return this.cache;
    } catch {
      return null; // No AGENTS.md file
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
}

export const agentsMdLoader = new AgentsMdLoader();
```

**Integration into Agent Prompts**:
```typescript
// In agents.ts runAgentWithContext function
const agentsMd = await agentsMdLoader.load(context.workingDirectory);

const enhancedPrompt = context 
  ? `[Context]
Working Directory: ${context.workingDirectory}
Last Action: ${context.lastAction || 'None'}
Files Modified: ${context.filesModified?.join(', ') || 'None'}
Completed Steps: ${context.completedSteps?.length || 0}
Remaining API Requests: ${rateLimiter.getRemainingRequests()}

${agentsMd ? `\n## Project Context (from AGENTS.md)\n${agentsMd.content.slice(0, 2000)}\n` : ''}

${skillRegistry.getSkillContext()}

[TASK]
${skillEnhancedPrompt}

${context.isComplete ? '[Note: Previous phase was marked as complete. Continue with next phase.]' : ''}`
  : skillEnhancedPrompt;
```

**Context Budget**:
- Full AGENTS.md content in system prompt (usually <2k tokens)
- Loaded once at session start, cached for session
- Auto-reload if file changes during session

---

### 2. Session Context Management - Smart Compaction

**Purpose**: Prevent context window overflow while preserving critical information.

**Why**: Long sessions fill up the context window with:
- Old tool outputs (can be summarized)
- Completed conversation turns (can be compacted)
- Large file reads (only keep summary)
- Error messages (keep most recent, summarize old)

**Strategy**:
```typescript
// context/session-compaction.ts
interface CompactionStrategy {
  // When to compact (token threshold)
  threshold: number;
  // What to compact
  targets: ('tool_outputs' | 'conversation' | 'file_contents' | 'errors')[];
  // How aggressive (0-1)
  aggression: number;
}

class SessionContextManager {
  private contextWindow: ContextItem[] = [];
  private totalTokens: number = 0;
  private maxTokens: number;
  
  constructor(maxTokens: number = 8000) {
    this.maxTokens = maxTokens;
  }
  
  add(item: ContextItem) {
    this.contextWindow.push(item);
    this.totalTokens += item.tokenCount;
    
    if (this.totalTokens > this.maxTokens * 0.8) {
      this.compact();
    }
  }
  
  private compact() {
    // Phase 1: Summarize old tool outputs
    this.summarizeOldToolOutputs();
    
    // Phase 2: Compact conversation history
    if (this.totalTokens > this.maxTokens * 0.85) {
      this.compactConversation();
    }
    
    // Phase 3: Remove non-essential file contents
    if (this.totalTokens > this.maxTokens * 0.9) {
      this.removeOldFileContents();
    }
    
    // Phase 4: Emergency - keep only recent critical items
    if (this.totalTokens > this.maxTokens * 0.95) {
      this.emergencyCompaction();
    }
  }
  
  private summarizeOldToolOutputs() {
    const toolOutputs = this.contextWindow.filter(
      item => item.type === 'tool_output' && item.age > 5 // Older than 5 turns
    );
    
    for (const output of toolOutputs) {
      output.content = this.generateSummary(output);
      output.tokenCount = estimateTokens(output.content);
    }
  }
  
  private generateSummary(item: ContextItem): string {
    switch (item.toolName) {
      case 'readFile':
        return `Previously read: ${item.result.filePath} (${item.result.totalLines} lines)`;
      case 'searchCodebase':
        return `Searched "${item.result.query}": ${item.result.matches} matches`;
      case 'listFiles':
        return `Listed ${item.result.count} files in ${item.result.path}`;
      case 'runCommand':
        return `Ran "${item.result.command}": exit code ${item.result.exitCode}`;
      default:
        return `${item.toolName} completed`;
    }
  }
  
  private compactConversation() {
    // Group old conversation turns into summaries
    const oldTurns = this.contextWindow.filter(
      item => item.type === 'conversation' && item.age > 10
    );
    
    if (oldTurns.length > 3) {
      const summary = this.summarizeConversation(oldTurns);
      
      // Replace old turns with summary
      this.contextWindow = this.contextWindow.filter(
        item => !oldTurns.includes(item)
      );
      this.contextWindow.unshift({
        type: 'conversation_summary',
        content: summary,
        tokenCount: estimateTokens(summary),
      });
    }
  }
}
```

**Compaction Rules**:
1. **Tool Outputs** (oldest first):
   - >5 turns old: Summarize to 1 line
   - >10 turns old: Remove entirely (unless marked "important")
   
2. **File Contents**:
   - Keep most recent 3 file reads in full
   - Summarize older reads to filename + line count
   
3. **Conversation**:
   - Keep full last 10 turns
   - Summarize older turns to key decisions only
   
4. **Errors**:
   - Keep last 3 errors in full
   - Summarize older errors to error type only

**User Control**:
```bash
# CLI commands
/show-context     # Display what's in context
/compact          # Trigger manual compaction
/compact focus    # Compact but preserve task-related items
/clear-context    # Clear everything (emergency)
```

---

### 3. Tool Output Summarization

**Purpose**: Reduce token usage from verbose tool outputs.

**Current Problem**: Tools return large JSON objects that consume context.

**Solution**: Return structured data + human summary. Store structured data separately, include only summary in context.

**Implementation**:
```typescript
// tools/utils/summarize.ts
interface ToolResult<T> {
  // Structured data for programmatic use
  data: T;
  // Human-readable summary for LLM context
  summary: string;
  // Token count of full data
  dataTokens: number;
  // Token count of summary
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

// Example usage in tools
export const readFileTool = tool({
  execute: async (params) => {
    const result = await readFile(params);
    
    return createSummarizedResult(result, (data) => {
      if (data.error) return `Failed to read ${data.filePath}: ${data.error}`;
      return `Read ${data.totalLines} lines from ${data.filePath}${data.truncated ? ' (truncated)' : ''}`;
    });
  }
});

// In agent processing, only include .summary in context
// Keep .data available for programmatic access
```

**Summary Templates by Tool**:

| Tool | Summary Format | Example |
|------|---------------|---------|
| readFile | `Read N lines from {path} (truncated?)` | "Read 45 lines from src/tools.ts" |
| listFiles | `Found N entries in {path}` | "Found 12 files in src/" |
| searchCodebase | `Searched "{query}": N matches in K files` | "Searched "router": 8 matches in 3 files" |
| runCommand | `Ran "{cmd}": exit {code} in {time}s` | "Ran "npm test": exit 0 in 5.2s" |
| searchWeb | `Found N web results for "{query}"` | "Found 5 web results for 'typescript zod'" |
| lsp | `{method} on {file}: N results` | "references on src/index.ts: 12 results" |
| webfetch | `Fetched {title} from {domain} ({chars} chars)` | "Fetched 'Getting Started' from docs.ai (4500 chars)" |

---

### 4. Subagent Pattern (Future Enhancement)

**Purpose**: Delegate complex tasks to isolated agents with their own context windows.

**Why**: Complex tasks (exploration, research) don't need to bloat the main agent's context. Spawn a subagent, let it work in isolation, receive summary result.

**Architecture**:
```typescript
// agents/subagent.ts
interface SubagentConfig {
  name: string;
  instructions: string;
  tools: string[]; // Tool names allowed
  maxSteps: number;
  model?: string; // Can use cheaper/faster model
}

interface SubagentTask {
  id: string;
  config: SubagentConfig;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  steps: number;
}

export const taskTool = tool({
  description: `Delegate a task to a specialized subagent.
Use for: complex research, codebase exploration, multi-step analysis.
Subagents work in isolated context - they don't clutter your context window.
You receive a summary when they complete.`,
  inputSchema: z.object({
    subagent: z.enum(['explore', 'research', 'code-review']),
    prompt: z.string(),
    maxSteps: z.number().default(50),
  }),
  execute: async (params) => {
    const subagent = createSubagent(params.subagent);
    const result = await subagent.run(params.prompt, params.maxSteps);
    
    return {
      taskId: result.id,
      summary: result.summary,
      steps: result.steps,
      filesExamined: result.filesExamined,
      keyFindings: result.keyFindings,
    };
  }
});
```

**Built-in Subagents**:
1. **Explore Subagent** - Read-only codebase exploration
   - Finds files matching patterns
   - Answers questions about codebase structure
   - Returns summary of findings

2. **Research Subagent** - Multi-step research tasks
   - Searches web, reads docs
   - Synthesizes information
   - Returns research summary

3. **Code Review Subagent** - Focused code review
   - Analyzes specific files/changes
   - Returns review comments
   - No write access

**Context Isolation Benefits**:
- Main agent context stays focused on current task
- Subagent can use full context window for its specific job
- Results are summarized, only key findings enter main context
- Parallel execution possible (multiple subagents at once)

---

### 5. Lazy Loading for Skills

**Purpose**: Only load skill content when actually needed.

**Current**: Skills are discovered and partially loaded at startup.

**Enhanced**: 
- Keep skill registry lightweight (name, description, triggers only)
- Load full skill content only when `useSkillTool` is called
- Unload inactive skills after 10 minutes

**Implementation**:
```typescript
// skills.ts enhancements
export class SkillRegistry {
  private skills: Map<string, SkillMetadata> = new Map();
  private loadedContent: Map<string, { content: string; loadedAt: number }> = new Map();
  private contentCacheMs = 10 * 60 * 1000; // 10 minutes
  
  async discoverSkills(): Promise<SkillMetadata[]> {
    // Only load metadata (name, description, triggers)
    // NOT the full SKILL.md content
    const skills = await this.loadSkillMetadata();
    return skills;
  }
  
  async loadSkillContent(skillName: string, referencePath?: string): Promise<string> {
    const cached = this.loadedContent.get(skillName);
    
    // Return cached if still fresh
    if (cached && Date.now() - cached.loadedAt < this.contentCacheMs) {
      return cached.content;
    }
    
    // Load fresh content
    const content = await this.fetchSkillContent(skillName, referencePath);
    this.loadedContent.set(skillName, {
      content,
      loadedAt: Date.now(),
    });
    
    // Cleanup old cached content
    this.cleanupOldContent();
    
    return content;
  }
  
  private cleanupOldContent() {
    const now = Date.now();
    for (const [name, data] of this.loadedContent.entries()) {
      if (now - data.loadedAt > this.contentCacheMs) {
        this.loadedContent.delete(name);
      }
    }
  }
}
```

---

## Part 3: Integration Plan

### Phase 1: Foundation (Week 1)

**Day 1-2: AGENTS.md Implementation**
- [ ] Create `context/agents-md.ts` loader
- [ ] Integrate into agent prompts
- [ ] Create sample AGENTS.md for this project
- [ ] Add `/init` command to generate AGENTS.md

**Day 3-4: Tool Summarization**
- [ ] Create `tools/utils/summarize.ts`
- [ ] Update existing tools to return summaries
- [ ] Modify agent context to use summaries
- [ ] Test token savings

**Day 5-7: Context Compaction**
- [ ] Implement `SessionContextManager`
- [ ] Add compaction triggers
- [ ] Create compaction strategies
- [ ] Add CLI commands (/show-context, /compact)

### Phase 2: New Tools (Week 2-3)

**Week 2: LSP & Webfetch**
- [ ] Implement LSP tool with TypeScript support
- [ ] Add LSP to Plan and Build agent tools
- [ ] Implement webfetch with html-to-markdown
- [ ] Add caching for webfetch
- [ ] Test both tools with real scenarios

**Week 3: Todo & Question**
- [ ] Implement todo management system
- [ ] Create todo tools (create, update, list)
- [ ] Add todos to Build agent only
- [ ] Implement question tool with terminal UI
- [ ] Add question tool to both agents
- [ ] Test interactive workflows

### Phase 3: Polish & Testing (Week 4)

- [ ] End-to-end testing of all new features
- [ ] Measure context efficiency improvements
- [ ] Write documentation
- [ ] Create example workflows
- [ ] Performance optimization
- [ ] Bug fixes

---

## Part 4: Expected Benefits

### Context Efficiency Improvements

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Avg tokens per tool call | ~500 | ~50 | 90% reduction |
| Context window lifetime | ~20 turns | ~50 turns | 150% increase |
| Project setup time | 5-10 min | 0 min (AGENTS.md) | 100% reduction |
| File exploration efficiency | Low | High (LSP) | Semantic understanding |

### Agent Capabilities

**Plan Agent**:
- ✅ Architecture analysis with LSP (go-to-def, references)
- ✅ Web research via webfetch
- ✅ Ask clarifying questions
- ✅ Better context from AGENTS.md

**Build Agent**:
- ✅ Track implementation progress with todos
- ✅ Semantic code navigation with LSP
- ✅ Interactive clarification
- ✅ Documentation lookup via webfetch
- ✅ Better context management

---

## Part 5: Open Questions & Decisions

### Questions for Consideration

1. **LSP Scope**: Which languages should we support initially?
   - Recommendation: TypeScript, Python, Go (most common)

2. **Webfetch Cache**: Where to store cached content?
   - Recommendation: In-memory with disk backup at `~/.hackclub-ai/cache/`

3. **Todo Persistence**: Should todos persist across sessions?
   - Recommendation: No - session-scoped only, user can save manually

4. **Subagents**: Should we implement subagents now or later?
   - Recommendation: Later - Phase 2 enhancement after core tools are stable

5. **Context Limit**: What should be our context window target?
   - Recommendation: Manage to 8k tokens, alert at 6k, compact at 7k

---

## Appendix: File Structure

```
hackclub-ai-sdk/
├── agents.ts              # Agent definitions (add new tools)
├── tools.ts               # Main tools export (add new tools)
├── tools/
│   ├── lsp.ts            # LSP integration
│   ├── todo.ts           # Todo management
│   ├── question.ts       # Interactive questions
│   └── webfetch.ts       # Web content fetching
├── context/
│   ├── agents-md.ts      # AGENTS.md loader
│   ├── session-manager.ts # Context compaction
│   └── utils/
│       └── summarize.ts  # Tool result summarization
├── skills.ts             # Enhance with lazy loading
├── config.ts             # Add LSP config
├── index.ts              # Add CLI commands
└── AGENTS.md             # Project context file (new)
```

---

## Summary

This plan adds four powerful tools (LSP, Todo, Question, Webfetch) and implements sophisticated context management inspired by industry leaders. The result:

1. **More capable agents** with code intelligence, task tracking, and web access
2. **Efficient context usage** through smart compaction and summarization
3. **Persistent project knowledge** via AGENTS.md
4. **Better user experience** with interactive questions and clearer progress tracking

Estimated timeline: 4 weeks
Estimated effort: 2-3 developers
Expected impact: 90% reduction in context bloat, 150% increase in session length
