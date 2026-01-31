import {z} from 'zod';
import {tool} from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { skillRegistry } from './skills.ts';

const execAsync = promisify(exec);

// Define the working directory for file operations
const workingDirectory = process.cwd();

// Helper function to resolve paths consistently
const resolvePath = (filePath: string): string => {
  return path.isAbsolute(filePath) ? filePath : path.join(workingDirectory, filePath);
};

// Helper to check if a path is within working directory (security)
const isPathSafe = (targetPath: string): boolean => {
  const resolved = path.resolve(targetPath);
  const cwd = path.resolve(workingDirectory);
  return resolved.startsWith(cwd) || path.relative(cwd, resolved).startsWith('..');
};

// Helper to generate a summary of changes
const generateChangeSummary = (oldContent: string, newContent: string): { type: string; description: string } => {
  const oldLines = oldContent.split('\n').length;
  const newLines = newContent.split('\n').length;
  const lineDiff = newLines - oldLines;
  
  if (lineDiff === 0) {
    return { type: 'modification', description: `Modified ${oldLines} line(s)` };
  } else if (lineDiff > 0) {
    return { type: 'addition', description: `Added ${lineDiff} line(s) (${oldLines} → ${newLines})` };
  } else {
    return { type: 'deletion', description: `Removed ${Math.abs(lineDiff)} line(s) (${oldLines} → ${newLines})` };
  }
};

// === Tools === 

// Search Web Tool
export const searchWebTool = tool({
  description: 'Search the web for real-time information, current events, news, or facts you need to verify. Use this when you need up-to-date information that might not be in your training data.',
  inputSchema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  execute: async ({ query }) => {
    const apiUrl = `https://search.hackclub.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    
    try {
      const res = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${process.env.HACK_CLUB_SEARCH_API_KEY}`,
        },
      });

      if (!res.ok) {
        return { 
          query,
          apiUrl,
          error: `Search failed with status: ${res.status}` 
        };
      }

      const data = await res.json() as { results?: unknown[] } & Record<string, unknown>;
      return { 
        query,
        apiUrl,
        results: data.results || data 
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        query,
        apiUrl,
        error: `Search failed: ${msg}` 
      };
    }
  },
});

// Read File Tool
export const readFileTool = tool({
  description: 'Read the contents of a file. Use this to examine code, configuration files, or any text file. For large files (>200 lines), use offset and limit to read specific sections.',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to read (relative to working directory or absolute)'),
    offset: z.number().optional().describe('Line number to start reading from (0-indexed, default: 0)'),
    limit: z.number().optional().describe('Maximum number of lines to read (default: 200, max: 500)'),
  }),
  execute: async ({ filePath, offset = 0, limit = 200 }) => {
    const absolutePath = resolvePath(filePath);
    
    try {
      const safeLimit = Math.min(limit, 500);
      
      // Security check
      if (!isPathSafe(absolutePath)) {
        return { 
          filePath,
          absolutePath,
          requestedOffset: offset,
          requestedLimit: limit,
          content: '',
          lineCount: 0,
          startLine: 0,
          endLine: 0,
          truncated: false,
          totalLines: 0,
          error: 'Access denied: path is outside working directory'
        };
      }
      
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;
      
      // Calculate actual range
      const startLine = Math.max(0, offset);
      const endLine = Math.min(startLine + safeLimit, totalLines);
      const selectedLines = allLines.slice(startLine, endLine);
      
      const isTruncated = totalLines > safeLimit || startLine > 0;
      
      let message: string | undefined;
      if (totalLines > safeLimit && endLine < totalLines) {
        message = `Showing lines ${startLine + 1}-${endLine} of ${totalLines}. Use offset: ${endLine} to read more.`;
      } else if (startLine > 0) {
        message = `Showing lines ${startLine + 1}-${endLine} of ${totalLines}.`;
      } else if (totalLines > safeLimit) {
        message = `File has ${totalLines} lines. Showing first ${safeLimit} lines. Use offset parameter to read specific sections.`;
      }
      
      return {
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        requestedOffset: offset,
        requestedLimit: limit,
        content: selectedLines.join('\n'),
        lineCount: selectedLines.length,
        startLine,
        endLine,
        truncated: isTruncated,
        totalLines,
        message
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        requestedOffset: offset,
        requestedLimit: limit,
        content: '',
        lineCount: 0,
        startLine: 0,
        endLine: 0,
        truncated: false,
        totalLines: 0,
        error: `Failed to read file: ${msg}` 
      };
    }
  },
});

// Write File Tool
export const writeFileTool = tool({
  description: 'Write content to a file. Use this to create new files. Will fail if file exists unless overwrite is set to true. Always prefer editFileTool for modifying existing files.',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to write (relative to working directory or absolute)'),
    content: z.string().describe('The content to write to the file'),
    overwrite: z.boolean().optional().describe('Whether to overwrite if file exists (default: false)'),
  }),
  execute: async ({ filePath, content, overwrite = false }) => {
    const absolutePath = resolvePath(filePath);
    
    try {
      // Security check
      if (!isPathSafe(absolutePath)) {
        return { 
          filePath,
          absolutePath,
          contentLength: content.length,
          success: false,
          bytesWritten: 0,
          message: 'Write failed',
          overwritten: false,
          error: 'Access denied: path is outside working directory'
        };
      }
      
      // Check if file exists
      let fileExists = false;
      let originalContent: string | undefined;
      
      try {
        originalContent = await fs.promises.readFile(absolutePath, 'utf-8');
        fileExists = true;
      } catch {
        fileExists = false;
      }
      
      if (fileExists && !overwrite) {
        return {
          filePath,
          absolutePath,
          contentLength: content.length,
          success: false,
          bytesWritten: 0,
          message: 'Write failed',
          overwritten: false,
          error: `File already exists: ${absolutePath}`,
          hint: "Set overwrite: true to overwrite, or use editFileTool to modify existing files."
        };
      }
      
      // Create directory if it doesn't exist
      const dir = path.dirname(absolutePath);
      await fs.promises.mkdir(dir, { recursive: true });
      
      await fs.promises.writeFile(absolutePath, content, 'utf-8');
      
      return {
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        contentLength: content.length,
        success: true,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        message: fileExists 
          ? `Successfully overwrote ${Buffer.byteLength(content, 'utf-8')} bytes in ${absolutePath}`
          : `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${absolutePath}`,
        overwritten: fileExists,
        previousContentLength: originalContent ? Buffer.byteLength(originalContent, 'utf-8') : undefined
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        contentLength: content.length,
        success: false,
        bytesWritten: 0,
        message: 'Write failed',
        overwritten: false,
        error: `Failed to write file: ${msg}`
      };
    }
  },
});

// List Files Tool
export const listFilesTool = tool({
  description: 'List files and directories in a given path. Use this to explore project structure, find specific files, or understand the codebase organization.',
  inputSchema: z.object({
    dirPath: z.string().optional().describe('The directory path to list (defaults to working directory)'),
    recursive: z.boolean().optional().describe('Whether to list recursively (default: false, max depth: 3)'),
  }),
  execute: async ({ dirPath, recursive = false }) => {
    const targetPath = dirPath ? resolvePath(dirPath) : workingDirectory;
    
    try {
      // Security check
      if (!isPathSafe(targetPath)) {
        return {
          requestedPath: dirPath,
          absolutePath: targetPath,
          recursive,
          entries: [],
          count: 0,
          error: 'Access denied: path is outside working directory'
        };
      }
      
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
        filePath: dirPath,
        absolutePath: targetPath,
        path: targetPath, // For backwards compatibility
        requestedPath: dirPath, // Keep for reference
        recursive,
        entries: files,
        count: files.length
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        filePath: dirPath,
        absolutePath: targetPath,
        path: targetPath, // For backwards compatibility
        requestedPath: dirPath, // Keep for reference
        recursive,
        entries: [],
        count: 0,
        error: `Failed to list directory: ${msg}`
      };
    }
  },
});

// Edit File Tool
export const editFileTool = tool({
  description: "Edit a file by replacing specific text blocks. CRITICAL: Always read the file first to ensure exact 'oldContent' match including whitespace and indentation. For multiple edits, they are applied in sequence.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file (relative to working directory or absolute)"),
    edits: z.array(z.object({
      oldContent: z.string().describe("The EXACT text to find - must match whitespace/indentation perfectly"),
      newContent: z.string().describe("The text to replace it with")
    })).min(1).describe("Array of edits to apply in sequence")
  }),
  execute: async ({ filePath, edits }) => {
    const absolutePath = resolvePath(filePath);
    const editDetails: Array<{
      editNumber: number;
      changeType: string;
      changeDescription: string;
      oldContentPreview: string;
      newContentPreview: string;
    }> = [];
    
    try {
      // Security check
      if (!isPathSafe(absolutePath)) {
        return { 
          filePath,
          absolutePath,
          requestedEdits: edits.length,
          success: false,
          message: 'Edit failed',
          file: absolutePath,
          editsApplied: 0,
          editDetails: [],
          error: 'Access denied: path is outside working directory'
        };
      }
      
      // Check if file exists
      try {
        await fs.promises.access(absolutePath);
      } catch {
        return { 
          filePath,
          absolutePath,
          requestedEdits: edits.length,
          success: false,
          message: 'Edit failed',
          file: absolutePath,
          editsApplied: 0,
          editDetails: [],
          error: `File not found: ${absolutePath}`, 
          hint: "Check the file path and ensure the file exists." 
        };
      }
      
      let content = await fs.promises.readFile(absolutePath, 'utf-8');
      
      for (let i = 0; i < edits.length; i++) {
        const currentEdit = edits[i];
        if (!currentEdit) continue;
        
        if (!content.includes(currentEdit.oldContent)) {
          return {
            filePath,
            absolutePath,
            requestedEdits: edits.length,
            success: false,
            message: 'Edit failed',
            file: absolutePath,
            editsApplied: i,
            editDetails,
            failedAtEdit: i + 1,
            error: `Match failed for edit ${i + 1}: "${currentEdit.oldContent.slice(0, 50)}${currentEdit.oldContent.length > 50 ? '...' : ''}"`,
            hint: "Ensure oldContent matches EXACTLY including spaces/tabs/newlines. Read the file first to verify."
          };
        }
        
        // Generate change summary before applying
        const summary = generateChangeSummary(currentEdit.oldContent, currentEdit.newContent);
        
        editDetails.push({
          editNumber: i + 1,
          changeType: summary.type,
          changeDescription: summary.description,
          oldContentPreview: currentEdit.oldContent.slice(0, 100) + (currentEdit.oldContent.length > 100 ? '...' : ''),
          newContentPreview: currentEdit.newContent.slice(0, 100) + (currentEdit.newContent.length > 100 ? '...' : '')
        });
        
        // Replace only first occurrence to avoid unintended changes
        content = content.replace(currentEdit.oldContent, currentEdit.newContent);
      }

      await fs.promises.writeFile(absolutePath, content, 'utf-8');
      
      return { 
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        requestedEdits: edits.length,
        success: true,
        message: `Successfully updated ${edits.length} section(s) in ${absolutePath}`, 
        file: absolutePath, // Keep for backwards compatibility
        editsApplied: edits.length,
        editDetails
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        filePath,
        absolutePath,
        path: absolutePath, // For backwards compatibility
        requestedEdits: edits.length,
        success: false,
        message: 'Edit failed',
        file: absolutePath, // Keep for backwards compatibility
        editsApplied: editDetails.length,
        editDetails,
        error: `Failed to edit file: ${msg}`
      };
    }
  }
});

// Search Codebase Tool
export const searchCodebaseTool = tool({
  description: 'Search for text patterns or regex within codebase files. Returns matching lines with file names and line numbers. Use this to find code, functions, imports, or any text across the project. Great for finding where specific code is defined or used.',
  inputSchema: z.object({
    query: z.string().describe('The string or regex pattern to search for'),
    includePattern: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.tsx", "src/**/*.ts")'),
  }),
  execute: async ({ query, includePattern }) => {
    // Escape double quotes to prevent command injection
    const sanitizedQuery = query.replace(/"/g, '\\"');
    const includeFlag = includePattern ? `--include="${includePattern}"` : "";
    
    // -r: recursive, -n: line numbers, -E: extended regex, -I: ignore binary files
    const command = `grep -rnEI "${sanitizedQuery}" . ${includeFlag} --exclude-dir={node_modules,.git,.next,dist,build} 2>/dev/null | head -n 50`;

    try {
      const { stdout } = await execAsync(command);
      
      if (!stdout || !stdout.trim()) {
        return {
          query,
          command,
          includePattern: includePattern || null,
          matches: 0,
          truncated: false,
          message: `No matches found for "${query}"`,
          hint: "Try a different search term or check your includePattern"
        };
      }

      const lines = stdout.split('\n').filter(line => line.trim());
      
      return {
        query,
        command,
        includePattern: includePattern || null,
        matches: lines.length,
        results: stdout,
        truncated: lines.length >= 50,
        message: lines.length >= 50 
          ? `Found 50+ matches (showing first 50). Try refining your search.`
          : `Found ${lines.length} match(es)`
      };
    } catch (error) {
      // Grep exits with code 1 if no matches found - not a real error
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
        return {
          query,
          command,
          includePattern: includePattern || null,
          matches: 0,
          truncated: false,
          message: `No matches found for "${query}"`
        };
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { 
        query,
        command,
        includePattern: includePattern || null,
        matches: 0,
        truncated: false,
        message: 'Search failed',
        error: `Search failed: ${msg}`
      };
    }
  },
});

// Run Command Tool
export const runCommandTool = tool({
  description: 'Execute a shell command. Use for running tests (npm test, pytest), installing packages (npm install, pip install), building projects (npm run build), or executing scripts. Commands have timeout and output limits for safety.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute (e.g., "npm test", "python script.py")'),
    cwd: z.string().optional().describe('Working directory for the command (defaults to current working directory)'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000, max: 120000)'),
  }),
  execute: async ({ command, cwd, timeout = 60000 }) => {
    const execCwd = cwd ? resolvePath(cwd) : workingDirectory;
    const effectiveTimeout = Math.min(timeout, 120000);
    
    try {
      // Security: block dangerous commands
      const dangerousPatterns = [
        /rm\s+-rf\s+[\/~]/,
        />\s*\/dev\/sd/,
        /mkfs/,
        /dd\s+if=/,
        /:(){ :|:& };:/,
        /chmod\s+-R\s+777\s*\//,
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return { 
            requestedCommand: command,
            executedCommand: null,
            cwd: execCwd,
            timeout: effectiveTimeout,
            exitCode: -1,
            stdout: '',
            stderr: '',
            success: false,
            timedOut: false,
            error: 'Command blocked for safety reasons: destructive system operation detected'
          };
        }
      }
      
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: execCwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      
      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Command timed out after ${effectiveTimeout}ms`)), effectiveTimeout);
      });
      
      const resultPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();
      
      const { stdout, stderr, exitCode } = await Promise.race([resultPromise, timeoutPromise]);
      
      // Truncate output if too long
      const maxLength = 5000;
      const truncatedStdout = stdout.length > maxLength 
        ? stdout.slice(0, maxLength) + '\n... (output truncated - 5000 char limit)'
        : stdout;
      const truncatedStderr = stderr.length > maxLength
        ? stderr.slice(0, maxLength) + '\n... (stderr truncated - 5000 char limit)'
        : stderr;
      
      return {
        requestedCommand: command,
        executedCommand: command,
        cwd: execCwd,
        timeout: effectiveTimeout,
        exitCode,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        success: exitCode === 0,
        timedOut: false
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = msg.includes('timed out');
      return { 
        requestedCommand: command,
        executedCommand: isTimeout ? null : command,
        cwd: execCwd,
        timeout: effectiveTimeout,
        exitCode: -1,
        stdout: '',
        stderr: isTimeout ? '' : msg,
        success: false,
        timedOut: isTimeout,
        error: isTimeout ? `Command timed out after ${effectiveTimeout}ms` : `Failed to execute command: ${msg}`
      };
    }
  },
});


// Skill management tools
export const listSkillsTool = tool({
  description: 'List all available skills that can be used for specialized tasks. Use this when you need to know what specialized knowledge is available.',
  inputSchema: z.object({}),
  execute: async () => {
    const skills = await skillRegistry.discoverSkills();
    return {
      skills: skills.map(s => ({ name: s.name, description: s.description })),
      count: skills.length,
      message: `Found ${skills.length} available skills`
    };
  }
});

export const useSkillTool = tool({
  description: 'Load and use a specific skill for specialized knowledge. Use this when you need specialized expertise for a task (e.g., ai-sdk, react, testing, etc.).',
  inputSchema: z.object({
    skillName: z.string().describe('The name of the skill to use'),
    reference: z.string().optional().describe('Specific reference file to load (optional)'),
  }),
  execute: async ({ skillName, reference }: { skillName: string; reference?: string }) => {
    try {
      const content = await skillRegistry.loadSkillContent(skillName, reference);
      return {
        skillName,
        content: content.slice(0, 5000), // Limit content length
        loaded: true,
        message: `Loaded skill: ${skillName}`
      };
    } catch (error: any) {
      return {
        skillName,
        loaded: false,
        error: error.message,
        message: `Failed to load skill: ${skillName}`
      };
    }
  }
});

export const findSkillTool = tool({
  description: 'Find the best matching skill for a specific task. Use this to discover which skill is most relevant for your current task.',
  inputSchema: z.object({
    task: z.string().describe('Description of the task you need help with'),
  }),
  execute: async ({ task }: { task: string }) => {
    const bestSkill = skillRegistry.findBestSkill(task);
    const suggestions = skillRegistry.suggestSkills(task);
    
    return {
      task,
      bestMatch: bestSkill ? { name: bestSkill.name, description: bestSkill.description } : null,
      suggestions: suggestions.map(s => ({ name: s.name, description: s.description })),
      message: bestSkill 
        ? `Best matching skill: ${bestSkill.name}`
        : 'No specific skill found for this task'
    };
  }
});

// Export all tools as a collection
export const allTools = {
  searchWebTool,
  readFileTool,
  writeFileTool,
  listFilesTool,
  editFileTool,
  searchCodebaseTool,
  runCommandTool
};

// Re-export new tools from their modules
export { webfetchTool } from './tools/webfetch.ts';
export { lspTool, findSymbolTool } from './tools/lsp.ts';
export { createTodoTool, updateTodoTool, listTodosTool, deleteTodoTool, todoManager } from './tools/todo.ts';
export { questionTool, recordAnswerTool, questionHistory } from './tools/question.ts';
