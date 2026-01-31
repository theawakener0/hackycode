import { z } from 'zod';
import { tool } from 'ai';
import { generateTodoSummary } from './utils/summarize.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: number;
  completedAt?: number;
  dependsOn?: string[];
  fileContext?: string[];
  notes?: string;
}

class TodoManager {
  private todos: Map<string, Todo> = new Map();
  private currentTodoId?: string;
  private maxTodos = 50; // Prevent unlimited growth

  generateId(): string {
    return `todo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  create(params: {
    title: string;
    description?: string;
    priority: TodoPriority;
    dependsOn?: string[];
    fileContext?: string[];
  }): Todo {
    // Cleanup old completed todos if at limit
    if (this.todos.size >= this.maxTodos) {
      this.cleanupOldTodos();
    }

    const todo: Todo = {
      id: this.generateId(),
      title: params.title,
      description: params.description,
      status: 'pending',
      priority: params.priority,
      createdAt: Date.now(),
      dependsOn: params.dependsOn,
      fileContext: params.fileContext,
    };

    this.todos.set(todo.id, todo);
    return todo;
  }

  update(
    todoId: string,
    status: TodoStatus,
    notes?: string
  ): Todo | null {
    const todo = this.todos.get(todoId);
    if (!todo) {
      return null;
    }

    todo.status = status;
    if (notes) {
      todo.notes = notes;
    }

    if (status === 'completed') {
      todo.completedAt = Date.now();
    } else if (status === 'in_progress') {
      this.currentTodoId = todoId;
    }

    return todo;
  }

  delete(todoId: string): boolean {
    return this.todos.delete(todoId);
  }

  get(todoId: string): Todo | undefined {
    return this.todos.get(todoId);
  }

  list(params?: {
    status?: TodoStatus;
    priority?: TodoPriority;
    limit?: number;
    includeCompleted?: boolean;
  }): Todo[] {
    let todos = Array.from(this.todos.values());

    // Filter out completed todos by default unless includeCompleted is true
    if (!params?.includeCompleted && !params?.status) {
      todos = todos.filter(t => t.status !== 'completed');
    }

    if (params?.status) {
      todos = todos.filter(t => t.status === params.status);
    }

    if (params?.priority) {
      todos = todos.filter(t => t.priority === params.priority);
    }

    // Sort by: in_progress first, then by priority (high -> low), then by creation time
    todos.sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      
      return b.createdAt - a.createdAt;
    });

    const limit = params?.limit ?? 20;
    return todos.slice(0, limit);
  }

  getStats(): {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    blocked: number;
  } {
    const todos = Array.from(this.todos.values());
    return {
      total: todos.length,
      pending: todos.filter(t => t.status === 'pending').length,
      in_progress: todos.filter(t => t.status === 'in_progress').length,
      completed: todos.filter(t => t.status === 'completed').length,
      blocked: todos.filter(t => t.status === 'blocked').length,
    };
  }

  private cleanupOldTodos() {
    // Remove oldest completed todos when at limit
    const completed = Array.from(this.todos.values())
      .filter(t => t.status === 'completed')
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    // Remove 20% of completed todos
    const toRemove = Math.ceil(completed.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      const todo = completed[i];
      if (todo) {
        this.todos.delete(todo.id);
      }
    }
  }

  generateSummary(): string {
    const stats = this.getStats();
    const active = this.list({ status: 'in_progress', limit: 3 });
    const pending = this.list({ status: 'pending', limit: 5 });

    let summary = `Todos: ${stats.total} total (${stats.completed} completed, ${stats.in_progress} in progress, ${stats.pending} pending`;
    if (stats.blocked > 0) {
      summary += `, ${stats.blocked} blocked`;
    }
    summary += ')';

    if (active.length > 0) {
      summary += `\n  Active: ${active.map(t => t.title).join(', ')}`;
    }

    return summary;
  }
}

// Singleton instance
export const todoManager = new TodoManager();

// Tool definitions
export const createTodoTool = tool({
  description: 'Create a new todo item for tracking implementation tasks. Use this to break down complex tasks into manageable steps.',
  inputSchema: z.object({
    title: z.string().describe('Short, actionable title for the todo'),
    description: z.string().optional().describe('Detailed description of what needs to be done'),
    priority: z.enum(['low', 'medium', 'high']).default('medium').describe('Priority level'),
    dependsOn: z.array(z.string()).optional().describe('IDs of todos that must be completed before this one'),
    fileContext: z.array(z.string()).optional().describe('Related file paths for context'),
  }),
  execute: async (params) => {
    try {
      const todo = todoManager.create(params);
      return {
        success: true,
        todo: {
          id: todo.id,
          title: todo.title,
          status: todo.status,
          priority: todo.priority,
        },
        summary: generateTodoSummary({
          action: 'Created todo',
          todoTitle: todo.title,
          status: todo.status,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
        summary: generateTodoSummary({
          action: 'Failed to create todo',
          todoTitle: params.title,
          error: msg,
        }),
      };
    }
  },
});

export const updateTodoTool = tool({
  description: 'Update a todo status (mark as in_progress, completed, blocked, or back to pending). Add notes about progress or blockers.',
  inputSchema: z.object({
    todoId: z.string().describe('The ID of the todo to update'),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('New status'),
    notes: z.string().optional().describe('Additional notes about the update'),
  }),
  execute: async (params) => {
    try {
      const todo = todoManager.update(params.todoId, params.status, params.notes);
      if (!todo) {
        return {
          success: false,
          error: `Todo not found: ${params.todoId}`,
          summary: generateTodoSummary({
            action: 'Update failed',
            todoTitle: params.todoId,
            error: 'Todo not found',
          }),
        };
      }

      return {
        success: true,
        todo: {
          id: todo.id,
          title: todo.title,
          status: todo.status,
          notes: todo.notes,
        },
        summary: generateTodoSummary({
          action: 'Updated todo',
          todoTitle: todo.title,
          status: todo.status,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
        summary: generateTodoSummary({
          action: 'Update failed',
          todoTitle: params.todoId,
          error: msg,
        }),
      };
    }
  },
});

export const listTodosTool = tool({
  description: 'List all todos with optional filtering by status or priority. Returns a summary view for context efficiency.',
  inputSchema: z.object({
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('Filter by status'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('Filter by priority'),
    limit: z.number().default(20).describe('Maximum number of todos to return'),
    includeCompleted: z.boolean().default(false).describe('Include completed todos in results'),
  }),
  execute: async (params) => {
    try {
      // If not including completed and no status filter, default to pending/in_progress/blocked
      let filterStatus = params.status;
      if (!filterStatus && !params.includeCompleted) {
        // Return all non-completed todos
        const allTodos = todoManager.list({ limit: params.limit * 2 });
        const filtered = allTodos.filter(t => t.status !== 'completed').slice(0, params.limit);
        
        const stats = todoManager.getStats();
        return {
          success: true,
          todos: filtered.map(t => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            description: t.description?.substring(0, 100),
            notes: t.notes?.substring(0, 50),
          })),
          stats,
          summary: todoManager.generateSummary(),
        };
      }

      const todos = todoManager.list({
        status: filterStatus,
        priority: params.priority,
        limit: params.limit,
        includeCompleted: params.includeCompleted,
      });

      const stats = todoManager.getStats();

      return {
        success: true,
        todos: todos.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description?.substring(0, 100),
          notes: t.notes?.substring(0, 50),
        })),
        stats,
        summary: todoManager.generateSummary(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: msg,
        summary: generateTodoSummary({
          action: 'List failed',
          todoTitle: 'all todos',
          error: msg,
        }),
      };
    }
  },
});

export const deleteTodoTool = tool({
  description: 'Delete a todo item. Use this to clean up completed or irrelevant todos.',
  inputSchema: z.object({
    todoId: z.string().describe('The ID of the todo to delete'),
  }),
  execute: async (params) => {
    try {
      const todo = todoManager.get(params.todoId);
      if (!todo) {
        return {
          success: false,
          error: `Todo not found: ${params.todoId}`,
        };
      }

      todoManager.delete(params.todoId);
      return {
        success: true,
        deletedTodo: {
          id: todo.id,
          title: todo.title,
        },
        summary: generateTodoSummary({
          action: 'Deleted todo',
          todoTitle: todo.title,
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

// Re-export the todo manager for direct access
export { TodoManager };
