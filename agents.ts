import { ToolLoopAgent, stepCountIs } from "ai";
import { model, hackclub } from "./config.ts";
import * as tools from "./tools.ts";
import BASE_PROMPT from "./prompts/agents/base.txt";
import PLAN_PROMPT from "./prompts/agents/plan.txt";
import BUILD_PROMPT from "./prompts/agents/build.txt";

// Rate limiter configuration
// Hack Club AI API limits: 450 requests per 30 minutes
const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUESTS_PER_WINDOW = 450;
const MIN_DELAY_MS = Math.ceil(RATE_LIMIT_WINDOW_MS / MAX_REQUESTS_PER_WINDOW); // ~4000ms between requests
const MAX_RETRIES = 3;
const BACKOFF_MULTIPLIER = 2;

// Request tracking for rate limiting
class RateLimiter {
  private requestTimestamps: number[] = [];
  private lastRequestTime: number = 0;

  async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Clean up old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      time => now - time < RATE_LIMIT_WINDOW_MS
    );
    
    // Check if we're at the limit
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
      const oldestTimestamp = this.requestTimestamps[0];
      if (oldestTimestamp) {
        const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp);
        if (waitTime > 0) {
          console.log(`[Rate Limiter] Waiting ${Math.ceil(waitTime / 1000)}s for rate limit window...`);
          await this.sleep(waitTime);
        }
      }
    }
    
    // Ensure minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < MIN_DELAY_MS) {
      const waitTime = MIN_DELAY_MS - timeSinceLastRequest;
      await this.sleep(waitTime);
    }
    
    this.lastRequestTime = Date.now();
    this.requestTimestamps.push(this.lastRequestTime);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getRemainingRequests(): number {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      time => now - time < RATE_LIMIT_WINDOW_MS
    );
    return MAX_REQUESTS_PER_WINDOW - this.requestTimestamps.length;
  }
}

// Global rate limiter instance
export const rateLimiter = new RateLimiter();

// Helper function to combine prompts
function combinePrompts(...prompts: string[]): string {
  return prompts.join('\n\n---\n\n');
}

// Context management types
export interface AgentContext {
  workingDirectory: string;
  projectInfo?: {
    language?: string;
    framework?: string;
    packageManager?: string;
  };
  lastAction?: string;
  filesModified?: string[];
  completedSteps?: string[];
  isComplete?: boolean;
}

// Shared tool set for all agents
const sharedTools = {
  readFile: tools.readFileTool,
  listFiles: tools.listFilesTool,
  searchWeb: tools.searchWebTool,
  searchCodebase: tools.searchCodebaseTool,
  runCommand: tools.runCommandTool,
};

// Custom stop condition that checks for completion
function createSmartStopCondition(maxSteps: number) {
  return (context: { steps: any[] }) => {
    // Check if max steps reached
    if (context.steps.length >= maxSteps) {
      console.log(`[Agent] Reached maximum step limit (${maxSteps})`);
      return true;
    }
    
    // Check if the last message indicates completion
    const lastStep = context.steps[context.steps.length - 1];
    if (lastStep?.text) {
      const text = lastStep.text.toLowerCase();
      // Look for completion indicators
      if (text.includes('task complete') || 
          text.includes('implementation complete') ||
          text.includes('plan complete') ||
          text.includes('build successful') ||
          text.includes('done.')) {
        console.log('[Agent] Task completion detected');
        return true;
      }
    }
    
    return false;
  };
}

// Wrapper for tool execution with rate limiting and retry logic
async function executeWithRateLimit<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  let retries = 0;
  
  while (retries <= MAX_RETRIES) {
    try {
      // Wait for rate limit before executing
      await rateLimiter.waitForRateLimit();
      
      const result = await operation();
      return result;
    } catch (error: any) {
      // Check if it's a rate limit error (429)
      if (error.status === 429 || error.message?.includes('429') || error.message?.includes('Too Many Requests')) {
        retries++;
        if (retries > MAX_RETRIES) {
          console.error(`[Rate Limit] Max retries (${MAX_RETRIES}) exceeded for ${operationName}`);
          throw error;
        }
        
        const backoffDelay = MIN_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retries);
        console.log(`[Rate Limit] Hit rate limit, backing off for ${backoffDelay}ms (retry ${retries}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      } else {
        // Not a rate limit error, rethrow
        throw error;
      }
    }
  }
  
  throw new Error(`Unexpected exit from retry loop for ${operationName}`);
}

// Type for stream results
type StreamResult = {
  fullStream: AsyncIterable<any>;
};

// Plan Agent - Software Architect
export const Plan = new ToolLoopAgent({
  model: hackclub(model),
  instructions: combinePrompts(BASE_PROMPT, PLAN_PROMPT) + `

## IMPORTANT - Task Completion Protocol:
When you have completed the planning task, you MUST end your response with one of these phrases:
- "Plan complete"
- "Task complete" 
- "Implementation plan finalized"

This signals that the planning phase is done and the Build agent can proceed.`,
  tools: {
    ...sharedTools,
    writeFile: tools.writeFileTool,
  },
  toolChoice: "auto",
  stopWhen: createSmartStopCondition(150), // Increased from 40 to 150
  maxRetries: MAX_RETRIES,
});

// Build Agent - Software Engineer
export const Build = new ToolLoopAgent({
  model: hackclub(model),
  instructions: combinePrompts(BASE_PROMPT, BUILD_PROMPT) + `

## IMPORTANT - Task Completion Protocol:
When you have completed all implementation tasks, you MUST end your response with one of these phrases:
- "Build successful"
- "Implementation complete"
- "Task complete"
- "All done"

This signals that the implementation phase is done.`,
  tools: {
    ...sharedTools,
    writeFile: tools.writeFileTool,
    editFile: tools.editFileTool,
  },
  toolChoice: "required",
  stopWhen: createSmartStopCondition(200), // Increased from 50 to 200
  maxRetries: MAX_RETRIES,
});

// Export context management utilities
export function createAgentContext(workingDir: string = process.cwd()): AgentContext {
  return {
    workingDirectory: workingDir,
    filesModified: [],
    completedSteps: [],
    isComplete: false,
  };
}

export function updateAgentContext(
  context: AgentContext, 
  action: string, 
  filePath?: string
): AgentContext {
  const updated = { 
    ...context, 
    lastAction: action,
    completedSteps: [...(context.completedSteps || []), action]
  };
  if (filePath && updated.filesModified) {
    updated.filesModified = [...updated.filesModified, filePath];
  }
  return updated;
}

// Mark context as complete
export function markContextComplete(context: AgentContext): AgentContext {
  return { ...context, isComplete: true };
}

// Export all agents and tools
export const allAgents = {
  Plan,
  Build,
};

export { tools };

// Helper to run agents with context and rate limiting
export async function runAgentWithContext(
  selectedAgent: typeof Plan | typeof Build,
  prompt: string,
  context?: AgentContext
) {
  const enhancedPrompt = context 
    ? `[Context]
Working Directory: ${context.workingDirectory}
Last Action: ${context.lastAction || 'None'}
Files Modified: ${context.filesModified?.join(', ') || 'None'}
Completed Steps: ${context.completedSteps?.length || 0}
Remaining API Requests: ${rateLimiter.getRemainingRequests()}

[Task]
${prompt}

${context.isComplete ? '[Note: Previous phase was marked as complete. Continue with next phase.]' : ''}`
    : prompt;
  
  // Execute with rate limiting and retry logic
  const result = await executeWithRateLimit<StreamResult>(
    () => selectedAgent.stream({ prompt: enhancedPrompt }),
    'Agent stream'
  );
  
  return result.fullStream;
}

// Helper to check if we should pause due to rate limits
export function shouldPauseForRateLimit(): boolean {
  const remaining = rateLimiter.getRemainingRequests();
  if (remaining < 50) {
    console.log(`[Rate Limiter] Only ${remaining} requests remaining. Consider pausing...`);
    return true;
  }
  return false;
}

// Helper to get rate limit status
export function getRateLimitStatus(): { remaining: number; resetTime: string } {
  const remaining = rateLimiter.getRemainingRequests();
  const resetTime = new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toLocaleTimeString();
  return { remaining, resetTime };
}
