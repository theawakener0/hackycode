import { streamText, stepCountIs } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import * as tool from './tools.ts';
import * as agent from './agents.ts';
import { hackclub, model, setModel } from './config.ts';

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

// Tool indicator symbols (ASCII instead of emoji)
const toolIcons: Record<string, string> = {
  searchweb: '[WEB]',
  readFile: '[READ]',
  writeFile: '[WRITE]',
  listFiles: '[LIST]',
  runCommand: '[EXEC]',
  editFile: '[EDIT]',
  searchCodebase: '[FIND]',
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



// All tools
const tools = {
  searchweb: tool.searchWebTool,
  readFile: tool.readFileTool,
  writeFile: tool.writeFileTool,
  listFiles: tool.listFilesTool,
  runCommand: tool.runCommandTool,
  editFile: tool.editFileTool,
  searchCodebase: tool.searchCodebaseTool,
};

// Format tool result for display
function formatToolResult(toolName: string, result: unknown): string {
  const icon = toolIcons[toolName] || '[TOOL]';
  const res = result as Record<string, unknown>;
  
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
    default:
      agentContext = agent.updateAgentContext(agentContext, `${toolName} completed`);
  }
}

// Process agent stream with proper context management
async function processAgentStream(
  selectedAgent: typeof agent.Plan | typeof agent.Build,
  userInput: string,
  spinnerMessage: string
) {
  let accumulatedText = "";
  let isFirstTextChunk = true;
  let currentParagraph = "";

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
          Bun.stdout.write("\n"+formatToolResult(part.toolName, part.output)+"\n");
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
  
  if (input.toLowerCase() === '/help') {
    console.log(`\n${bold}${cyan}Available Commands:${reset}`);
    console.log(`${gray}────────────────────────────────────────${reset}`);
    console.log(`${yellow}/exit${reset}, ${yellow}/quit${reset}     Exit the application`);
    console.log(`${yellow}/clear${reset}           Clear the console`);
    console.log(`${yellow}/clear-context${reset}   Clear conversation and agent context`);
    console.log(`${yellow}/show-context${reset}    Show current contexts`);
    console.log(`${yellow}/agents${reset}          List available agents`);
    console.log(`${yellow}/agent [name]${reset}    Switch to an agent`);
    console.log(`${yellow}/model${reset}           Show current model`);
    console.log(`${yellow}/model [name]${reset}    Change the model`);
    console.log(`${yellow}/models${reset}          List available models`);
    console.log(`${yellow}/pwd${reset}             Show working directory`);
    console.log(`${yellow}/cd [path]${reset}       Change working directory`);
    console.log(`${yellow}/help${reset}            Show this help message`);
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
    console.log(`${gray}────────────────────────────────────────${reset}\n`);
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

## Guidelines:
- Be concise and helpful
- When asked to work with files, use the appropriate tools
- Explain what you're doing when using tools
- For coding questions, provide clear explanations with examples
- Always consider security when running commands

## Current Working Directory: ${workingDirectory}

## Conversation Context:
${conversationContext}`,
        tools,
        toolChoice: 'auto',
        stopWhen: stepCountIs(10),
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
