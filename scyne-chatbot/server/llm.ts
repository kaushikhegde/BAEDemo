import { GoogleGenerativeAI, SchemaType, type Tool } from "@google/generative-ai";
import fs from "node:fs/promises";
import path from "node:path";

if (!process.env.GEMINI_API_KEY) {
  console.warn("[llm] Warning: GEMINI_API_KEY not set; chat will fail until configured.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
export const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const WORKSPACE = process.env.WORKSPACE_PATH || "/Users/tagariwalayashesh/Projects/buzzinga/requirement-generator";

/** Scan ./projects/<project>/<feature>/ structure on demand. */
async function listAvailable(): Promise<Record<string, { name: string; counts: Record<string, number> }[]>> {
  const projectsDir = path.join(WORKSPACE, "projects");
  const out: Record<string, { name: string; counts: Record<string, number> }[]> = {};
  try {
    const projects = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const features = await fs.readdir(path.join(projectsDir, p.name), { withFileTypes: true });
      out[p.name] = [];
      for (const s of features) {
        if (!s.isDirectory()) continue;
        const subPath = path.join(projectsDir, p.name, s.name);
        const subs = await fs.readdir(subPath, { withFileTypes: true });
        const counts: Record<string, number> = {};
        for (const sub of subs) {
          if (!sub.isDirectory()) continue;
          const files = await fs.readdir(path.join(subPath, sub.name));
          counts[sub.name] = files.length;
        }
        out[p.name].push({ name: s.name, counts });
      }
    }
  } catch {}
  return out;
}

function formatFeatures(tree: Record<string, { name: string; counts: Record<string, number> }[]>): string {
  const entries = Object.entries(tree);
  if (entries.length === 0) return "(no projects detected on disk yet)";
  return entries
    .map(([proj, features]) => {
      const ss = features
        .map((s) => {
          const fileSummary = Object.entries(s.counts)
            .map(([sub, n]) => `${n} ${sub}`)
            .join(", ");
          return `    - ${s.name}${fileSummary ? ` (${fileSummary})` : ""}`;
        })
        .join("\n");
      return `- ${proj}:\n${ss || "    (no features)"}`;
    })
    .join("\n");
}

function buildSystemPrompt(featuresBlock: string): string {
  return `You are the Scyne Requirements Assistant. The user is a Scyne consultant.

Inputs live under a project + feature hierarchy:

\`\`\`
./projects/<project>/<feature>/
├── policy/         (policy & domain docs)
├── transcripts/    (meeting transcripts)
├── notes/          (additional notes)
└── ui/             (UI mockups / screens)
\`\`\`

## Current state of the workspace

Available projects and features on disk right now:

${featuresBlock}

This list is refreshed every time we talk, so trust it as the current truth.

## Defaults used unless the user overrides

- Feature: ${process.env.DEFAULT_FEATURE_NAME}
- Process L3: ${process.env.DEFAULT_PROCESS_L3}
- Process L4: ${process.env.DEFAULT_PROCESS_L4}
- Starting story number: ${process.env.DEFAULT_STARTING_STORY_NUMBER}
- Parent epic: ${process.env.DEFAULT_PARENT_EPIC_KEY}
- Jira project: ${process.env.DEFAULT_JIRA_PROJECT_KEY}
- Confluence space: ${process.env.DEFAULT_CONFLUENCE_SPACE_KEY}
- Confluence page title: ${process.env.DEFAULT_CONFLUENCE_PAGE_TITLE}

## Conversation flow — important

Follow this discovery pattern unless the user jumps ahead:

1. **Greet briefly.** Just say hi. Do NOT list projects, features, or defaults upfront. Wait for the user to ask.
2. **When the user asks about projects** (e.g. "what projects do you have?", "show me projects", "list projects") — respond with the project names from the workspace list above, one per line. Ask which one they want to dig into.
3. **When the user picks a project** (e.g. "SADA", "tell me about SADA") — respond with the features under that project, one per line. Ask which feature.
4. **When the user picks a feature** (e.g. "interim-benefit") — confirm in one line ("OK, I'll process *SADA / interim-benefit*"). Briefly note any defaults that matter. Ask if they're ready to fire.
5. **When the user confirms** (any natural phrasing — "go", "fire it", "yes", "generate the product summary and Jira tickets", "run it") — call the \`trigger_requirement_generation\` tool with the chosen project + feature.

If the user jumps straight to "process SADA / interim-benefit" or similar — skip the discovery steps and go straight to step 4 or 5 as appropriate.

When you call the tool, ALWAYS include \`project\` and \`feature\`. Add any other overrides the user mentioned. Omit fields that should use defaults.

After firing, the application surfaces progress and approval. Don't add commentary unless the user asks something new.

Speak warmly and concisely. Australian English. No marketing fluff. Short replies — one or two short lines per turn unless the user asks for detail.`;
}

const triggerTool: Tool = {
  functionDeclarations: [
    {
      name: "trigger_requirement_generation",
      description: "Fires the requirement-generator workflow. Call this when the user has confirmed which project + feature and is ready to proceed.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name, e.g. 'SADA'. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name inside the project, e.g. 'interim-benefit'. Required." },
          feature_name: { type: SchemaType.STRING, description: "Override the default feature name." },
          process_l3: { type: SchemaType.STRING, description: "Override the default L3 process." },
          process_l4: { type: SchemaType.STRING, description: "Override the default L4 process." },
          starting_story_number: { type: SchemaType.STRING, description: "Override the default starting story number." },
          parent_epic_key: { type: SchemaType.STRING, description: "Override the default parent epic key." },
          jira_project_key: { type: SchemaType.STRING, description: "Override the default Jira project key." },
          confluence_space_key: { type: SchemaType.STRING, description: "Override the default Confluence space key." },
          confluence_page_title: { type: SchemaType.STRING, description: "Override the default Confluence page title." },
        },
        required: ["project", "feature"],
      },
    },
  ],
};

async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (error: any) {
      lastError = error;
      const isRetryable =
        error.status === 503 || error.status === 429 || error.status === 500 ||
        error.message?.includes("overloaded") || error.message?.includes("rate limit") ||
        error.message?.includes("timeout") || error.code === "ECONNRESET" || error.code === "ETIMEDOUT";
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[llm] retry ${attempt + 1}/${maxRetries + 1} after ${(delay / 1000).toFixed(1)}s: ${error.message ?? error.statusText}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

type AnthropicMsg = { role: "user" | "assistant"; content: any };

function toGeminiHistory(history: AnthropicMsg[]) {
  return history.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
    const parts: any[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
      if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input } });
    }
    return { role, parts: parts.length ? parts : [{ text: "" }] };
  });
}

function normalize(response: any) {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  const blocks: any[] = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length) blocks.push({ type: "text", text: p.text });
    if (p.functionCall) blocks.push({ type: "tool_use", name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  return { content: blocks };
}

export async function chat(messages: AnthropicMsg[]) {
  const tree = await listAvailable();
  const systemPrompt = buildSystemPrompt(formatFeatures(tree));

  const history = toGeminiHistory(messages);
  const lastUser = history.pop();
  const userText = lastUser?.parts?.find((p: any) => typeof p.text === "string")?.text ?? "";

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: systemPrompt,
    tools: [triggerTool],
  });

  const chatSession = model.startChat({ history });

  const response = await retryWithBackoff(async () => {
    const r = await chatSession.sendMessage(userText);
    return r.response;
  });

  return normalize(response);
}
