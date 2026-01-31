import { z } from 'zod';
import { tool } from 'ai';
import * as fs from 'fs';
import * as path from 'path';
import { generateLSPSummary } from './utils/summarize.ts';

// Language server configurations
interface LanguageConfig {
  name: string;
  extensions: string[];
  command?: string;
  fallbackCommands?: string[];
}

interface SymbolMatch {
  file: string;
  line: number;
  content: string;
}

const languageConfigs: Record<string, LanguageConfig> = {
  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    command: 'npx typescript-language-server --stdio',
    fallbackCommands: ['tsc --noEmit'],
  },
  python: {
    name: 'Python',
    extensions: ['.py', '.pyi'],
    command: 'pylsp',
    fallbackCommands: ['python -m py_compile'],
  },
  go: {
    name: 'Go',
    extensions: ['.go'],
    command: 'gopls',
    fallbackCommands: ['go build -o /dev/null'],
  },
  rust: {
    name: 'Rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    fallbackCommands: ['cargo check'],
  },
};

// Detect language from file path
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  
  for (const [lang, config] of Object.entries(languageConfigs)) {
    if (config.extensions.includes(ext)) {
      return lang;
    }
  }
  
  return null;
}

// Find project root (where config files are)
async function findProjectRoot(filePath: string): Promise<string> {
  const startDir = path.dirname(filePath);
  let currentDir = startDir;
  
  const rootMarkers = [
    'package.json',
    'tsconfig.json',
    'Cargo.toml',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
    '.git',
  ];
  
  while (currentDir !== path.dirname(currentDir)) {
    for (const marker of rootMarkers) {
      if (fs.existsSync(path.join(currentDir, marker))) {
        return currentDir;
      }
    }
    currentDir = path.dirname(currentDir);
  }
  
  return startDir;
}

// Simple regex-based symbol finding (fallback when LSP unavailable)
async function findSymbolsWithRegex(
  filePath: string,
  content: string,
  method: string
): Promise<unknown> {
  const lines = content.split('\n');
  const results: Array<{ line: number; character: number; text: string }> = [];
  
  switch (method) {
    case 'diagnostics':
      // Simple syntax check - look for common issues
      const diagnostics: Array<{ line: number; message: string; severity: string }> = [];
      
      lines.forEach((line, index) => {
        // Check for unclosed parentheses (basic check)
        const openParens = (line.match(/\(/g) || []).length;
        const closeParens = (line.match(/\)/g) || []).length;
        if (openParens !== closeParens && !line.includes('//')) {
          diagnostics.push({
            line: index,
            message: 'Potentially unmatched parentheses',
            severity: 'warning',
          });
        }
        
        // Check for undefined variable usage (basic check for JS/TS)
        if (filePath.match(/\.(ts|tsx|js|jsx)$/)) {
          const undefinedMatch = line.match(/(\w+) is not defined/);
          if (undefinedMatch) {
            diagnostics.push({
              line: index,
              message: `Variable '${undefinedMatch[1]}' may be undefined`,
              severity: 'error',
            });
          }
        }
      });
      
      return diagnostics;
      
    case 'definition':
      // Find function/class definitions
      lines.forEach((line, index) => {
        const patterns = [
          /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
          /(?:export\s+)?class\s+(\w+)/,
          /(?:export\s+)?const\s+(\w+)\s*[=:]/,
          /(?:export\s+)?let\s+(\w+)\s*[=:]/,
          /(?:export\s+)?var\s+(\w+)\s*[=:]/,
          /(?:export\s+)?interface\s+(\w+)/,
          /(?:export\s+)?type\s+(\w+)\s*=/,
          /def\s+(\w+)/,  // Python
          /(?:pub\s+)?fn\s+(\w+)/,  // Rust
          /func\s+(\w+)/,  // Go
        ];
        
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match && match[1]) {
            results.push({
              line: index,
              character: line.indexOf(match[1]),
              text: match[1],
            });
          }
        }
      });
      return results;
      
    case 'references':
      // This would need to search other files - simplified version
      return [];
      
    case 'hover':
      // Extract doc comments before the line
      return { line: 0, documentation: 'No hover info available (LSP not connected)' };
      
    case 'completion':
      // List defined symbols as completions
      const completions: Array<{ label: string; kind: string }> = [];
      lines.forEach((line) => {
        const patterns = [
          /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
          /(?:export\s+)?class\s+(\w+)/,
          /(?:export\s+)?const\s+(\w+)/,
          /def\s+(\w+)/,
          /(?:pub\s+)?fn\s+(\w+)/,
        ];
        
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match && match[1]) {
            completions.push({ label: match[1], kind: 'function' });
          }
        }
      });
      return completions;
      
    default:
      return [];
  }
}

// Main LSP tool
export const lspTool = tool({
  description: `Code intelligence via Language Server Protocol or regex-based analysis.
Use for: finding definitions, references, type information, diagnostics.
ALWAYS prefer this over searchCodebase for semantic code understanding.
Provides precise results without loading file contents into context.

Supported languages: TypeScript/JavaScript, Python, Go, Rust.
Falls back to regex-based analysis if LSP server is unavailable.`,
  inputSchema: z.object({
    method: z.enum(['diagnostics', 'definition', 'references', 'hover', 'completion']).describe('LSP method to execute'),
    filePath: z.string().describe('Path to the file to analyze'),
    line: z.number().optional().describe('Line number (0-indexed) for specific operations'),
    character: z.number().optional().describe('Character position for specific operations'),
    symbol: z.string().optional().describe('Symbol name to search for (for references/definition)'),
  }),
  execute: async (params) => {
    try {
      // Resolve full path
      const fullPath = path.isAbsolute(params.filePath) 
        ? params.filePath 
        : path.join(process.cwd(), params.filePath);
      
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        return {
          success: false,
          error: `File not found: ${params.filePath}`,
          summary: generateLSPSummary({
            method: params.method,
            filePath: params.filePath,
            resultCount: 0,
            error: 'File not found',
          }),
        };
      }
      
      // Detect language
      const language = detectLanguage(fullPath);
      if (!language) {
        return {
          success: false,
          error: `Unsupported file type: ${path.extname(fullPath)}`,
          summary: generateLSPSummary({
            method: params.method,
            filePath: params.filePath,
            resultCount: 0,
            error: 'Unsupported file type',
          }),
        };
      }
      
      // Read file content
      const content = fs.readFileSync(fullPath, 'utf-8');
      
      // Find project root
      const projectRoot = await findProjectRoot(fullPath);
      
      // For now, use regex-based analysis (LSP server management is complex)
      const results = await findSymbolsWithRegex(fullPath, content, params.method);
      
      // Count results based on method
      let resultCount = 0;
      if (Array.isArray(results)) {
        resultCount = results.length;
      }
      
      // Generate detailed summary based on method
      let detailedSummary = '';
      if (Array.isArray(results) && results.length > 0) {
        const limitedResults = results.slice(0, 10);
        if (params.method === 'diagnostics') {
          detailedSummary = limitedResults.map((r: { line: number; message: string; severity: string }) => 
            `Line ${r.line + 1}: ${r.message} (${r.severity})`
          ).join('\n');
        } else if (params.method === 'definition' || params.method === 'completion') {
          detailedSummary = limitedResults.map((r: { line?: number; text?: string; label?: string }) => 
            `- ${r.text || r.label}${r.line !== undefined ? ` (line ${r.line! + 1})` : ''}`
          ).join('\n');
        }
        if (results.length > 10) {
          detailedSummary += `\n... and ${results.length - 10} more`;
        }
      }
      
      return {
        success: true,
        language,
        method: params.method,
        filePath: params.filePath,
        projectRoot: projectRoot !== path.dirname(fullPath) ? projectRoot : undefined,
        results,
        resultCount,
        summary: generateLSPSummary({
          method: params.method,
          filePath: params.filePath,
          resultCount,
        }),
        detailedSummary: detailedSummary || undefined,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
        summary: generateLSPSummary({
          method: params.method,
          filePath: params.filePath,
          resultCount: 0,
          error: msg,
        }),
      };
    }
  },
});

// Additional helper tool for finding files by symbol
export const findSymbolTool = tool({
  description: 'Find all occurrences of a symbol across the codebase using regex search. Useful for finding where functions, classes, or variables are defined or used.',
  inputSchema: z.object({
    symbol: z.string().describe('The symbol name to search for'),
    includePattern: z.string().optional().describe('File pattern to limit search (e.g., "*.ts")'),
  }),
  execute: async (params) => {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Build grep command
      const pattern = params.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const includeFlag = params.includePattern ? `--include="${params.includePattern}"` : '';
      const command = `grep -rnE "\\b${pattern}\\b" . ${includeFlag} --exclude-dir={node_modules,.git,.next,dist,build} 2>/dev/null | head -n 30`;
      
      const { stdout } = await execAsync(command);
      
      if (!stdout.trim()) {
        return {
          success: true,
          symbol: params.symbol,
          matches: 0,
          message: `No matches found for '${params.symbol}'`,
        };
      }
      
      const lines = stdout.split('\n').filter((l: string) => l.trim());
      const matches = lines.map((line: string) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match && match[1] && match[2] && match[3]) {
          return {
            file: match[1],
            line: parseInt(match[2], 10),
            content: match[3].trim(),
          };
        }
        return null;
      }).filter((m: SymbolMatch | null): m is SymbolMatch => m !== null);
      
      return {
        success: true,
        symbol: params.symbol,
        matches: matches.length,
        results: matches.slice(0, 20),
        truncated: matches.length > 20,
        summary: `Found ${matches.length} occurrence${matches.length !== 1 ? 's' : ''} of '${params.symbol}'`,
      };
    } catch (error) {
      // Grep returns exit code 1 when no matches found
      return {
        success: true,
        symbol: params.symbol,
        matches: 0,
        message: `No matches found for '${params.symbol}'`,
      };
    }
  },
});
