import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildWorkspaceServer } from "../src/workspace/mcp.js";
import { loadConfig } from "../src/shared/config.js";

/** Every tool the workspace plane offers, as the parity contract with the web
 *  chat and the `scyne` CLI. Written out rather than derived, so ADDING a tool
 *  is a deliberate edit here and REMOVING one cannot happen silently. */
const EXPECTED = [
  // documents
  "ingest_document", "attach_document", "read_document",
  "replace_document", "delete_document", "list_documents",
  // pipeline
  "stages", "start_stage", "revise_artefact", "republish_artefact", "staleness",
  // gates
  "approve_gate", "reject_gate", "request_changes",
  // issues
  "issue_status", "list_issues", "pause_issue", "resume_issue",
  "cancel_issue", "issue_runs", "run_transcript",
  // workspace
  "create_project", "create_feature", "list_projects", "list_features",
  "get_project_definition", "save_project_definition", "extract_brand",
  // reporting
  "spend", "actions", "history",
].sort();

const registered = (): string[] => {
  const server = buildWorkspaceServer({ cfg: loadConfig({}) });
  // The SDK keeps them on the underlying server instance; reaching in is the
  // only way to assert the real registration rather than a list we also wrote.
  const tools = (server as any)._registeredTools ?? {};
  return Object.keys(tools).sort();
};

describe("workspace tool surface", () => {
  it("offers exactly the documented set", () => {
    expect(registered()).toEqual(EXPECTED);
  });

  it("covers what the web chat's LLM tools can do", () => {
    // The chatbot's own tool names, mapped to this plane's equivalents. Every
    // trigger_* is one start_stage call, which is why they collapse.
    const chatCanDo: Record<string, string> = {
      create_project: "create_project",
      create_feature: "create_feature",
      list_documents: "list_documents",
      delete_document: "delete_document",
      save_project_definition: "save_project_definition",
      extract_brand: "extract_brand",
      revise_artefact: "revise_artefact",
      republish_artefact: "republish_artefact",
      bootstrap_project: "start_stage",
      trigger_capability_map: "start_stage",
      trigger_personas: "start_stage",
      trigger_requirement_generation: "start_stage",
      trigger_ui_mockups: "start_stage",
      trigger_data_model: "start_stage",
      trigger_solution_architecture: "start_stage",
      trigger_test_cases: "start_stage",
      trigger_solution_design: "start_stage",
      trigger_ui_build: "start_stage",
    };
    const have = new Set(registered());
    for (const [chatTool, ours] of Object.entries(chatCanDo)) {
      expect(have.has(ours), `${chatTool} → ${ours}`).toBe(true);
    }
  });

  it("covers the CLI's daily-work verbs", () => {
    const cliCanDo: Record<string, string> = {
      "project create": "create_project",
      "project describe": "save_project_definition",
      "feature create": "create_feature",
      "doc list": "list_documents",
      "doc upload": "ingest_document",
      "doc replace": "replace_document",
      "doc delete": "delete_document",
      "run <workflow>": "start_stage",
      "stages": "stages",
      "run cancel": "cancel_issue",
      "issues": "list_issues",
      "status": "issue_status",
      "gate approve": "approve_gate",
      "gate reject": "reject_gate",
      "logs": "run_transcript",
      "actions": "actions",
      "spend": "spend",
    };
    const have = new Set(registered());
    for (const [verb, ours] of Object.entries(cliCanDo)) {
      expect(have.has(ours), `scyne ${verb} → ${ours}`).toBe(true);
    }
  });

  it("documents every tool it registers", () => {
    // The header block is the only place a reader learns the surface; a tool
    // registered but never named there is an undocumented tool.
    const src = readFileSync(new URL("../src/workspace/mcp.ts", import.meta.url), "utf8");
    const header = src.slice(0, src.indexOf("export const buildWorkspaceServer"));
    const undocumented = registered().filter((t) => !header.includes(t));
    expect(undocumented).toEqual([]);
  });
});
