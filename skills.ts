import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Skill definition interface
export interface Skill {
  name: string;
  description: string;
  baseDir: string;
  references: string[];
  triggers: string[];
}

// Skill registry to manage available skills
export class SkillRegistry {
  private skillsDir: string;
  private loadedSkills: Map<string, Skill> = new Map();
  private activeSkill: Skill | null = null;

  constructor() {
    // Look for skills in the opencode skills directory
    this.skillsDir = path.join(process.env.HOME || '~', '.agents', 'skills');
  }

  // Discover all available skills
  async discoverSkills(): Promise<Skill[]> {
    const skills: Skill[] = [];
    
    try {
      const skillDirs = await fs.promises.readdir(this.skillsDir, { withFileTypes: true });
      
      for (const dir of skillDirs) {
        if (dir.isDirectory()) {
          const skillPath = path.join(this.skillsDir, dir.name);
          const skill = await this.parseSkill(dir.name, skillPath);
          if (skill) {
            skills.push(skill);
            this.loadedSkills.set(skill.name, skill);
          }
        }
      }
    } catch (error) {
      console.error('[SkillRegistry] Error discovering skills:', error);
    }
    
    return skills;
  }

  // Parse a skill from its directory
  private async parseSkill(name: string, skillPath: string): Promise<Skill | null> {
    try {
      const skillFile = path.join(skillPath, 'SKILL.md');
      
      if (!fs.existsSync(skillFile)) {
        return null;
      }
      
      const content = await fs.promises.readFile(skillFile, 'utf-8');
      
      // Parse frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let description = '';
      
      if (frontmatterMatch && frontmatterMatch[1]) {
        const descMatch = frontmatterMatch[1].match(/description:\s*(.+)/);
        if (descMatch && descMatch[1]) {
          description = descMatch[1].replace(/^['"](.*)['"]$/, '$1');
        }
      } else {
        // Fallback: extract first paragraph
        const firstPara = content.split('\n\n')[0];
        if (firstPara) {
          description = firstPara.replace(/^#+\s*/, '').slice(0, 200);
        }
      }
      
      // Find all reference files
      const references: string[] = [];
      const refsDir = path.join(skillPath, 'references');
      
      if (fs.existsSync(refsDir)) {
        const walkDir = (dir: string, prefix: string = '') => {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              walkDir(fullPath, path.join(prefix, item.name));
            } else if (item.name.endsWith('.md')) {
              references.push(path.join(prefix, item.name));
            }
          }
        };
        walkDir(refsDir);
      }
      
      // Extract trigger keywords from description
      const triggers = this.extractTriggers(description);
      
      return {
        name,
        description,
        baseDir: skillPath,
        references,
        triggers
      };
    } catch (error) {
      console.error(`[SkillRegistry] Error parsing skill ${name}:`, error);
      return null;
    }
  }

  // Extract trigger keywords from description
  private extractTriggers(description: string): string[] {
    const triggers: string[] = [];
    
    // Common tech keywords to look for
    const techKeywords = [
      'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt',
      'typescript', 'javascript', 'python', 'go', 'rust', 'java',
      'tailwind', 'css', 'sass', 'styled-components',
      'testing', 'jest', 'playwright', 'cypress',
      'docker', 'kubernetes', 'aws', 'vercel', 'netlify',
      'database', 'postgres', 'mongodb', 'redis',
      'api', 'graphql', 'rest', 'websocket',
      'ai', 'ml', 'openai', 'anthropic', 'claude',
      'ui', 'ux', 'design', 'animation',
      'git', 'github', 'ci/cd', 'devops',
      'security', 'auth', 'oauth', 'jwt'
    ];
    
    const descLower = description.toLowerCase();
    for (const keyword of techKeywords) {
      if (descLower.includes(keyword)) {
        triggers.push(keyword);
      }
    }
    
    return triggers;
  }

  // Find the best matching skill for a task
  findBestSkill(task: string): Skill | null {
    const taskLower = task.toLowerCase();
    let bestMatch: Skill | null = null;
    let bestScore = 0;
    
    for (const skill of this.loadedSkills.values()) {
      let score = 0;
      
      // Check triggers
      for (const trigger of skill.triggers) {
        if (taskLower.includes(trigger.toLowerCase())) {
          score += 2;
        }
      }
      
      // Check description keywords
      const descWords = skill.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 4 && taskLower.includes(word)) {
          score += 1;
        }
      }
      
      // Check skill name
      if (taskLower.includes(skill.name.toLowerCase())) {
        score += 3;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = skill;
      }
    }
    
    return bestMatch;
  }

  // Load skill content
  async loadSkillContent(skillName: string, referencePath?: string): Promise<string> {
    const skill = this.loadedSkills.get(skillName);
    if (!skill) {
      throw new Error(`Skill ${skillName} not found`);
    }
    
    this.activeSkill = skill;
    
    let content = '';
    
    // Load main SKILL.md
    const skillFile = path.join(skill.baseDir, 'SKILL.md');
    content += await fs.promises.readFile(skillFile, 'utf-8');
    content += '\n\n---\n\n';
    
    // Load specific reference if requested
    if (referencePath) {
      const refFile = path.join(skill.baseDir, 'references', referencePath);
      if (fs.existsSync(refFile)) {
        content += await fs.promises.readFile(refFile, 'utf-8');
      }
    } else {
      // Load all references (summary only to avoid overwhelming context)
      content += '## Available References:\n';
      for (const ref of skill.references) {
        content += `- ${ref}\n`;
      }
    }
    
    return content;
  }

  // Get skill context for agent prompts
  getSkillContext(): string {
    if (!this.activeSkill) {
      return '';
    }
    
    return `
## Active Skill: ${this.activeSkill.name}

${this.activeSkill.description}

Available references: ${this.activeSkill.references.length}
`;
  }

  // Suggest skills for a task
  suggestSkills(task: string): Skill[] {
    const matches: Skill[] = [];
    const taskLower = task.toLowerCase();
    
    for (const skill of this.loadedSkills.values()) {
      let relevance = 0;
      
      for (const trigger of skill.triggers) {
        if (taskLower.includes(trigger.toLowerCase())) {
          relevance += 2;
        }
      }
      
      if (relevance > 0) {
        matches.push(skill);
      }
    }
    
    return matches.slice(0, 3); // Top 3 matches
  }

  // Install a new skill using the skills CLI
  async installSkill(skillRef: string): Promise<boolean> {
    try {
      console.log(`[SkillRegistry] Installing skill: ${skillRef}`);
      await execAsync(`npx skills add ${skillRef} -g -y`);
      
      // Rediscover skills
      await this.discoverSkills();
      return true;
    } catch (error) {
      console.error(`[SkillRegistry] Failed to install skill ${skillRef}:`, error);
      return false;
    }
  }

  // Get all available skills as formatted list
  formatSkillList(): string {
    const skills = Array.from(this.loadedSkills.values());
    if (skills.length === 0) {
      return 'No skills available. Use `/skills install <skill-ref>` to add skills.';
    }
    
    let output = '## Available Skills:\n\n';
    for (const skill of skills) {
      output += `- **${skill.name}**: ${skill.description.slice(0, 100)}...\n`;
    }
    
    return output;
  }
}

// Singleton instance
export const skillRegistry = new SkillRegistry();

// Skill-aware prompt enhancer
export async function enhancePromptWithSkills(
  prompt: string,
  context?: { workingDirectory?: string; lastAction?: string }
): Promise<string> {
  // Ensure skills are discovered
  const skills = await skillRegistry.discoverSkills();
  
  // Find best matching skill
  const bestSkill = skillRegistry.findBestSkill(prompt);
  
  if (!bestSkill) {
    return prompt;
  }
  
  // Load skill content
  try {
    const skillContent = await skillRegistry.loadSkillContent(bestSkill.name);
    
    // Enhance prompt with skill knowledge
    const enhancedPrompt = `${prompt}

---

## Specialized Knowledge Available

You have access to the **${bestSkill.name}** skill which provides specialized knowledge for this task.

${skillContent.slice(0, 3000)} <!-- Limit skill content to avoid overwhelming -->

Use this specialized knowledge when appropriate for the task at hand.
`;
    
    return enhancedPrompt;
  } catch (error) {
    console.error('[Skill Enhancer] Error loading skill:', error);
    return prompt;
  }
}
