// Bundled flow templates surfaced in the "New flow" picker. Each
// template is a complete YAML body the user can drop into the editor
// and tweak. Inlined as TS strings rather than .yaml files so they
// ship with the build without extra Vite/electron-builder config.
//
// Adding a template: write the YAML body, give it an id (kebab-case),
// a friendly name, a one-line description for the picker, and an icon
// key (rendered as a stroked SVG glyph by the picker — see
// TemplateIcon in NewFlowPicker.tsx). Validation runs on every
// template at startup via the test suite to keep them honest.

export type FlowTemplateIcon =
  | 'target'
  | 'magnifier'
  | 'beaker'
  | 'refresh'
  | 'book'
  | 'spark-plus'
  | 'compass';

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  /// Icon key resolved to a monochrome stroked SVG in the picker so
  /// templates stay on brand with the rest of the app's iconography.
  icon: FlowTemplateIcon;
  yaml: string;
}

const SOLVE_TICKET_YAML = `name: Solve a ticket end-to-end
description: |
  Premium model fetches a Jira ticket + plans. A fast model implements.
  Premium reviews; on failure, bounces back to implement up to twice.
  A fast model writes tests. A premium shipper commits + opens a PR
  (paused before so a human can sanity-check first).
input: user_prompt
steps:
  - id: plan
    model: { backend: claude, model: claude-opus-4-7 }
    role: planner
    inputs: [user_prompt]
    tools: [Read, Grep, Glob]
    rebound:
      critic: { backend: claude, model: claude-sonnet-4-6 }
      mode: review
      max_iters: 3
    output: plan.md

  - id: build
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: implementer
    inputs: [plan.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    output: diff

  - id: review
    model: { backend: claude, model: claude-opus-4-7 }
    role: reviewer
    inputs: [plan.md, diff]
    tools: [Read, Grep]
    on_fail:
      action: goto
      target: build
      max_retries: 2
    output: review.md

  - id: tests
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: test-writer
    inputs: [diff, review.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    output: diff

  - id: push
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: shipper
    inputs: [plan.md, diff, review.md]
    tools: [Bash]
    pause_before: true
    output: pr_url
`;

const REVIEW_BRANCH_YAML = `name: Code-review my branch
description: |
  Read the current diff against main, produce a careful code review with
  file:line references, and write it to review.md. Read-only — no edits.
input: user_prompt
steps:
  - id: read-diff
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: researcher
    inputs: [user_prompt]
    tools: [Bash, Read, Grep, Glob]
    output: diff.md

  - id: review
    model: { backend: claude, model: claude-opus-4-7 }
    role: reviewer
    inputs: [user_prompt, diff.md]
    tools: [Read, Grep, Glob]
    output: review.md
`;

const ADD_TESTS_YAML = `name: Add tests to recent changes
description: |
  Look at the most recent commit(s), figure out what's under-tested, and
  add tests in the project's existing testing style.
input: user_prompt
steps:
  - id: survey
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: researcher
    inputs: [user_prompt]
    tools: [Bash, Read, Grep, Glob]
    output: survey.md

  - id: write-tests
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: test-writer
    inputs: [survey.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    output: diff
`;

const REFACTOR_VERIFY_YAML = `name: Refactor + verify
description: |
  Plan a refactor of a target file/function. A fast model implements it.
  Premium model verifies behavior is preserved by reading the diff and
  searching for callsites.
input: user_prompt
steps:
  - id: plan
    model: { backend: claude, model: claude-opus-4-7 }
    role: planner
    inputs: [user_prompt]
    tools: [Read, Grep, Glob]
    output: plan.md

  - id: refactor
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: implementer
    inputs: [plan.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    output: diff

  - id: verify
    model: { backend: claude, model: claude-opus-4-7 }
    role: reviewer
    inputs: [plan.md, diff]
    tools: [Read, Grep, Glob]
    on_fail:
      action: goto
      target: refactor
      max_retries: 2
    output: review.md
`;

const BUILD_FEATURE_YAML = `name: Build a feature
description: |
  Describe a feature in a sentence or two. Premium designs it, a fast
  model builds it, a fast model verifies the diff matches the design.
  Bounces back to build on review failure up to twice.
input: user_prompt
steps:
  - id: design
    model: { backend: claude, model: claude-opus-4-7 }
    role: planner
    inputs: [user_prompt]
    tools: [Read, Grep, Glob]
    output: design.md

  - id: build
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: implementer
    inputs: [design.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    output: diff

  - id: verify
    model: { backend: claude, model: claude-sonnet-4-6 }
    role: reviewer
    inputs: [design.md, diff]
    tools: [Read, Grep, Glob]
    on_fail:
      action: goto
      target: build
      max_retries: 2
    output: review.md
`;

const RESEARCH_DESIGN_BUILD_YAML = `name: Research + design + build
description: |
  Premium researches the topic with web + repo tools. Premium designs
  the feature from that research. Run pauses before build so you can
  chat with the designer to refine — your edits flow into the design
  artifact before a fast model implements.
input: user_prompt
steps:
  - id: research
    model: { backend: claude, model: claude-opus-4-7 }
    role: researcher
    inputs: [user_prompt]
    tools: [Read, Grep, Glob, WebFetch]
    output: research.md

  - id: design
    model: { backend: claude, model: claude-opus-4-7 }
    role: planner
    inputs: [user_prompt, research.md]
    tools: [Read, Grep, Glob]
    output: design.md

  - id: build
    model: { backend: ollama, model: qwen2.5-coder:32b }
    role: implementer
    inputs: [design.md]
    tools: [read_file, list_dir, grep, write_file, edit_file]
    permission_mode: bypassPermissions
    pause_before: true
    output: diff
`;

const RESEARCH_TOPIC_YAML = `name: Research a topic
description: |
  Read-only fact-finding. The model uses repo + web tools to gather
  context and produces a brief with citations. No code changes.
input: user_prompt
steps:
  - id: research
    model: { backend: claude, model: claude-opus-4-7 }
    role: researcher
    inputs: [user_prompt]
    tools: [Read, Grep, Glob, WebFetch]
    output: brief.md
`;

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: 'build-feature',
    name: 'Build a feature',
    description: 'Premium designs, fast builds, fast verifies. Minimal input — describe what you want.',
    icon: 'spark-plus',
    yaml: BUILD_FEATURE_YAML,
  },
  {
    id: 'research-design-build',
    name: 'Research + design + build',
    description: 'Premium researches, premium designs, you chat to refine the design, fast builds.',
    icon: 'compass',
    yaml: RESEARCH_DESIGN_BUILD_YAML,
  },
  {
    id: 'solve-ticket',
    name: 'Solve a ticket',
    description: 'Plan with premium, build with fast, review with premium, ship with a pause.',
    icon: 'target',
    yaml: SOLVE_TICKET_YAML,
  },
  {
    id: 'review-my-branch',
    name: 'Code-review my branch',
    description: 'Careful read-only review of the current diff with file:line references.',
    icon: 'magnifier',
    yaml: REVIEW_BRANCH_YAML,
  },
  {
    id: 'add-tests',
    name: 'Add tests',
    description: 'Survey recent changes and add tests in the project\'s existing style.',
    icon: 'beaker',
    yaml: ADD_TESTS_YAML,
  },
  {
    id: 'refactor-verify',
    name: 'Refactor + verify',
    description: 'Plan, refactor with fast, verify with a premium reviewer; retries if review fails.',
    icon: 'refresh',
    yaml: REFACTOR_VERIFY_YAML,
  },
  {
    id: 'research-topic',
    name: 'Research a topic',
    description: 'Read-only investigation with citations. No code changes.',
    icon: 'book',
    yaml: RESEARCH_TOPIC_YAML,
  },
];
