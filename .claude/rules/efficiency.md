# Efficiency rules (always loaded — keep short)

- Touch only files directly related to the task. Do not explore the repo "for context."
- Locate with Grep/Glob first; read only the needed line ranges, not whole files.
- Never re-read a file already read this session unless it changed.
- Large history/log docs (e.g. `docs/*LOG*.md`) are reference only: grep them, never read whole.
- No web search unless the user asks or the task needs a current API/version.
- Run `code-reviewer` / `security-reviewer` agents once, before commit — not after every edit.
- If scope is unclear, ask one question instead of investigating broadly.
- Report results in ≤5 lines. No step-by-step narration.
