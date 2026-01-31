import { z } from 'zod';
import { tool } from 'ai';
import { generateQuestionSummary } from './utils/summarize.ts';

// Store for question history
interface QuestionRecord {
  id: string;
  question: string;
  answer: string;
  timestamp: number;
}

class QuestionHistory {
  private questions: QuestionRecord[] = [];
  private maxHistory = 10;

  add(question: string, answer: string): string {
    const id = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.questions.push({
      id,
      question,
      answer,
      timestamp: Date.now(),
    });

    // Keep only recent questions
    if (this.questions.length > this.maxHistory) {
      this.questions = this.questions.slice(-this.maxHistory);
    }

    return id;
  }

  getHistory(): QuestionRecord[] {
    return this.questions;
  }

  formatForContext(): string {
    if (this.questions.length === 0) return '';
    
    return this.questions
      .map(q => `Q: ${q.question.substring(0, 60)}${q.question.length > 60 ? '...' : ''} -> A: ${q.answer.substring(0, 40)}${q.answer.length > 40 ? '...' : ''}`)
      .join('\n');
  }
}

export const questionHistory = new QuestionHistory();

// For non-interactive mode, we return structured data that the CLI can format
export const questionTool = tool({
  description: `Ask the user a question to clarify requirements or make decisions. 
Use when:
- Requirements are ambiguous or unclear
- Multiple valid implementation approaches exist
- Need confirmation before destructive operations (deleting files, etc.)
- Missing critical information to proceed

The agent should PAUSE execution and wait for user response. The tool returns a structured question object that should be presented to the user.`,
  inputSchema: z.object({
    type: z.enum(['single_choice', 'multiple_choice', 'text', 'confirmation']).describe('Type of question'),
    question: z.string().describe('The question text to display to the user'),
    options: z.array(z.object({
      label: z.string().describe('Display label for the option'),
      value: z.string().describe('Value returned when selected'),
      description: z.string().optional().describe('Additional description'),
    })).optional().describe('Options for single_choice or multiple_choice'),
    allowCustom: z.boolean().optional().describe('Allow user to enter custom answer (adds "Other" option)'),
    required: z.boolean().default(true).describe('Whether an answer is required'),
    context: z.string().optional().describe('Context explaining why this question is being asked'),
  }),
  execute: async (params) => {
    try {
      // Validate options for choice types
      if ((params.type === 'single_choice' || params.type === 'multiple_choice') && 
          (!params.options || params.options.length === 0)) {
        return {
          success: false,
          error: 'Options are required for single_choice and multiple_choice question types',
          summary: generateQuestionSummary({
            question: params.question,
            answer: 'Error',
            error: 'Missing options',
          }),
        };
      }

      // Add "Other" option if custom answers allowed
      let finalOptions = params.options || [];
      if (params.allowCustom && (params.type === 'single_choice' || params.type === 'multiple_choice')) {
        finalOptions = [...finalOptions, { 
          label: 'Other (specify)', 
          value: '__custom__',
          description: 'Enter a custom answer'
        }];
      }

      // Return structured question data
      // Note: The actual UI rendering and user input handling should be done by the CLI
      return {
        success: true,
        requiresUserInput: true,
        questionData: {
          type: params.type,
          question: params.question,
          options: finalOptions,
          required: params.required,
          context: params.context,
        },
        formattedQuestion: formatQuestionForDisplay(params.type, params.question, finalOptions, params.context),
        summary: generateQuestionSummary({
          question: params.question,
          answer: '(awaiting user input)',
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
        summary: generateQuestionSummary({
          question: params.question,
          answer: 'Error',
          error: msg,
        }),
      };
    }
  },
});

// Helper to format question for terminal display
function formatQuestionForDisplay(
  type: string,
  question: string,
  options: Array<{ label: string; value: string; description?: string }>,
  context?: string
): string {
  const lines: string[] = [];
  
  lines.push('');
  lines.push('┌─────────────────────────────────────────────────────┐');
  lines.push('│  ◆ The agent has a question                         │');
  lines.push('│                                                      │');
  
  // Word wrap the question
  const wrappedQuestion = wrapText(question, 50);
  wrappedQuestion.forEach(line => {
    lines.push(`│  ${line.padEnd(50)} │`);
  });
  
  if (context) {
    lines.push('│                                                      │');
    const wrappedContext = wrapText(`Context: ${context}`, 50);
    wrappedContext.forEach(line => {
      lines.push(`│  ${line.padEnd(50)} │`);
    });
  }
  
  if (options.length > 0) {
    lines.push('│                                                      │');
    lines.push('│  Options:                                           │');
    options.forEach((opt, index) => {
      const label = `[${index + 1}] ${opt.label}`;
      lines.push(`│    ${label.padEnd(48)} │`);
      if (opt.description) {
        const desc = wrapText(`    ${opt.description}`, 50);
        desc.forEach(line => {
          lines.push(`│  ${line.padEnd(50)} │`);
        });
      }
    });
  }
  
  lines.push('│                                                      │');
  
  if (type === 'confirmation') {
    lines.push('│  [Y] Yes    [N] No                                  │');
  } else if (type === 'text') {
    lines.push('│  Enter your answer: _                               │');
  } else {
    lines.push('│  Select option(s) or type custom answer: _          │');
  }
  
  lines.push('└─────────────────────────────────────────────────────┘');
  lines.push('');
  
  return lines.join('\n');
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine += (currentLine ? ' ' : '') + word;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines;
}

// Tool to record the answer after user provides it
export const recordAnswerTool = tool({
  description: 'Record the answer to a previously asked question. This is used internally after the user provides their response.',
  inputSchema: z.object({
    question: z.string().describe('The original question'),
    answer: z.string().describe('The user\'s answer'),
    questionType: z.string().describe('Type of question that was asked'),
  }),
  execute: async (params) => {
    try {
      questionHistory.add(params.question, params.answer);
      
      return {
        success: true,
        recorded: true,
        summary: generateQuestionSummary({
          question: params.question,
          answer: params.answer,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
      };
    }
  },
});
