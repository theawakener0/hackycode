# HackyCode

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-black?style=flat-square&logo=vercel&logoColor=white)](https://sdk.vercel.ai/docs)
[![Hack Club](https://img.shields.io/badge/Hack%20Club-EC3750?style=flat-square&logo=hackclub&logoColor=white)](https://hackclub.com)

**An AI-powered coding assistant for [Hack Club](https://hackclub.com) students.**

HackyCode is a terminal-based AI coding agent that helps you plan, build, and ship software faster. It combines the power of modern AI models with a dual-agent architecture designed specifically for the Hack Club community.


## Features

- **Dual-Agent Architecture** - Seamlessly switch between specialized agents:
  - **@Plan** - Software architect for analysis, planning, and design
  - **@Build** - Software engineer for implementation and execution

- **Powerful Built-in Tools**:
  -  Web search and intelligent web fetching
  -  File operations (read, write, edit)
  -  Codebase search with regex and LSP integration
  -  Smart todo management with dependency tracking
  -  Interactive question system for clarifications
  -  Skills system for extensible knowledge

-  **Built for Hack Club**:
  - Rate limiting for Hack Club's AI API (450 req/30min)
  - Context-aware conversations with markdown formatting
  - Terminal UI with beautiful syntax highlighting
  - Project-specific context via `AGENTS.md`

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- [Hack Club](https://hackclub.com) account with AI API access or another compatible AI API key

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/hackycode.git
cd hackycode

# Install dependencies
bun install
```

### Setup

Set your API key as an environment variable:

```bash
export HACK_CLUB_AI_API_KEY=your_api_key_here
```

Or create a `.env` file in the project root:

```env
HACK_CLUB_AI_API_KEY=your_api_key_here
```

### Run

```bash
bun start
```

## Usage

### Agent Commands

HackyCode uses specialized agents for different tasks:

**Use `@Plan` for architecture and planning:**

```
> @Plan Review the codebase and create a plan for adding authentication
```

**Use `@Build` for implementation:**

```
> @Build Implement the authentication system from the plan
```

### Available Commands

| Command | Description |
|---------|-------------|
| `/agents` | List available agents |
| `/agent [Plan\|Build]` | Switch to a specific agent |
| `/todos` | View and manage tasks |
| `/models` | List available AI models |
| `/model [name]` | Change the active model |
| `/cd [path]` | Change working directory |
| `/init` | Create project context file (`AGENTS.md`) |
| `/help` | Show all available commands |
| `/quit` or `/exit` | Exit HackyCode |

### Workflow Example

```
> @Plan Create a comprehensive plan to add user profiles feature

[Plan Agent analyzes codebase and creates structured plan with todos]

> @Build Implement the user profiles plan

[Build Agent executes the plan step by step]

> @Plan Review the implementation and suggest improvements

[Plan Agent reviews and provides feedback]
```

## Configuration

### Project Context (AGENTS.md)

Create an `AGENTS.md` file in your project root to provide context to the agents:

```bash
> /init
```

This generates a template that includes:
- Project overview and tech stack
- Coding standards and conventions
- Architecture guidelines
- Testing requirements

Example `AGENTS.md`:

```markdown
# Project Context

## Overview
A web application built with Next.js, TypeScript, and Prisma.

## Tech Stack
- Frontend: Next.js 14, React, Tailwind CSS
- Backend: Next.js API routes
- Database: PostgreSQL with Prisma ORM
- Auth: NextAuth.js

## Standards
- Use TypeScript for all new files
- Follow the existing component structure
- Write tests for critical functionality
```

### Working Directory

Navigate to different projects without leaving HackyCode:

```
> /cd /path/to/your/project
```

### Model Selection

Switch between available models:

```
> /models
Available models: anthropic/claude-3.5-sonnet, openai/gpt-4o, ...

> /model anthropic/claude-3.5-sonnet
Model set to: anthropic/claude-3.5-sonnet
```

## Rate Limits

HackyCode is optimized for Hack Club's AI API limits:

- **450 requests per 30 minutes**

Automatic handling includes:
- Request queuing (~4 seconds between requests)
- Exponential backoff for retries
- Real-time status display
- Smart request batching where possible

## Development

```bash
# Run in development mode
bun run dev

# Type check
bun run typecheck

# Build
bun run build
```

## Skills System

Extend HackyCode with custom skills for specific technologies:

```typescript
// Register a new skill
import { skillRegistry } from './skills';

skillRegistry.register({
  name: 'react',
  description: 'React development expertise',
  reference: 'path/to/react-docs.md'
});
```

Use skills in conversations:

```
> How do I use useEffect?
[HackyCode automatically loads the react skill]
```

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) - Built for the [Hack Club](https://hackclub.com) community

