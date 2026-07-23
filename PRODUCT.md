# Product

## Register

product

## Users

Software engineers and technical operators who use a local coding agent from a
terminal while working inside an existing repository. They need to understand
what the agent is doing, intervene without losing their place, and trust that
changes remain recoverable and auditable.

## Product Purpose

Montane Code is a security-first local coding agent runtime. It helps users
inspect, change, test, and recover software work while keeping permissions,
tool execution, session history, and machine output explicit. Success means the
user can delegate a task, follow its meaningful progress, and verify or rewind
the result without learning the runtime's internal storage formats.

## Brand Personality

Calm, precise, trustworthy. The product should feel capable without being
theatrical, and concise without hiding consequential state.

## Anti-references

- Feature-heavy agent consoles that expose every internal event by default.
- Decorative full-screen terminal dashboards that displace the user's native
  scrollback and shell habits.
- Raw JSON and tab-separated records presented as the primary human interface.
- Multiple overlapping ways to perform the same action.
- Status animation that creates activity without communicating progress.

## Design Principles

- Keep one clear path for each task; replace weaker behavior instead of adding
  parallel modes.
- Show decisions, outcomes, and recovery paths; collapse transport-level noise.
- Preserve trustworthy source records while presenting a compact working view.
- Use progressive disclosure for detail, especially tool calls and diagnostics.
- Prefer terminal-native behavior and familiar commands over custom chrome.

## Accessibility & Inclusion

Human-readable output must not rely on color alone. Interactive actions need
keyboard access, status text must remain understandable without animation, and
output must degrade cleanly in non-TTY environments. Motion should be limited
to live state feedback and stop when work finishes.
