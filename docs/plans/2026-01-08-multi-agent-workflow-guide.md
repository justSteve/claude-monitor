# Multi-Agent Workflow Guide

**Purpose**: Training document for orchestrating multi-agent development workflows, using the Conversation Capture feature as a concrete example.

## Context for Next Session

### Project State
- **Design doc**: `docs/plans/2026-01-08-conversation-capture-design.md` (complete, committed)
- **Beads epic**: `claude-monitor-0gq` - ready to start
- **First task**: `claude-monitor-umu` - Schema migration (no blockers)

### Quick Start Commands
```bash
cd C:\myStuff\_infra\claude-monitor
bd ready                    # See what's available to work on
bd show claude-monitor-0gq  # Review the epic
bd show claude-monitor-umu  # Review first task
```

---

## Multi-Agent Workflow Patterns

### Pattern 1: Parallel Independent Tasks

**When to use**: Tasks with no dependencies that can be worked simultaneously.

**Example from this project**: After schema migration, both the JSONL parser (`claude-monitor-djp`) and config extractor (`claude-monitor-scu`) can run in parallel - they only share the schema dependency.

**Orchestration**:
```
You: "Work on djp and scu in parallel"

Claude launches two Task agents:
  Agent A: Implements JSONL parser
  Agent B: Implements config extractor

Both report back independently.
```

**Key skill**: `superpowers:dispatching-parallel-agents`
- Use when 3+ independent problems exist
- Each agent gets full context but works isolated
- Results merged by orchestrating agent

### Pattern 2: Pipeline Dependencies

**When to use**: Tasks that must complete in sequence because outputs feed inputs.

**Example from this project**:
```
Schema (umu) → Parser (djp) → Artifact Extractor (l5v) → API (1tb) → Frontend (yvv)
```

**Orchestration**:
```
You: "Implement the conversation capture feature"

Claude:
1. Marks umu as in_progress
2. Completes schema migration
3. Marks umu complete, djp in_progress
4. Completes parser
5. ...continues down the chain
```

**Key skill**: `superpowers:executing-plans`
- Loads plan, executes in batches
- Reports for review between batches
- Handles rollback if batch fails

### Pattern 3: Subagent-Driven Development

**When to use**: Complex implementation where you want quality gates between tasks.

**Example workflow**:
```
Main Agent orchestrates:
  → Spawns Subagent for Task 1
  ← Reviews output, requests code review
  → Spawns Code Review Agent
  ← Merges feedback
  → Spawns Subagent for Task 2
  ...
```

**Key skill**: `superpowers:subagent-driven-development`
- Fresh subagent per task (no context pollution)
- Code review between tasks
- Main agent maintains strategic view

### Pattern 4: Explore → Plan → Execute

**When to use**: Unfamiliar codebase or unclear requirements.

**Phases**:
1. **Explore**: Use `Task` with `subagent_type=Explore` to understand codebase
2. **Plan**: Use `superpowers:writing-plans` to create detailed implementation
3. **Execute**: Use `superpowers:executing-plans` or parallel agents

**This conversation demonstrated Phase 1-2**: We explored the schema, file types, and design space before creating the implementation plan.

---

## Orchestration Commands for This Project

### Starting Implementation

**Option A: Sequential with Review Checkpoints**
```
"Use the executing-plans skill to implement the conversation capture feature.
Start with the schema migration (claude-monitor-umu).
Stop for review after each task."
```

**Option B: Maximize Parallelism**
```
"After schema migration, dispatch parallel agents for:
- JSONL parser (claude-monitor-djp)
- Config extractor (claude-monitor-scu)

Then continue with artifact extractor after parser completes."
```

**Option C: Full Subagent-Driven**
```
"Use subagent-driven-development for this epic.
Each task gets a fresh subagent.
Code review between each task.
I want to approve before moving to the next task."
```

### Checking Progress
```bash
bd list --status=in_progress  # What's being worked on
bd list --status=open         # What's left
bd blocked                    # What's stuck
```

### Handling Blockers
```
"Task X is blocked because [reason].
Create a new task to address the blocker,
add it as a dependency, then continue."
```

---

## Your Role as Orchestrator

### What YOU Control
1. **Pace**: "Do one task then stop" vs "Keep going until blocked"
2. **Review depth**: "Stop for approval" vs "Use your judgment"
3. **Parallelism**: "Sequential only" vs "Parallelize where possible"
4. **Quality gates**: "Code review each task" vs "Review at milestones only"

### What the AGENT Handles
1. Reading/understanding requirements
2. Writing code
3. Running tests
4. Managing dependencies
5. Tracking progress in beads/TodoWrite

### Effective Prompts

**Too vague**:
> "Implement the feature"

**Better**:
> "Implement claude-monitor-umu (schema migration).
> Mark it in_progress when you start.
> Run the migration and verify the tables exist.
> Mark complete when done.
> Then move to djp (parser)."

**Best** (for complex work):
> "Use the executing-plans skill with the design doc at
> docs/plans/2026-01-08-conversation-capture-design.md.
> Execute in batches of 1 task.
> Stop for my review after each batch.
> Dispatch parallel agents for djp/scu since they're independent."

---

## Dependency Graph for This Project

```
                    ┌─────────────────────────────────────────┐
                    │  claude-monitor-0gq (EPIC)              │
                    │  Conversation Capture for History Review │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │  claude-monitor-umu                     │
                    │  Schema migration (5 new tables)        │
                    └────────┬───────────────────┬────────────┘
                             │                   │
            ┌────────────────▼───┐     ┌────────▼──────────────┐
            │  claude-monitor-djp│     │  claude-monitor-scu   │
            │  JSONL/TXT parser  │     │  Config extractor     │
            └────────┬───────────┘     └────────┬──────────────┘
                     │                          │
            ┌────────▼───────────┐              │
            │  claude-monitor-l5v│              │
            │  Artifact extractor│              │
            └────────┬───────────┘              │
                     │                          │
                     └──────────┬───────────────┘
                                │
                    ┌───────────▼─────────────────────────────┐
                    │  claude-monitor-1tb                     │
                    │  API endpoints                          │
                    └───────────┬─────────────────────────────┘
                                │
                    ┌───────────▼─────────────────────────────┐
                    │  claude-monitor-yvv                     │
                    │  Frontend browser UI                    │
                    └─────────────────────────────────────────┘
```

**Parallelization opportunities**:
- `djp` and `scu` can run in parallel (both depend only on `umu`)
- `l5v` must wait for `djp`
- `1tb` must wait for both `l5v` and `scu`
- `yvv` must wait for `1tb`

---

## Session Handoff Checklist

Before ending a session:
```
[ ] git status              - Check what changed
[ ] git add <files>         - Stage code changes
[ ] bd sync                 - Commit beads changes
[ ] git commit -m "..."     - Commit code
[ ] git push                - Push to remote
[ ] bd list --status=open   - Note what's left for next session
```

### Current State (End of Design Session)
- [x] Design document written and committed
- [x] Beads epic created with 6 tasks
- [x] Dependencies configured
- [ ] Implementation not started
- [ ] Next: Run `bd ready` and start with `claude-monitor-umu`

---

## Recommended Next Session Opener

```
"I'm continuing work on the conversation capture feature for claude-monitor.

Run `bd ready` to see available tasks.
Read the design doc at docs/plans/2026-01-08-conversation-capture-design.md.

Use subagent-driven-development to implement the epic (claude-monitor-0gq).
Start with the schema migration (claude-monitor-umu).
Parallelize djp and scu after the schema is done.
Stop for my review after each task completes."
```

This gives the agent:
1. **Context**: What project, what feature
2. **Resources**: Where to find details
3. **Method**: Which workflow pattern to use
4. **Pace**: When to stop for review
5. **Optimization**: Where parallelism is safe
