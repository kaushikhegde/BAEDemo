export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}
export interface RequirementParams {
  process_l3?: string;
  process_l4?: string;
  starting_story_number?: string;
  /** The work item every story is created under. Optional — omit for none. */
  ado_parent_epic_id?: string;
  ado_org?: string;
  ado_project?: string;
  /** Which wiki. Omit when the project has exactly one; required when it has more. */
  ado_wiki?: string;
}
export interface TriggerBody {
  feature_name: string;
  params: RequirementParams;
  input_files: { name: string; path: string }[];
}
