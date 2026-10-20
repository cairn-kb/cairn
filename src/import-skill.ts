/**
 * The `cairn-import` skill: what a coding agent follows to write a first set
 * of overview documents for a repository that has too little documentation
 * to import. Cairn never calls a model itself during first run — the user's
 * own agent reads the code and writes the documents through
 * `team_knowledge_write_document`, which tags them as generated so they never
 * read as a team decision.
 */

/** What the user says to their agent to start the scan. */
export const CODE_SCAN_TRIGGER = "map this repo for cairn"

export function codeScanPrompt(label: string): string {
  return `${CODE_SCAN_TRIGGER} (repo: ${label})`
}

/** One sentence each agent shows when deciding whether to load the skill. */
export const IMPORT_SKILL_DESCRIPTION =
  `Map a repository's code into overview documents in cairn. Use when the user says "${CODE_SCAN_TRIGGER}".`

/** The skill's body, shared by every agent's file; only the frontmatter differs. */
export const IMPORT_SKILL = `# Map this repository for cairn

The user asked you to "${CODE_SCAN_TRIGGER}". This repository has little written
documentation, so you will read its code and write a handful of overview
documents into cairn. Agents working here later will find them through
cairn's search tools.

## The repo label

The request ends with \`(repo: <label>)\`, for example
\`${codeScanPrompt("acme/my-app")}\`. Pass that label as \`repo\` on every write,
exactly as given. If no label was given, ask the user for it. Do not make
one up: the label is what tells this repository's documents apart from
another's.

## Read the code first

Look at, at least:

- entry points: the main executable, server start-up, exported packages
- module layout: the top-level folders and what each one owns
- build files: package manifests, lockfiles, Makefiles, CI workflows, Dockerfiles
- tests: where they live, how they are run, what they cover

## Write four documents

Write each one with the \`team_knowledge_write_document\` tool, passing
\`repo\` (the label), \`slug\`, \`title\`, \`text\` (markdown) and \`agent\`
(your own name). Use exactly these slugs:

- \`architecture\`: what the system is, its main parts, and how a request
  or a run flows through them
- \`modules\`: each top-level folder or package and what it is responsible for
- \`conventions\`: naming, error handling, testing and formatting patterns the
  code actually follows
- \`build-and-run\`: how to install, build, test and run it, with the real
  commands

Writing the same slug again replaces that document, so run this again
whenever the code has moved on.

## Stick to what the code shows

These documents are generated, not team decisions, and readers will treat
them that way. So:

- State only what the code shows. Name the file or folder you are
  describing.
- Where you are inferring, for example about intent, history or why
  something is built the way it is, say so in so many words ("this appears
  to…", "inferred from…").
- Do not present guesses as rules, and do not invent decisions, owners or
  plans.
- Leave out secrets, credentials and personal data you come across.

When you are done, tell the user which documents you wrote and what you were
unsure about.
`
