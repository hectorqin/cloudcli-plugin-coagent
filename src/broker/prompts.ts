import fs from 'node:fs';
import path from 'node:path';

export interface Prompts {
  lead(vars: Record<string, string>): string;
  worker(role: string, vars: Record<string, string>): string;
}

const render = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

/** Templates are plain markdown files so prompts can be tuned without touching code. Read fresh on every use. */
export function filePrompts(dir: string): Prompts {
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  return {
    lead: (vars) => render(read('lead.md'), vars),
    worker: (role, vars) => {
      let roleText: string;
      try { roleText = read(path.join('roles', `${role}.md`)); } catch { roleText = `You are a ${role}.`; }
      return render(read('worker.md'), { ...vars, role, role_instructions: render(roleText.trim(), vars) });
    },
  };
}
