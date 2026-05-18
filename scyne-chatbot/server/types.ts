export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}
export interface RequirementParams {
  process_l3?: string;
  process_l4?: string;
  starting_story_number?: string;
  parent_epic_key?: string;
  jira_project_key?: string;
  confluence_space_key?: string;
  confluence_page_title?: string;
}
export interface TriggerBody {
  feature_name: string;
  params: RequirementParams;
  input_files: { name: string; path: string }[];
}
