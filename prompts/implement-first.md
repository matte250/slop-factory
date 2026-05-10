{EXAMPLE_PRELUDE}
Read CONVENTIONS.md, DESIGN.md, and TASKS.md in your working directory carefully before doing anything else. CONVENTIONS.md describes the contract every game must follow. DESIGN.md is the game design. TASKS.md is the ordered implementation plan.

This is the implementation phase. You will work through the tasks in TASKS.md ONE AT A TIME, in order. After each task you complete, the page is loaded in a real headless browser and console errors are checked. If any are found, you'll be asked to fix them in this same session before moving to the next task.

Game context:
Title: {TITLE}
Concept: {CONCEPT}

Use the reference example above as your structural template — section divider banners, the `keys` Set input pattern, the `cancelAnimationFrame` discipline at the top of `startLoop()`, the lazy AudioContext, the `publishState()` call once per frame.

**You must produce two output files in this turn: `index.html` and `meta.json` in the working directory.** Use your write/edit tool to create them on disk. After your turn ends, the validator runs `readFile("index.html")` and `readFile("meta.json")` — if either file does not exist on disk, validation fails and your work is wasted. **Do NOT reply with code as inline chat text.** All output must be written to files via the write tool.

NOW DO TASK 1 OF {TASK_TOTAL}:

{TASK_TEXT}

**Important rules for this session:**
- Complete ONLY task 1. Do not start task 2 yet — wait for the next instruction.
- The game does not need to be playable yet. It just needs to load in a browser without console errors.
- Keep edits small and focused. The page is reloaded after each task.
- For later tasks (2 onward), edit the existing `index.html` / `meta.json` in place — do NOT rewrite from scratch.

**Final check before you stop**: confirm you actually called your write tool to create both `index.html` and `meta.json` on disk. If you only described the code in chat without invoking the tool, the files won't exist and validation will fail. After both files are written, stop and wait for the next instruction.
