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
  /**
   * The work item type stories are created as.
   *
   * A PARAMETER rather than something the publishing agent looks up, because
   * there is no MCP tool that lists a project's work item types — verified
   * against the live server's 40 tools. "User Story" exists only in the Agile
   * process template; a Basic project has Epic → Issue → Task and none, so a
   * guess fails every story at once.
   */
  ado_work_item_type?: string;
}
export interface TriggerBody {
  feature_name: string;
  params: RequirementParams;
  input_files: { name: string; path: string }[];
}
