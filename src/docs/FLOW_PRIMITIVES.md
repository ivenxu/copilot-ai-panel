# Flow Execution Primitives

This document describes the three structural patterns for `.flow.yaml` files and the `delegate` role annotation.

## Three Structural Patterns

Execution pattern is inferred from which root key is present. The keys `roles:`, `stages:`, and `groups:` are mutually exclusive.

---

### 1. Pipeline (`roles:`)

Roles execute sequentially, each receiving the previous role's output as context.

```
[Role A] → [Role B] → [Role C]
```

**YAML example:**

```yaml
name: code-review
roles:
  - name: Analyst
    prompt: Analyse the code for issues.
  - name: Reviewer
    prompt: Write a structured review based on the analysis.
  - name: Summariser
    prompt: Produce a concise executive summary.
```

**Engine method:** `executePipeline()`

---

### 2. Iterative (`stages:`)

Stages run sequentially; each stage loops its roles for a configurable number of iterations. Useful for refinement workflows where the same set of roles processes the output multiple times.

```
Stage 1: [Role A × n] → Stage 2: [Role B × m]
```

**YAML example:**

```yaml
name: iterative-refine
stages:
  - name: Draft
    iterations: 1
    roles:
      - name: Writer
        prompt: Draft a response.
  - name: Review
    iterations: 2
    roles:
      - name: Critic
        prompt: Critique and improve the draft.
```

**Engine method:** `executeIterative()`

---

### 3. Fork-Join (`groups:` + `join:`)

Groups run concurrently (in parallel); their outputs are collected and passed to a single `join` role that synthesises the results.

```
         ┌─[Group A: Role 1]─┐
[query] ─┤                   ├─→ [join role]
         └─[Group B: Role 2]─┘
```

**YAML example:**

```yaml
name: multi-perspective
groups:
  - name: Technical
    roles:
      - name: Architect
        prompt: Analyse from a system-design perspective.
  - name: Business
    roles:
      - name: Analyst
        prompt: Analyse from a business-value perspective.
join:
  name: Synthesiser
  prompt: Combine both perspectives into a unified recommendation.
```

**Engine method:** `executeForkJoin()`

---

## Schema → Engine Dispatch Table

| Root key present | Execution method | Pattern name |
|---|---|---|
| `roles:` | `executePipeline()` | Pipeline |
| `stages:` | `executeIterative()` | Iterative |
| `groups:` + `join:` | `executeForkJoin()` | Fork-Join |

Exactly one root key must be present. The parser rejects files that provide more than one or none.

---

## The Cancel Gate

Any role — in any of the three patterns — can stop the flow before its not-yet-run roles/stages/groups execute, by including this exact sentinel anywhere in its final response text:

```
<!-- flow:cancel -->
```

This is the escape hatch for a **human-gate role**: a role whose prompt asks the user to confirm before continuing (e.g. "Reply with the marker below if I should NOT proceed: `<!-- flow:cancel -->`") and echoes the marker back when the user declines. Detection is a plain substring match — see `FlowEngine.CANCEL_MARKER`.

Behaviour per pattern:

| Pattern | On cancel |
|---|---|
| Pipeline (`roles:`) | Remaining roles are skipped. |
| Iterative (`stages:`) | Remaining roles in the current iteration, remaining iterations of the current stage, and all later stages are skipped. |
| Fork-Join (`groups:` + `join:`) | Remaining roles in the current group, remaining groups, and the `join` role are all skipped. |

The role that requested cancellation still has its response recorded and displayed as normal; only steps that had not yet run are skipped. The chat stream shows `⛔ Flow cancelled by <Role Name>` at the point execution stopped.

---

## The `delegate` Role Annotation

`delegate: true` on a role routes its execution through the **GitHub Copilot SDK** (background agent) instead of the VS Code Language Model API.

```yaml
roles:
  - name: Implementer
    agent: .github/agents/coder.agent.md
    delegate: true    # executes via Copilot SDK
  - name: Reviewer
    prompt: Review the implementation.
    # no delegate — executes via VS Code LM API (default)
```

### Orthogonality

`delegate` and `agent` are orthogonal axes:

| | `agent:` absent | `agent:` present |
|---|---|---|
| `delegate: false` (default) | Inline prompt via VS Code LM | Agent file via VS Code LM |
| `delegate: true` | Inline prompt via Copilot SDK | Agent file via Copilot SDK |

- **`agent:`** controls the *content source* (where the system prompt comes from)
- **`delegate:`** controls the *execution path* (which runtime handles the call)

### Context files for delegated roles

When a role has `delegate: true`, context files (`contexts:` and `#file:` references) are serialised into `sharedContext` before being passed to the SDK executor, since the SDK execution path does not support structured context file objects directly.

---

## Context Inheritance Chain

For every role, context is assembled in this order (lower priority dropped first when token budget is tight):

1. **Role system prompt** — from `prompt:` or resolved `agent:` file (priority 1000)
2. **User query** (priority 950)
3. **VS Code editor / workspace context** (priority 900)
4. **Conversation history** (priority 700)
5. **Context files** — from `contexts:` (role → stage → flow) + `#file:` attachments (priority 600)

The `sharedContext` string is prepended to context files and is never dropped independently.

---

## Migration Guide: Removing `orchestration:`

If your `.flow.yaml` has an `orchestration:` field, remove it. The execution pattern is now inferred from the presence of `roles:`, `stages:`, or `groups:`.

| Old | New |
|---|---|
| `orchestration: sequence` + `roles:` | Just `roles:` |
| `orchestration: sequence` + `stages:` | Just `stages:` |
| `orchestration: parallel` + `groups:` | Just `groups:` + `join:` |
| `orchestration: cli` | Add `delegate: true` to the relevant roles |

Files with a stale `orchestration:` field will show a deprecation warning in VS Code but will still execute correctly.
