import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText, stepCountIs } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import * as tool from './tools.ts';
import * as agent from './agents.ts';

const hackclub = createOpenRouter({
  apiKey: process.env.HACK_CLUB_AI_API_KEY,
  baseUrl: 'https://ai.hackclub.com/proxy/v1',
});

// Colors
const red = Bun.color("red", "ansi");
const gray = Bun.color("gray", "ansi");
const green = Bun.color("green", "ansi");
const yellow = Bun.color("yellow", "ansi");
const cyan = Bun.color("cyan", "ansi");
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";

let input: string | null = "";
let model: string = "moonshotai/kimi-k2.5";
let agentName: string = "";
let context: string = "";
let workingDirectory: string = process.cwd();

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
    console.log(`${green}✓${reset} ${dim}${successMessage}${reset}`);
  }
}

// Tool indicator icons
const toolIcons: Record<string, string> = {
  searchweb: '🔍',
  readFile: '📖',
  writeFile: '✏️',
  listFiles: '📁',
  runCommand: '⚡',
    editFile: '🛠️',
    searchCodebase: '🔎',
};

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
    searchCodebase: tool.searchCodebase,
};

// Format tool result for display
function formatToolResult(toolName: string, result: unknown): string {
  const icon = toolIcons[toolName] || '🔧';
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
      return `${green}${icon} Read ${res.totalLines} lines from ${path.basename(res.path as string)}${res.truncated ? ' (truncated)' : ''}${reset}`;
      
    case 'writeFile':
      return `${green}${icon} Wrote ${res.bytesWritten} bytes to ${path.basename(res.path as string)}${reset}`;
      
    case 'listFiles':
      return `${green}${icon} Found ${res.count} entries in ${path.basename(res.path as string) || '.'}${reset}`;
      
    case 'runCommand':
      if (res.success) {
        return `${green}${icon} Command completed (exit code: ${res.exitCode})${reset}`;
      }
      return `${yellow}${icon} Command finished with exit code: ${res.exitCode}${reset}`;
    case 'editFile':
      return `${green}${icon} Edited ${path.basename(res.path as string)} successfully${reset}`;
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
    context = "";
    console.log(gray + "Context cleared." + reset);
    continue;
  }
  
  if (input.toLowerCase() === '/show-context') {
    console.log(gray + "Current Context:" + reset);
    console.log(gray + (context || "(empty)") + reset);
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
    const agentName = input.split(' ')[1];
    if (agentName === 'Plan' || agentName === 'Build') {
      console.log(gray + `Switched to agent: ${agentName}` + reset);
    } else {
      console.log(red + `Agent not found: ${agentName}` + reset);
    }
    continue;
  }
 
    if (input.toLowerCase() === '/agent') {
    console.log(gray + `Current Agent: ${agentName || "(none)"}` + reset);
    continue;
  }
    if (input.toLowerCase() === '/agent-reset') {
    agentName = "";
    console.log(gray + "Agent reset to default." + reset);
    continue;
  }

  if (input.toLowerCase() === '/model') {
    console.log(gray + "Current Model: " + model + reset);
    continue;
  }
  
  if (input.toLowerCase().startsWith('/model ')) {
    model = input.split(' ')[1] || model;
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
        console.log(`${gray} ${isCurrent ? green + '●' : '○'} ${m.id}${isCurrent ? ' (current)' : ''}${reset}`);
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
    console.log(`${yellow}/clear-context${reset}   Clear conversation context`);
    console.log(`${yellow}/show-context${reset}    Show current context`);
    console.log(`${yellow}/agents${reset}         List available agents`);
    console.log(`${yellow}/agent [name]${reset}   Switch to an agent`);
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
  
  let accumulatedText = "";
  let isFirstTextChunk = true;

    // ======================
    // Agent-based processing
    // ======================

    // Plan Agent
    if (agentName === 'Plan') {
        startSpinner('Planning...');
        const { fullStream } = await agent.Plan.stream({
            prompt: input + `\nProvide a detailed implementation plan as per your instructions, this is the current directory ${workingDirectory}.`,
        });
          try {
            for await (const part of fullStream) {
              switch (part.type) {
                case 'tool-call':
                    stopSpinner();
                    console.log("\n");
                  const icon = toolIcons[part.toolName] || '🔧';
                  startSpinner(`${icon} Using ${part.toolName}...`);
                  break;
                  
                case 'tool-result':
                  stopSpinner();
                  console.log("\n"+formatToolResult(part.toolName, part.output));
                  break;
                  
                case 'text-delta':
                  if (isFirstTextChunk) {
                    stopSpinner();
                    console.log("\n");
                    Bun.stdout.write(`${red}◆ ${reset}`);
                    isFirstTextChunk = false;
                  }
                  Bun.stdout.write(part.text);
                  accumulatedText += part.text;
                  break;
                  
                case 'error':
                  stopSpinner();
                  console.log(`\n${red}Error: ${part.error}${reset}`);
                  break;
              }
            }
            
            stopSpinner();
            
            if (accumulatedText) {
              console.log("\n");
              context += `\nUser: ${input}\nAssistant: ${accumulatedText}\n`;
              
              if (context.length > 8000) {
                context = context.slice(-4000);
              }
            } else {
              console.log("");
            }
            
          } catch (error: unknown) {
            stopSpinner();
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.log(`\n${red}Error: ${msg}${reset}\n`);
          }
        } else if (agentName === 'Build') {
            // Build Agent
            startSpinner('Building...');
            const { fullStream } = await agent.Build.stream({
                prompt: input + `\nExecute the build tasks as per your instructions, this is the current directory ${workingDirectory}.`,
            });
          try {
            for await (const part of fullStream) {
              switch (part.type) {
                case 'tool-call':
                    stopSpinner();
                    console.log("\n");
                  const icon = toolIcons[part.toolName] || '🔧';
                  startSpinner(`${icon} Using ${part.toolName}...`);
                  break;
                  
                case 'tool-result':
                  stopSpinner();
                  console.log("\n"+formatToolResult(part.toolName, part.output));
                  break;
                  
                case 'text-delta':
                  if (isFirstTextChunk) {
                    stopSpinner();
                    console.log("\n");
                    Bun.stdout.write(`${red}◆ ${reset}`);
                    isFirstTextChunk = false;
                  }
                  Bun.stdout.write(part.text);
                  accumulatedText += part.text;
                  break;
                  
                case 'error':
                  stopSpinner();
                  console.log(`\n${red}Error: ${part.error}${reset}`);
                  break;
              }
            }
            
            stopSpinner();
            
            if (accumulatedText) {
              console.log("\n");
              context += `\nUser: ${input}\nAssistant: ${accumulatedText}\n`;
              
              if (context.length > 8000) {
                context = context.slice(-4000);
              }
            } else {
              console.log("");
            }
            
          } catch (error: unknown) {
            stopSpinner();
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.log(`\n${red}Error: ${msg}${reset}\n`);
          }
    } else {
    // Default HackclubAI processing
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
    ${context}`,
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
              const icon = toolIcons[part.toolName] || '🔧';
              startSpinner(`${icon} Using ${part.toolName}...`);
              break;
              
            case 'tool-result':
              stopSpinner();
              console.log("\n"+formatToolResult(part.toolName, part.output));
              break;
              
            case 'text-delta':
              if (isFirstTextChunk) {
                stopSpinner();
                console.log("\n");
                Bun.stdout.write(`${red}◆ ${reset}`);
                isFirstTextChunk = false;
              }
              Bun.stdout.write(part.text);
              accumulatedText += part.text;
              break;
              
            case 'error':
              stopSpinner();
              console.log(`\n${red}Error: ${part.error}${reset}`);
              break;
          }
        }
        
        stopSpinner();
        
        if (accumulatedText) {
          console.log("\n");
          context += `\nUser: ${input}\nAssistant: ${accumulatedText}\n`;
          
          if (context.length > 8000) {
            context = context.slice(-4000);
          }
        } else {
          console.log("");
        }
        
      } catch (error: unknown) {
        stopSpinner();
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.log(`\n${red}Error: ${msg}${reset}\n`);
      }
    }
}
