import {z} from 'zod';
import {tool} from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
// Define the working directory for file operations
const workingDirectory = process.cwd();

// === Tools === 

// Search Web Tool
export const searchWebTool = tool({
  description: 'Search the web for real-time information, current events, news, or facts you need to verify. Use this when you need up-to-date information.',
  inputSchema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  execute: async ({ query }: { query: string }) => {
    const res = await fetch(
      `https://search.hackclub.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HACK_CLUB_SEARCH_API_KEY}`,
        },
      }
    );

    if (!res.ok) {
      return { error: `Search failed with status: ${res.status}` };
    }

    const data = await res.json();
    return data;
  },
});

// Read File Tool
export const readFileTool = tool({
  description: 'Read the contents of a file. Use this to examine code, configuration files, or any text file the user wants to review or work with.',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to read (relative to working directory or absolute)'),
  }),
  execute: async ({ filePath }: { filePath: string }) => {
    try {
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(workingDirectory, filePath);
      
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      const lines = content.split('\n');
      const lineCount = lines.length;
      
      // Truncate if too long
      if (lineCount > 200) {
        return {
          path: absolutePath,
          content: lines.slice(0, 200).join('\n'),
          truncated: true,
          totalLines: lineCount,
          message: `File has ${lineCount} lines. Showing first 200 lines.`
        };
      }
      
      return {
        path: absolutePath,
        content,
        truncated: false,
        totalLines: lineCount
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to read file: ${msg}` };
    }
  },
});

// Write File Tool
export const writeFileTool = tool({
  description: 'Write content to a file. Use this to create new files or overwrite existing ones. Always confirm with the user before overwriting important files.',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to write (relative to working directory or absolute)'),
    content: z.string().describe('The content to write to the file'),
  }),
  execute: async ({ filePath, content }: { filePath: string; content: string }) => {
    try {
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(workingDirectory, filePath);
      
      // Create directory if it doesn't exist
      const dir = path.dirname(absolutePath);
      await fs.promises.mkdir(dir, { recursive: true });
      
      await fs.promises.writeFile(absolutePath, content, 'utf-8');
      
      return {
        success: true,
        path: absolutePath,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        message: `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${absolutePath}`
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to write file: ${msg}` };
    }
  },
});

// List Files Tool
export const listFilesTool = tool({
  description: 'List files and directories in a given path. Use this to explore the project structure or find files.',
  inputSchema: z.object({
    dirPath: z.string().optional().describe('The directory path to list (defaults to working directory)'),
    recursive: z.boolean().optional().describe('Whether to list recursively (default: false, max depth: 3)'),
  }),
  execute: async ({ dirPath, recursive = false }: { dirPath?: string; recursive?: boolean }) => {
    try {
      const targetPath = dirPath 
        ? (path.isAbsolute(dirPath) ? dirPath : path.join(workingDirectory, dirPath))
        : workingDirectory;
      
      interface FileEntry {
        name: string;
        path: string;
        type: 'file' | 'directory';
        size?: number;
        children?: FileEntry[];
      }
      
      const listDir = async (dir: string, depth: number = 0): Promise<FileEntry[]> => {
        if (depth > 3) return [];
        
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const result: FileEntry[] = [];
        
        for (const entry of entries) {
          // Skip node_modules and hidden files/dirs
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(targetPath, fullPath);
          
          if (entry.isDirectory()) {
            const item: FileEntry = {
              name: entry.name,
              path: relativePath,
              type: 'directory'
            };
            if (recursive && depth < 3) {
              item.children = await listDir(fullPath, depth + 1);
            }
            result.push(item);
          } else {
            const stats = await fs.promises.stat(fullPath);
            result.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size: stats.size
            });
          }
        }
        
        return result;
      };
      
      const files = await listDir(targetPath);
      
      return {
        path: targetPath,
        entries: files,
        count: files.length
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to list directory: ${msg}` };
    }
  },
});

export const editFileTool = tool({
    description: "Edit a file by replacing a specific block of code with a new one. Provide the 'oldContent' string exactly as it appears in the file including whitespace.",
    parameters: z.object({ // AI SDK uses 'parameters' instead of 'schema' in recent versions
        path: z.string().describe("Path to the file relative to project root"),
        edits: z.array(z.object({
            oldContent: z.string().describe("The exact text to find (must match perfectly)"),
            newContent: z.string().describe("The text to replace it with")
        }))
    }),
    execute: async ({path, edit}) => {
        try {
            let content = await fs.readFile(path, 'utf-8');
            
            for (const edit of edits) {
                if (!content.includes(edit.oldContent)) {
                    return {
                        error: `Match failed for ${path}. Ensure 'oldContent' matches whitespace exactly.`,
                        hint: "If the content has multiple lines, ensure you include the correct indentation."
                    };
                }
                // Use split/join for global replacement if there are multiple occurrences
                content = content.split(edit.oldContent).join(edit.newContent);
            }

            await fs.writeFile(path, content);
            return { message: `Successfully updated ${path}`, file: path };
        } catch (error: any) {
            return { error: `Failed to edit file: ${error.message}` };
        }
    }
});

export const searchCodebase = tool({
    description: "Search for a string or regex pattern within the codebase. Returns file names and line numbers.",
    parameters: z.object({
        query: z.string().describe("The search term or regex pattern"),
        includePattern: z.string().optional().describe("Optional glob pattern like '*.tsx' or 'src/**/*.ts'")
    }),
    execute: async ({ query, includePattern }) => {
        // Sanitize the query to prevent command injection
        const safeQuery = query.replace(/"/g, '\\"');
        const includeFlag = includePattern ? `--include="${includePattern}"` : "";
        
        // Added --max-count to prevent flooding the context window
        const cmd = `grep -rnE "${safeQuery}" . ${includeFlag} --exclude-dir={node_modules,.git} | head -n 50`;
        try {
            const { stdout, stderr } = await execAsync(cmd);
            if (stderr && !stdout) return { error: stderr };
            if (!stdout) return "No matches found.";
            return {
                results: stdout,
                truncated: stdout.split('\n').length >= 50 ? "Showing first 50 matches." : "All matches shown."
            };
        } catch (error: any) {
            // grep returns exit code 1 if no matches found
            if (error.code === 1) return "No matches found.";
            return { error: error.message };
        }
    }
});

// Run Command Tool
export const runCommandTool = tool({
  description: 'Run a shell command. Use this for tasks like running tests, installing packages, or executing scripts. Be careful with destructive commands.',
  inputSchema: z.object({
    command: z.string().describe('The command to execute'),
    cwd: z.string().optional().describe('Working directory for the command (defaults to current working directory)'),
  }),
  execute: async ({ command, cwd }: { command: string; cwd?: string }) => {
    try {
      const execCwd = cwd 
        ? (path.isAbsolute(cwd) ? cwd : path.join(workingDirectory, cwd))
        : workingDirectory;
      
      // Security: block dangerous commands
      const dangerousPatterns = [
        /rm\s+-rf\s+[\/~]/,
        />\s*\/dev\/sd/,
        /mkfs/,
        /dd\s+if=/,
        /:(){ :|:& };:/,
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return { error: 'Command blocked for safety reasons' };
        }
      }
      
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: execCwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      
      // Truncate output if too long
      const maxLength = 5000;
      const truncatedStdout = stdout.length > maxLength 
        ? stdout.slice(0, maxLength) + '\n... (output truncated)'
        : stdout;
      const truncatedStderr = stderr.length > maxLength
        ? stderr.slice(0, maxLength) + '\n... (output truncated)'
        : stderr;
      
      return {
        command,
        cwd: execCwd,
        exitCode,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        success: exitCode === 0
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to execute command: ${msg}` };
    }
  },
});

