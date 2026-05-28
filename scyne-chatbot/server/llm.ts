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

type UiContext = { active: boolean; project?: string | null; feature?: string | null } | null;

function buildSystemPrompt(
  featuresBlock: string,
  target?: { project: string | null; feature: string | null } | null,
  uiContext?: UiContext,
): string {
  const uiBlock = uiContext?.active
    ? `\n## A live UI preview is ACTIVE for ${uiContext.project}/${uiContext.feature}\n\nThe right pane is showing a running, editable UI build. For EACH user message decide the intent:\n- **A question or request for information** ("what does this screen do?", "why is it laid out this way?", "is it responsive?", "what's left to do?") → just answer in text. Do NOT touch the build.\n- **A change to the UI** ("make the header navy", "add a back button", "move the table up", "use bigger fonts") → call \`comment_on_ui_build\` with kind="modify" and a clear \`instruction\`.\n- **Approval** ("looks good", "ship it", "approve", "that's perfect") → call \`comment_on_ui_build\` with kind="approve".\n- **Push to GitHub** ("push to github <url>", "publish it to <repo>") → call \`comment_on_ui_build\` with kind="push" and \`repo_url\`.\n\nWhen unsure whether it's a question or a change, prefer answering in text and ask a one-line clarifying question. Never silently turn a question into a modify instruction.\n`
    : "";
  const targetBlock = target?.project && target?.feature
    ? `\n## Currently selected target (from the UI's target picker)\n\nThe user has already picked **${target.project} / ${target.feature}** in the target picker. Treat this as the active project + feature and DO NOT re-ask for them. When the user says "build the UI", "yes use that", "go", "fire it", etc., immediately call the relevant tool with \`project="${target.project}"\` and \`feature="${target.feature}"\`. Only ask again if the user explicitly names a different project or feature.\n`
    : "";
  return `You are the Scyne Requirements Assistant. The user is a Scyne consultant.

Inputs live under a project + feature hierarchy:

\`\`\`
./projects/<project>/<feature>/
├── requirements/
│   ├── Policy/        (policy & domain docs)
│   ├── Transcripts/   (meeting transcripts)
│   ├── Notes/         (additional notes)
│   └── UI/            (UI mockups / screens)
└── design/            (style guides + example screens for the UI agent)
\`\`\`

## Current state of the workspace

Available projects and features on disk right now:

${featuresBlock}

This list is refreshed every time we talk, so trust it as the current truth.
${targetBlock}${uiBlock}

## Defaults used unless the user overrides

- Feature: ${process.env.DEFAULT_FEATURE_NAME}
- Process L3: ${process.env.DEFAULT_PROCESS_L3}
- Process L4: ${process.env.DEFAULT_PROCESS_L4}
- Starting story number: ${process.env.DEFAULT_STARTING_STORY_NUMBER}
- Jira project key + Confluence space key: **default to the project name** (e.g. project "RTWSA" → Jira/Confluence key "RTWSA"). They are NOT fixed to SADA. Only override if the user explicitly names a different Jira project or Confluence space. The BA verifies the project/space exists before pushing and stops if it doesn't (it cannot create them).

## Conversation flow — important

You orchestrate two workflows from the same chat:

1. **Requirements** — turns transcripts + policy + UI screens into Jira stories + a Confluence Product Summary. Invoked via the \`trigger_requirement_generation\` tool.
2. **UI build** — turns the design folder + the BA's Product Summary into a working Vite + React + shadcn/ui app, previewed in the right-pane iframe. Invoked via the \`trigger_ui_build\` tool.

### Requirements path

1. **Greet briefly.** Just say hi. Do NOT list projects, features, or defaults upfront. Wait for the user to ask.
2. **When the user asks about projects** — respond with the project names, one per line. Ask which one.
3. **When the user picks a project** (or names one in passing, e.g. "use SADA") — call \`set_target\` with just that project (omit \`feature\`) AND respond in text with the features under that project, one per line. Ask which feature.
4. **When the user picks a feature** (or names a project + feature together, e.g. "use SADA / interim-benefit") — call \`set_target\` with the chosen project + feature AND confirm in one line of text ("OK, I'll process *SADA / interim-benefit*"). Note any defaults. Ask if they're ready.
5. **When the user confirms** (any natural phrasing — "go", "fire it", "yes", "run it", "generate") — call \`trigger_requirement_generation\` with the chosen project + feature.

**Rule:** every turn where the user names a project (with or without a feature) MUST include a \`set_target\` call so the UI picker stays in sync. The only exception is when you're firing a trigger tool in the same turn — those already update the picker.

### UI build path

The user can request a UI build either upfront ("make the UI for SADA/interim-benefit") or after the BA finishes ("yes, build it" in response to the post-push prompt).

- **Upfront request** (e.g. "build the UI for SADA / interim-benefit", "make a UI for X", "design the screens for X"): call \`trigger_ui_build\` with the chosen project + feature. The backend will check that BA outputs (product-summary.md) exist; if not, it'll surface an error and you should ask the user whether to run the requirements flow first.
- **After BA push**: when the Activity timeline shows the BA flow is \`done\` and a Confluence URL is live, the application may surface a quick "Yes, build the UI" action. Treat any affirmative reply ("yes", "build it", "go ahead") as a request to call \`trigger_ui_build\` for the currently active project/feature.

If the user asks both at once ("generate requirements and build the UI for SADA/interim-benefit"): call \`trigger_requirement_generation\` first. The UI build prompt will follow automatically once requirements are done.

### Target picker sync

The user can also switch targets mid-conversation ("switch to RTWSA / return-to-work"). Treat that the same as the rule in steps 3–4: call \`set_target\` with whatever they named, then respond in text.

When you call any trigger tool, ALWAYS include \`project\` and \`feature\`. Omit fields that should use defaults.

After firing, the application surfaces progress. Don't add commentary unless the user asks something new.

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
    {
      name: "set_target",
      description: "Update the target project + feature in the UI's target picker WITHOUT firing any workflow. Call this every time the user names a project (with or without a feature) so the picker stays in sync with the conversation. Pass `feature` when the user has named one; omit it if only the project is known so far.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Optional — omit if only the project is known so far." },
        },
        required: ["project"],
      },
    },
    {
      name: "trigger_ui_build",
      description: "Fires the UI agent to scaffold a Vite + React + shadcn/ui app from the BA's Product Summary + the design folder. Call this when the user asks to make / build / design the UI for a specific project + feature, or affirmatively answers a 'build the UI?' prompt after the BA finishes.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["project", "feature"],
      },
    },
    {
      name: "control_dev_server",
      description: "Start or stop the local dev server for a scaffolded UI app. Use when the user says things like 'stop the UI', 'kill the preview', 'shut down the server', 'start the UI', 'bring the preview back up', 'restart it'. For 'restart', call this tool twice in a row (stop then start) — or call it once with action=start, since start is idempotent against an already-running server. Always pass project + feature; default to the currently active target if the user doesn't name them.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          action: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["start", "stop"],
            description: "start = launch the dev server (idempotent — no-op if already running); stop = kill the dev server's pid.",
          },
          project: { type: SchemaType.STRING, description: "Project folder name. Required." },
          feature: { type: SchemaType.STRING, description: "Feature folder name. Required." },
        },
        required: ["action", "project", "feature"],
      },
    },
    {
      name: "comment_on_ui_build",
      description: "Post an instruction to the live UI build (only call this when a UI preview is ACTIVE, per the system prompt). Use it ONLY when the user wants to change the generated UI, approve it, or push it to GitHub. Do NOT call it for questions, requests for information, or chit-chat — answer those in text instead.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          kind: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["modify", "approve", "push"],
            description: "modify = a visual/behaviour change request; approve = the user is happy with the UI; push = push the app to a GitHub repo.",
          },
          instruction: { type: SchemaType.STRING, description: "For kind=modify, the change to make, phrased as a clear instruction. For approve/push, a short echo of the user's intent." },
          repo_url: { type: SchemaType.STRING, description: "For kind=push only: the GitHub repo URL to push to." },
        },
        required: ["kind", "instruction"],
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

export async function chat(
  messages: AnthropicMsg[],
  target?: { project: string | null; feature: string | null } | null,
  uiContext?: UiContext,
) {
  const tree = await listAvailable();
  const systemPrompt = buildSystemPrompt(formatFeatures(tree), target, uiContext);

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
