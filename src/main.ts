import { streamText, stepCountIs } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import * as tool from './tools.ts';
import * as agent from './agents.ts';
import { hackclub, model, setModel } from './config.ts';
import { skillRegistry } from './skills.ts';
import { agentsMdLoader, formatAgentsMdForContext } from './context/agents-md.ts';
import { todoManager } from './tools/todo.ts';

// Colors
const red = Bun.color("red", "ansi");
const gray = Bun.color("gray", "ansi");
const green = Bun.color("green", "ansi");
const yellow = Bun.color("yellow", "ansi");
const cyan = Bun.color("cyan", "ansi");
const blue = Bun.color("blue", "ansi");
const magenta = Bun.color("magenta", "ansi");
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";

let input: string | null = "";
let agentName: string = "";
let conversationContext: string = "";
let workingDirectory: string = process.cwd();

// Agent context management
let agentContext = agent.createAgentContext(workingDirectory);

// Spinner animation frames
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let currentSpinnerFrame = 0;

function startSpinner(message: string): void {
  currentSpinnerFrame = 0;
  process.stdout.write('\x1b[?25l'); // Hide cursor
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${cyan}${spinnerFrames[currentSpinnerFrame]}${reset} ${dim}${message}${reset}`);
    currentSpinnerFrame = (currentSpinnerFrame + 1) % spinnerFrames.length;
  }, 80);
}

function stopSpinner(successMessage?: string): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stdout.write('\r\x1b[K'); // Clear line
  }
  process.stdout.write('\x1b[?25h'); // Show cursor
  if (successMessage) {
    console.log(`${green}[+]${reset} ${dim}${successMessage}${reset}`);
  }
}

// Tool indicator symbols
const toolIcons: Record<string, string> = {
  searchweb: '[WEB]',
  readFile: '[READ]',
  writeFile: '[WRITE]',
  listFiles: '[LIST]',
  runCommand: '[EXEC]',
  editFile: '[EDIT]',
  searchCodebase: '[FIND]',
  webfetch: '[FETCH]',
  lsp: '[LSP]',
  findSymbol: '[SYMBOL]',
  createTodo: '[TODO+]',
  updateTodo: '[TODO~]',
  listTodos: '[TODOS]',
  deleteTodo: '[TODO-]',
  question: '[ASK]',
  recordAnswer: '[ANSWER]',
};

// Markdown to Terminal formatter
class MarkdownFormatter {
  private inCodeBlock = false;
  private codeBlockLang = '';

  format(text: string): string {
    const lines = text.split('\n');
    const formattedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      
      // Handle code blocks
      if (line.startsWith('```')) {
        if (!this.inCodeBlock) {
          this.inCodeBlock = true;
          this.codeBlockLang = line.slice(3).trim();
          formattedLines.push(`${dim}--- ${this.codeBlockLang || 'code'} ---${reset}`);
          continue;
        } else {
          this.inCodeBlock = false;
          this.codeBlockLang = '';
          formattedLines.push(`${dim}--- end ---${reset}`);
          continue;
        }
      }

      if (this.inCodeBlock) {
        formattedLines.push(`${dim}${line}${reset}`);
        continue;
      }

      // Handle headers
      if (line.startsWith('### ')) {
        formattedLines.push(`${bold}${magenta}${line.slice(4)}${reset}`);
        continue;
      }
      if (line.startsWith('## ')) {
        formattedLines.push(`${bold}${blue}${line.slice(3)}${reset}`);
        continue;
      }
      if (line.startsWith('# ')) {
        formattedLines.push(`${bold}${cyan}${line.slice(2)}${reset}`);
        continue;
      }

      // Handle horizontal rules
      if (line.match(/^---+$/)) {
        const width = process.stdout.columns - 1 || 50;
        formattedLines.push(`${gray}${'─'.repeat(width)}${reset}`);
        continue;
      }

      // Handle blockquotes
      if (line.startsWith('> ')) {
        formattedLines.push(`${gray}> ${line.slice(2)}${reset}`);
        continue;
      }

      // Handle lists
      const unorderedMatch = line.match(/^(\s*)[-*+]\s(.+)$/);
      if (unorderedMatch) {
        const indent = unorderedMatch[1]?.length ?? 0;
        const content = unorderedMatch[2] ?? '';
        formattedLines.push(`${' '.repeat(indent)}${yellow}*${reset} ${this.formatInline(content)}`);
        continue;
      }

      const orderedMatch = line.match(/^(\s*)\d+\.\s(.+)$/);
      if (orderedMatch) {
        const indent = orderedMatch[1]?.length ?? 0;
        const content = orderedMatch[2] ?? '';
        const numMatch = line.match(/^(\s*)(\d+)\./);
        const num = numMatch?.[2] ?? '1';
        formattedLines.push(`${' '.repeat(indent)}${yellow}${num}.${reset} ${this.formatInline(content)}`);
        continue;
      }

      // Handle normal lines with inline formatting
      formattedLines.push(this.formatInline(line));
    }

    return formattedLines.join('\n');
  }

  private formatInline(text: string): string {
    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, `${bold}$1${reset}`);
    text = text.replace(/__(.+?)__/g, `${bold}$1${reset}`);

    // Italic: *text* or _text_
    text = text.replace(/\*(.+?)\*/g, `${dim}$1${reset}`);
    text = text.replace(/_(.+?)_/g, `${dim}$1${reset}`);

    // Inline code: `text`
    text = text.replace(/`(.+?)`/g, `${cyan}$1${reset}`);

    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${blue}$1${reset}${dim}($2)${reset}`);

    // Strikethrough: ~~text~~
    text = text.replace(/~~(.+?)~~/g, `${gray}$1${reset}`);

    return text;
  }
}

// Create markdown formatter instance
const markdownFormatter = new MarkdownFormatter();

let logo: string = `                                                                      
   ▄▄▄  ▄▄▄                          ▄▄                  ▄▄     ▄▄▄▄▄▄
  █▀██  ██                            ██       █▄      ▄█▀▀█▄  █▀ ██  
    ██  ██               ▄▄           ██       ██      ██  ██     ██  
    ██████   ▄▀▀█▄ ▄███▀ ██ ▄█▀ ▄███▀ ██ ██ ██ ████▄   ██▀▀██     ██  
    ██  ██   ▄█▀██ ██    ████   ██    ██ ██ ██ ██ ██ ▄ ██  ██     ██  
  ▀██▀  ▀██▄▄▀█▄██▄▀███▄▄██ ▀█▄▄▀███▄▄██▄▀██▀█▄████▀ ▀██▀  ▀█▄█ ▄▄██▄▄
                                                                        
                                                                       `;



// All tools for default agent
const tools = {
  searchweb: tool.searchWebTool,
  readFile: tool.readFileTool,
  writeFile: tool.writeFileTool,
  listFiles: tool.listFilesTool,
  runCommand: tool.runCommandTool,
  editFile: tool.editFileTool,
  searchCodebase: tool.searchCodebaseTool,
  webfetch: tool.webfetchTool,
  lsp: tool.lspTool,
  findSymbol: tool.findSymbolTool,
  question: tool.questionTool,
  recordAnswer: tool.recordAnswerTool,
};

// Format tool result for display
function formatToolResult(toolName: string, result: unknown): string {
  const icon = toolIcons[toolName] || '[TOOL]';
  const res = result as Record<string, unknown>;
  
  // Check if there's a summary field (new summarization feature)
  if (res.summary && typeof res.summary === 'string') {
    if (res.error) {
      return `${red}${icon} Error: ${res.summary}${reset}`;
    }
    return `${green}${icon} ${res.summary}${reset}`;
  }
  
  // Fallback to detailed formatting
  if (res.error) {
    return `${red}${icon} Error: ${res.error}${reset}`;
  }
  
  switch (toolName) {
    case 'searchweb':
      const webResults = res.web as { results?: unknown[] } | undefined;
      if (webResults?.results) {
        const count = webResults.results.length;
        return `${green}${icon} Found ${count} result${count !== 1 ? 's' : ''}${reset}`;
      }
      return `${green}${icon} Search completed${reset}`;
      
    case 'readFile':
      const readPath = (res.absolutePath || res.path) as string;
      return `${green}${icon} Read ${res.totalLines} lines from ${path.basename(readPath)}${res.truncated ? ' (truncated)' : ''}${reset}`;
      
    case 'writeFile':
      const writePath = (res.absolutePath || res.path) as string;
      return `${green}${icon} Wrote ${res.bytesWritten} bytes to ${path.basename(writePath)}${reset}`;
      
    case 'listFiles':
      const listPath = (res.absolutePath || res.path) as string;
      return `${green}${icon} Found ${res.count} entries in ${path.basename(listPath) || '.'}${reset}`;
      
    case 'runCommand':
      if (res.success) {
        return `${green}${icon} Command completed (exit code: ${res.exitCode})${reset}`;
      }
      return `${yellow}${icon} Command finished with exit code: ${res.exitCode}${reset}`;
    
    case 'editFile':
      const editPath = (res.absolutePath || res.file || res.path) as string;
      return `${green}${icon} Edited ${path.basename(editPath)} successfully${reset}`;
    
    case 'searchCodebase':
      const codeResults = res.results as unknown[] | undefined;
      if (codeResults) {
        const count = codeResults.length;
        return `${green}${icon} Found ${count} result${count !== 1 ? 's' : ''} in codebase${reset}`;
      }
      return `${green}${icon} Codebase search completed${reset}`;
    
    case 'webfetch':
      if (res.title) {
        return `${green}${icon} Fetched "${res.title}" from ${res.url}${res.wasTruncated ? ' (truncated)' : ''}${reset}`;
      }
      return `${green}${icon} Web fetch completed${reset}`;
    
    case 'lsp':
      return `${green}${icon} LSP ${res.method}: ${res.resultCount} result${(res.resultCount as number) !== 1 ? 's' : ''} for ${res.filePath}${reset}`;
    
    case 'findSymbol':
      return `${green}${icon} Found ${res.matches} occurrence${(res.matches as number) !== 1 ? 's' : ''} of '${res.symbol}'${reset}`;
    
    case 'question':
      if (res.requiresUserInput) {
        return `${yellow}${icon} ${res.formattedQuestion}${reset}`;
      }
      return `${green}${icon} Question processed${reset}`;
    
    case 'createTodo':
      return `${green}${icon} Created todo: ${(res.todo as { title: string })?.title}${reset}`;
    
    case 'updateTodo':
      return `${green}${icon} Updated todo: ${(res.todo as { title: string })?.title} → ${(res.todo as { status: string })?.status}${reset}`;
    
    case 'listTodos':
      return `${green}${icon} ${(res.stats as { total: number })?.total} todos (${(res.stats as { in_progress: number })?.in_progress} active)${reset}`;
    
    case 'deleteTodo':
      return `${green}${icon} Deleted todo: ${(res.deletedTodo as { title: string })?.title}${reset}`;
    
    default:
      return `${green}${icon} Tool completed${reset}`;
  }
}

// Update agent context based on tool result
function updateContextFromTool(toolName: string, result: Record<string, unknown>) {
  if (result.error) {
    agentContext = agent.updateAgentContext(agentContext, `${toolName} failed: ${result.error}`);
    return;
  }

  // Update context based on the tool used
  switch (toolName) {
    case 'writeFile':
    case 'editFile':
      if (result.path || result.absolutePath) {
        const filePath = (result.path || result.absolutePath) as string;
        agentContext = agent.updateAgentContext(agentContext, `${toolName} completed`, filePath);
      }
      break;
    case 'readFile':
      if (result.path || result.absolutePath) {
        const filePath = (result.path || result.absolutePath) as string;
        agentContext = agent.updateAgentContext(agentContext, `Read ${result.totalLines} lines from ${path.basename(filePath as string)}`);
      }
      break;
    case 'runCommand':
      const cmd = (result.requestedCommand || result.executedCommand) as string;
      const success = result.success ? 'succeeded' : 'failed';
      agentContext = agent.updateAgentContext(agentContext, `Command "${cmd}" ${success}`);
      break;
    case 'searchCodebase':
      const matches = result.matches as number;
      agentContext = agent.updateAgentContext(agentContext, `Searched codebase: ${matches} matches`);
      break;
    case 'question':
      if (result.questionData) {
        const qData = result.questionData as { question: string; type: string };
        agentContext = agent.updateAgentContext(agentContext, `Asked ${qData.type} question: ${qData.question.substring(0, 50)}...`);
      }
      break;
    case 'recordAnswer':
      if (result.success) {
        agentContext = agent.updateAgentContext(agentContext, `Recorded user answer`);
      }
      break;
    default:
      agentContext = agent.updateAgentContext(agentContext, `${toolName} completed`);
  }
}

// Process agent stream with proper context management
async function processAgentStream(
  selectedAgent: typeof agent.Plan | typeof agent.Build,
  userInput: string,
  spinnerMessage: string,
  depth: number = 0
): Promise<void> {
  // Prevent infinite recursion
  if (depth > 5) {
    console.log(`${yellow}Maximum question depth reached. Please provide a new prompt to continue.${reset}\n`);
    return;
  }

  let accumulatedText = "";
  let isFirstTextChunk = true;
  let currentParagraph = "";
  let pendingAnswer: string | null = null;
  let wasQuestionAsked = false;

  startSpinner(spinnerMessage);

  try {
    // Use the context-aware agent runner
    const stream = await agent.runAgentWithContext(
      selectedAgent,
      userInput,
      agentContext
    );

    for await (const part of stream) {
      switch (part.type) {
        case 'tool-call':
          stopSpinner();
          console.log("\n");
          const icon = toolIcons[part.toolName] || '[TOOL]';
          startSpinner(`${icon} Using ${part.toolName}...`);
          break;
          
        case 'tool-result':
          stopSpinner();
          const result = part.output as Record<string, unknown>;
          
          // Handle question tool requiring user input
          if (part.toolName === 'question' && result.requiresUserInput && result.questionData) {
            wasQuestionAsked = true;
            const qData = result.questionData as {
              type: string;
              question: string;
              options?: Array<{ label: string; value: string; description?: string }>;
              required?: boolean;
              context?: string;
            };
            
            // Display the question
            console.log(`\n${yellow}◆ The ${agentName || 'agent'} has a question:${reset}\n`);
            console.log(`${bold}${qData.question}${reset}\n`);
            
            if (qData.context) {
              console.log(`${gray}Context: ${qData.context}${reset}\n`);
            }
            
            // Handle based on question type
            let answer = '';
            if (qData.type === 'confirmation') {
              const response = prompt(`${yellow}[Y/N]${reset} `);
              answer = response?.toLowerCase() === 'y' ? 'yes' : 'no';
            } else if (qData.options && qData.options.length > 0) {
              console.log(`${cyan}Options:${reset}`);
              qData.options.forEach((opt, idx) => {
                console.log(`  ${yellow}[${idx + 1}]${reset} ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`);
              });
              const response = prompt(`\n${cyan}Select (1-${qData.options.length}):${reset} `);
              const selected = parseInt(response || '1', 10) - 1;
              if (selected >= 0 && selected < qData.options.length) {
                answer = qData.options[selected]?.value || '';
              } else {
                answer = qData.options[0]?.value || '';
              }
            } else {
              answer = prompt(`${cyan}>${reset} `) || '';
            }
            
            // Record the answer
            console.log(`\n${green}✓ Answer recorded: ${answer}${reset}\n`);
            pendingAnswer = answer;
            accumulatedText += `\n[User answered: ${answer}]\n`;
          } else {
            Bun.stdout.write("\n"+formatToolResult(part.toolName, part.output)+"\n");
          }
          
          // Update agent context based on tool result
          updateContextFromTool(part.toolName, part.output as Record<string, unknown>);
          break;
          
        case 'text-delta':
          if (isFirstTextChunk) {
            stopSpinner();
            console.log("\n");
            Bun.stdout.write(`${red}◆ ${reset}`);
            isFirstTextChunk = false;
          }
          currentParagraph += part.text;
          accumulatedText += part.text;
          
          // Check if we have a complete line to format
          if (part.text.includes('\n')) {
            const lines = currentParagraph.split('\n');
            // Process all complete lines except the last (incomplete) one
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i];
              if (line !== undefined) {
                const formatted = markdownFormatter.format(line);
                Bun.stdout.write(formatted + '\n');
              }
            }
            // Keep the incomplete line for next iteration
            const lastLine = lines[lines.length - 1];
            currentParagraph = lastLine ?? '';
          }
          break;
          
        case 'error':
          stopSpinner();
          Bun.stdout.write("\n"+`${red}Error: ${part.error}${reset}`);
          break;
      }
    }
    
    stopSpinner();
    
    // Format and display any remaining text in currentParagraph
    if (currentParagraph) {
      const formatted = markdownFormatter.format(currentParagraph);
      Bun.stdout.write(formatted);
    }
    
    if (accumulatedText) {
      console.log("\n");
      conversationContext += `\nUser: ${userInput}\nAssistant: ${accumulatedText}\n`;
      
      if (conversationContext.length > 8000) {
        conversationContext = conversationContext.slice(-4000);
      }
      
      // Update agent context with the response summary
      agentContext = agent.updateAgentContext(
        agentContext, 
        `Response generated (${accumulatedText.length} chars)`
      );
    } else {
      console.log("");
    }

    // If a question was asked and answered, continue the conversation
    if (wasQuestionAsked && pendingAnswer) {
      // Small delay to let the user see the output
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Continue with the answer - include full context
      const agentType = selectedAgent === agent.Plan ? 'Plan' : 'Build';
      const followUpPrompt = `[CONTINUING AFTER QUESTION]
Original task: ${userInput}
Previous question asked: (see conversation above)
User's answer: "${pendingAnswer}"

Now continue with the original task. Use this answer to proceed.`;
      
      await processAgentStream(
        selectedAgent,
        followUpPrompt,
        `${agentType} continuing...`,
        depth + 1
      );
    }
    
  } catch (error: unknown) {
    stopSpinner();
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`\n${red}Error: ${msg}${reset}\n`);
  }
}

// === CLI INTERFACE ===

console.clear();
console.log(red + logo + reset);
console.log(gray + "----------------------------------------------------------------------------");
console.log("Welcome to HackclubAI! Your coding assistant with superpowers.");
console.log(`Type ${red + '/exit' + reset + gray} or ${red + '/quit' + reset + gray} to end the conversation.`);
console.log(`Type ${red + '/help' + reset + gray} to see all commands.`);
console.log(gray + "----------------------------------------------------------------------------" + reset);
console.log(`${dim}Working directory: ${workingDirectory}${reset}`);
console.log(`${dim}Model: ${model}${reset}\n`);

// Main processing loop
for (;;) {
  input = prompt(`${green}>${reset}`);
  
  if (input === null || input.toLowerCase() === '/exit' || input.toLowerCase() === '/quit') {
    console.log(`\n${gray}Goodbye! Happy hacking!${reset}\n`);
    process.exit(0);
  }
  
  if (input.toLowerCase() === '/clear') {
    console.clear();
    console.log(red + logo + reset);
    continue;
  }
  
  if (input.toLowerCase() === '/clear-context') {
    conversationContext = "";
    agentContext = agent.createAgentContext(workingDirectory);
    console.log(gray + "Context cleared." + reset);
    continue;
  }
  
  if (input.toLowerCase() === '/show-context') {
    console.log(gray + "Conversation Context:" + reset);
    console.log(gray + (conversationContext || "(empty)") + reset);
    console.log(gray + "\nAgent Context:" + reset);
    console.log(gray + `Working Directory: ${agentContext.workingDirectory}${reset}`);
    console.log(gray + `Last Action: ${agentContext.lastAction || '(none)'}${reset}`);
    console.log(gray + `Files Modified: ${agentContext.filesModified?.join(', ') || '(none)'}${reset}`);
    continue;
  }

  if (input.toLowerCase() === '/agents') {
    console.log(`\n${gray}Available Agents:${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`${yellow}Plan${reset}       Software Architect Agent`);
    console.log(`${yellow}Build${reset}      Software Engineer Agent`);
    console.log(`${gray}────────────────────────────────────────${reset}\n`);
    continue;
  }

  if (input.toLowerCase().startsWith('/agent ')) {
    const selectedAgent = input.split(' ')[1];
    if (selectedAgent === 'Plan' || selectedAgent === 'Build') {
      agentName = selectedAgent;
      console.log(gray + `Switched to agent: ${agentName}` + reset);
    } else {
      console.log(red + `Agent not found: ${selectedAgent}` + reset);
    }
    continue;
  }

  if (input.startsWith('@Plan') || input.startsWith('@Build')) {
    const selectedAgent = input.substring(1).split(' ')[0];
    if (selectedAgent === 'Plan' || selectedAgent === 'Build') {
      agentName = selectedAgent;
      const remainingInput = input.substring(selectedAgent.length + 1).trim();
      if (remainingInput) {
        console.log(gray + `Using ${agentName} agent...` + reset);
        input = remainingInput;
      } else {
        console.log(gray + `Switched to agent: ${agentName}` + reset);
        continue;
      }
    }
  }
 
  if (input.toLowerCase() === '/agent') {
    console.log(gray + `Current Agent: ${agentName || "(none)"}` + reset);
    continue;
  }

  if (input.toLowerCase() === '/agent-reset') {
    agentName = "";
    agentContext = agent.createAgentContext(workingDirectory);
    console.log(gray + "Agent reset to default." + reset);
    continue;
  }

  if (input.toLowerCase() === '/model') {
    console.log(gray + "Current Model: " + model + reset);
    continue;
  }
  
  if (input.toLowerCase().startsWith('/model ')) {
    const newModel = input.split(' ')[1];
    if (newModel) {
      setModel(newModel);
    }
    console.log(gray + "Model changed to: " + model + reset);
    continue;
  }
  
  if (input.toLowerCase() === '/models') {
    startSpinner('Fetching available models...');
    try {
      const response = await fetch('https://ai.hackclub.com/proxy/v1/models');
      const json = await response.json() as { data: { id: string }[] };
      stopSpinner('Models loaded');

      console.log(`\n${gray}Available Models:${reset}`);

      json.data.forEach((m: { id: string }) => {
        const isCurrent = m.id === model;
        console.log(`${gray} ${isCurrent ? green + '>' : ' '} ${m.id}${isCurrent ? ' (current)' : ''}${reset}`);
      });
      console.log("");
    } catch {
      stopSpinner();
      console.log(`${red}Failed to fetch models.${reset}`);
    }
    continue;
  }
  
  if (input.toLowerCase() === '/pwd') {
    console.log(`${gray}Working directory: ${workingDirectory}${reset}`);
    continue;
  }
  
  if (input.toLowerCase().startsWith('/cd ')) {
    const newPath = input.slice(4).trim();
    const absolutePath = path.isAbsolute(newPath) 
      ? newPath 
      : path.resolve(workingDirectory, newPath);
    
    try {
      const stats = await fs.promises.stat(absolutePath);
      if (stats.isDirectory()) {
        workingDirectory = absolutePath;
        // Update agent context with new working directory
        agentContext = agent.createAgentContext(workingDirectory);
        console.log(`${gray}Changed to: ${workingDirectory}${reset}`);
      } else {
        console.log(`${red}Not a directory: ${absolutePath}${reset}`);
      }
    } catch {
      console.log(`${red}Directory not found: ${absolutePath}${reset}`);
    }
    continue;
  }
  
  if (input.toLowerCase() === '/skills') {
    startSpinner('Discovering skills...');
    try {
      const skills = await skillRegistry.discoverSkills();
      stopSpinner(`Found ${skills.length} skills`);
      
      if (skills.length === 0) {
        console.log(gray + "No skills found. Install skills with: /skills install <owner/repo@skill>" + reset);
      } else {
        console.log(`\n${bold}${cyan}Available Skills:${reset}`);
        console.log(`${gray}────────────────────────────────────────${reset}`);
        for (const skill of skills) {
          console.log(`${yellow}${skill.name}${reset}`);
          console.log(`${gray}  ${skill.description.slice(0, 80)}${skill.description.length > 80 ? '...' : ''}${reset}`);
        }
        console.log(`${gray}────────────────────────────────────────${reset}\n`);
      }
    } catch (error) {
      stopSpinner();
      console.log(`${red}Failed to discover skills.${reset}`);
    }
    continue;
  }
  
  if (input.toLowerCase().startsWith('/skills install ')) {
    const skillRef = input.slice(16).trim();
    if (!skillRef) {
      console.log(red + "Usage: /skills install <owner/repo@skill>" + reset);
      continue;
    }
    
    startSpinner(`Installing skill: ${skillRef}...`);
    try {
      const success = await skillRegistry.installSkill(skillRef);
      if (success) {
        stopSpinner(`Skill ${skillRef} installed successfully`);
      } else {
        stopSpinner();
        console.log(`${red}Failed to install skill: ${skillRef}${reset}`);
      }
    } catch (error: any) {
      stopSpinner();
      console.log(`${red}Error installing skill: ${error.message}${reset}`);
    }
    continue;
  }

  // Todo management commands
  if (input.toLowerCase() === '/todos' || input.toLowerCase() === '/todo') {
    const stats = todoManager.getStats();
    const todos = todoManager.list({ includeCompleted: false, limit: 20 });
    
    console.log(`\n${bold}${cyan}Active Todos:${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`${gray}Total: ${stats.total} | In Progress: ${stats.in_progress} | Pending: ${stats.pending}${stats.blocked > 0 ? ` | Blocked: ${stats.blocked}` : ''}${reset}\n`);
    
    if (todos.length === 0) {
      console.log(`${gray}No active todos. Create one with: /todo add "Your task"${reset}\n`);
    } else {
      for (const todo of todos) {
        const statusIcon = todo.status === 'in_progress' ? yellow + '▶' + reset : 
                          todo.status === 'blocked' ? red + '✗' + reset : 
                          todo.status === 'completed' ? green + '✓' + reset : gray + '○' + reset;
        const priorityColor = todo.priority === 'high' ? red : todo.priority === 'medium' ? yellow : gray;
        console.log(`${statusIcon} [${priorityColor}${todo.priority}${reset}] ${bold}${todo.title}${reset}`);
        if (todo.description) {
          console.log(`   ${gray}${todo.description.substring(0, 60)}${todo.description.length > 60 ? '...' : ''}${reset}`);
        }
        console.log(`   ${dim}ID: ${todo.id.substring(0, 12)}...${reset}`);
        console.log();
      }
    }
    console.log(`${gray}Commands: /todo add "title" [high|medium|low] | /todo done <id> | /todo delete <id>${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}\n`);
    continue;
  }

  if (input.toLowerCase().startsWith('/todo add ')) {
    const args = input.slice(10).trim();
    const priorityMatch = args.match(/\s+(high|medium|low)$/i);
    const priority = priorityMatch && priorityMatch[1] ? priorityMatch[1].toLowerCase() as 'high' | 'medium' | 'low' : 'medium';
    const title = priorityMatch && priorityMatch[0] ? args.slice(0, -priorityMatch[0].length).trim() : args;
    
    if (!title) {
      console.log(`${red}Usage: /todo add "Your task title" [high|medium|low]${reset}`);
      continue;
    }
    
    const todo = todoManager.create({ title, priority });
    console.log(`${green}✓ Created todo: ${todo.title}${reset}`);
    console.log(`${gray}  ID: ${todo.id}${reset}`);
    console.log(`${gray}  Priority: ${todo.priority}${reset}\n`);
    continue;
  }

  if (input.toLowerCase().startsWith('/todo done ')) {
    const todoId = input.slice(11).trim();
    const todo = todoManager.get(todoId);
    
    if (!todo) {
      console.log(`${red}Todo not found: ${todoId}${reset}`);
      console.log(`${gray}Use /todos to see active todos and their IDs${reset}\n`);
      continue;
    }
    
    todoManager.update(todoId, 'completed', 'Marked as done via CLI');
    console.log(`${green}✓ Completed: ${todo.title}${reset}\n`);
    continue;
  }

  if (input.toLowerCase().startsWith('/todo delete ')) {
    const todoId = input.slice(13).trim();
    const todo = todoManager.get(todoId);
    
    if (!todo) {
      console.log(`${red}Todo not found: ${todoId}${reset}`);
      continue;
    }
    
    todoManager.delete(todoId);
    console.log(`${yellow}✓ Deleted: ${todo.title}${reset}\n`);
    continue;
  }

  if (input.toLowerCase() === '/init') {
    const agentsMdPath = path.join(workingDirectory, 'AGENTS.md');
    
    if (fs.existsSync(agentsMdPath)) {
      console.log(`${yellow}AGENTS.md already exists at ${agentsMdPath}${reset}`);
      console.log(`${gray}Use /init --force to overwrite${reset}`);
      continue;
    }
    
    startSpinner('Generating AGENTS.md...');
    
    try {
      // Detect project info
      const hasPackageJson = fs.existsSync(path.join(workingDirectory, 'package.json'));
      const hasCargo = fs.existsSync(path.join(workingDirectory, 'Cargo.toml'));
      const hasGoMod = fs.existsSync(path.join(workingDirectory, 'go.mod'));
      const hasRequirements = fs.existsSync(path.join(workingDirectory, 'requirements.txt'));
      
      let projectType = 'TypeScript';
      if (hasCargo) projectType = 'Rust';
      else if (hasGoMod) projectType = 'Go';
      else if (hasRequirements) projectType = 'Python';
      
      const agentsMdContent = `# AGENTS.md - Project Context

## Project Overview
- **Type**: ${projectType} Project
- **Working Directory**: ${workingDirectory}

## Quick Start
- Run: ${hasPackageJson ? '`npm run dev`' : '`cargo run`'}
- Build: ${hasPackageJson ? '`npm run build`' : '`cargo build`'}
- Test: ${hasPackageJson ? '`npm test`' : '`cargo test`'}

## Code Conventions
- Follow existing code style
- Add type annotations for TypeScript
- Keep functions small and focused
- Write clear commit messages

## Important Notes
- Check AGENTS.md for project context
- Use todo tools to track tasks
- Ask questions when requirements are unclear
`;
      
      fs.writeFileSync(agentsMdPath, agentsMdContent);
      stopSpinner(`Created ${agentsMdPath}`);
      console.log(`${green}${bold}AGENTS.md created successfully!${reset}`);
      console.log(`${gray}This file helps the AI understand your project context.${reset}\n`);
    } catch (error: any) {
      stopSpinner();
      console.log(`${red}Failed to create AGENTS.md: ${error.message}${reset}`);
    }
    continue;
  }
  
  if (input.toLowerCase() === '/help') {
    console.log(`\n${bold}${cyan}Available Commands:${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`${bold}${magenta}General:${reset}`);
    console.log(`  ${yellow}/exit${reset}, ${yellow}/quit${reset}     Exit the application`);
    console.log(`  ${yellow}/clear${reset}           Clear the console`);
    console.log(`  ${yellow}/clear-context${reset}   Clear conversation and agent context`);
    console.log(`  ${yellow}/show-context${reset}    Show current contexts`);
    console.log(`  ${yellow}/help${reset}            Show this help message`);
    console.log(`\n${bold}${magenta}Agents:${reset}`);
    console.log(`  ${yellow}/agent [name]${reset}    Switch to an agent (Plan/Build)`);
    console.log(`  ${yellow}@Plan [message]${reset}   Quick switch to Plan agent`);
    console.log(`  ${yellow}@Build [message]${reset}  Quick switch to Build agent`);
    console.log(`  ${yellow}/agent-reset${reset}     Reset agent context`);
    console.log(`\n${bold}${magenta}Task Management (Todos):${reset}`);
    console.log(`  ${yellow}/todos${reset}                    List active todos`);
    console.log(`  ${yellow}/todo add "title" [priority]${reset}  Create new todo (priority: high/medium/low)`);
    console.log(`  ${yellow}/todo done <id>${reset}           Mark todo as completed`);
    console.log(`  ${yellow}/todo delete <id>${reset}         Delete a todo`);
    console.log(`\n${bold}${magenta}Project Context:${reset}`);
    console.log(`  ${yellow}/init${reset}            Generate AGENTS.md for project`);
    console.log(`  ${yellow}/pwd${reset}             Show working directory`);
    console.log(`  ${yellow}/cd [path]${reset}       Change working directory`);
    console.log(`\n${bold}${magenta}Model & Skills:${reset}`);
    console.log(`  ${yellow}/model${reset}           Show current model`);
    console.log(`  ${yellow}/model [name]${reset}    Change the model`);
    console.log(`  ${yellow}/models${reset}          List available models`);
    console.log(`  ${yellow}/skills${reset}          List available skills`);
    console.log(`  ${yellow}/skills install <ref>${reset} Install a skill`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`\n${bold}${cyan}Available Tools:${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`${toolIcons.searchweb} ${yellow}searchweb${reset}      Search the web`);
    console.log(`${toolIcons.readFile} ${yellow}readFile${reset}       Read file contents`);
    console.log(`${toolIcons.writeFile} ${yellow}writeFile${reset}      Write to a file`);
    console.log(`${toolIcons.listFiles} ${yellow}listFiles${reset}      List directory contents`);
    console.log(`${toolIcons.runCommand} ${yellow}runCommand${reset}     Execute shell commands`);
    console.log(`${toolIcons.editFile} ${yellow}editFile${reset}       Edit file contents`);
    console.log(`${toolIcons.searchCodebase} ${yellow}searchCodebase${reset} Search within the codebase`);
    console.log(`${toolIcons.webfetch} ${yellow}webfetch${reset}       Fetch web pages as Markdown`);
    console.log(`${toolIcons.lsp} ${yellow}lsp${reset}              Code intelligence (definitions, diagnostics)`);
    console.log(`${toolIcons.findSymbol} ${yellow}findSymbol${reset}     Find symbol occurrences`);
    console.log(`${toolIcons.createTodo} ${yellow}createTodo${reset}     Create a todo (Build agent)`);
    console.log(`${toolIcons.updateTodo} ${yellow}updateTodo${reset}     Update todo status (Build agent)`);
    console.log(`${toolIcons.listTodos} ${yellow}listTodos${reset}      List todos (Build agent)`);
    console.log(`${toolIcons.question} ${yellow}question${reset}       Ask user a question`);
    console.log(`${gray}────────────────────────────────────────${reset}\n`);
    console.log(`${dim}Pro Tips:${reset}`);
    console.log(`${dim}  • Use @Plan for architecture/planning, @Build for implementation${reset}`);
    console.log(`${dim}  • The agent will ask questions if requirements are unclear${reset}`);
    console.log(`${dim}  • Use /todo to track your own tasks outside of agent work${reset}\n`);
    continue;
  }
  
  if (input.trim() === '') {
    continue;
  }

  // Process AI request
  console.log("");

  // Agent-based processing
  if (agentName === 'Plan') {
    await processAgentStream(agent.Plan, input, 'Planning...');
  } else if (agentName === 'Build') {
    await processAgentStream(agent.Build, input, 'Building...');
  } else {
    // Default HackclubAI processing
    let accumulatedText = "";
    let isFirstTextChunk = true;
    let currentParagraph = "";

    // Load AGENTS.md for default agent
    const agentsMdContext = await agentsMdLoader.load(workingDirectory);
    const agentsMdFormatted = formatAgentsMdForContext(agentsMdContext, 1500);
    
    startSpinner('Thinking...');
    try {
      const { fullStream } = streamText({
        model: hackclub(model),
        system: `You are HackclubAI, a helpful coding assistant for Hack Club members.
You help with coding, debugging, explaining code, and answering questions about technology.

## Your Capabilities:
You have access to these tools:
- searchweb: Search the web for current information
- readFile: Read file contents
- writeFile: Write content to files
- listFiles: List directory contents  
- runCommand: Execute shell commands
- editFile: Edit existing files
- searchCodebase: Search within the codebase
- webfetch: Fetch web pages and convert to Markdown
- lsp: Code intelligence (definitions, diagnostics, references)
- findSymbol: Find symbol occurrences across the codebase
- question: Ask the user for clarification when needed

## Guidelines:
- Be concise and helpful
- When asked to work with files, use the appropriate tools
- Explain what you're doing when using tools
- For coding questions, provide clear explanations with examples
- Always consider security when running commands
- For documentation or API questions, use webfetch to get current info
- For code navigation, prefer lsp and findSymbol over searchCodebase
- Ask questions when requirements are unclear

${agentsMdFormatted}

## Current Working Directory: ${workingDirectory}

## Conversation Context:
${conversationContext.slice(-2000)}`,
        tools,
        toolChoice: 'auto',
        stopWhen: stepCountIs(15),
        prompt: input,
      });

      for await (const part of fullStream) {
        switch (part.type) {
          case 'tool-call':
            stopSpinner();
            console.log("\n");
            const icon = toolIcons[part.toolName] || '[TOOL]';
            startSpinner(`${icon} Using ${part.toolName}...`);
            break;
            
          case 'tool-result':
            stopSpinner();
            Bun.stdout.write("\n" + formatToolResult(part.toolName, part.output) + "\n");
            // Update agent context based on tool result
            updateContextFromTool(part.toolName, part.output as Record<string, unknown>);
            break;
            
          case 'text-delta':
            if (isFirstTextChunk) {
              stopSpinner();
              console.log("\n");
              Bun.stdout.write(`${red}◆ ${reset}`);
              isFirstTextChunk = false;
            }
            currentParagraph += part.text;
            accumulatedText += part.text;
            
            // Check if we have a complete line to format
            if (part.text.includes('\n')) {
              const lines = currentParagraph.split('\n');
              // Process all complete lines except the last (incomplete) one
              for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i];
                if (line !== undefined) {
                  const formatted = markdownFormatter.format(line);
                  Bun.stdout.write(formatted + '\n');
                }
              }
              // Keep the incomplete line for next iteration
              const lastLine = lines[lines.length - 1];
              currentParagraph = lastLine ?? '';
            }
            break;
            
          case 'error':
            stopSpinner();
            console.log(`\n${red}Error: ${part.error}${reset}`);
            break;
        }
      }
      
      stopSpinner();
      
      // Format and display any remaining text in currentParagraph
      if (currentParagraph) {
        const formatted = markdownFormatter.format(currentParagraph);
        Bun.stdout.write(formatted);
      }
      
      if (accumulatedText) {
        console.log("\n");
        conversationContext += `\nUser: ${input}\nAssistant: ${accumulatedText}\n`;
        
        if (conversationContext.length > 8000) {
          conversationContext = conversationContext.slice(-4000);
        }
      } else {
        console.log("");
      }
      
    } catch (error: unknown) {
      stopSpinner();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      Bun.stdout.write(`\n${red}Error: ${msg}${reset}\n`);
    }
  }
}
