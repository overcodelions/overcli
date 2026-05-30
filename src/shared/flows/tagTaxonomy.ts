export interface TagAxis { axis: string; tags: string[] }

export const TAG_AXES: TagAxis[] = [
  { axis: 'Activity', tags: ['triage','review','design','planning','research','implementation','testing','refactor','documentation','operations','security','release','migration','debugging','analysis','communication'] },
  { axis: 'Surface',  tags: ['tickets','prs','issues','confluence','docs','email','calendar','roadmap','productboard','feedback','repo','logs','ci','infra'] },
  { axis: 'Domain',   tags: ['frontend','backend','api','data','mobile','ux','devops'] },
  { axis: 'Backend',  tags: ['claude','ollama','mcp-jira','mcp-confluence','mcp-github','mcp-gmail','mcp-drive'] },
];
