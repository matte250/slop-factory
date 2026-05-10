{EXAMPLE_PRELUDE}
Read CONVENTIONS.md and then DESIGN.md (both in your working directory) carefully before doing anything else. The DESIGN.md was produced by the previous design stage and contains the agreed-upon mechanics, hazard rules, and first-3-seconds simulation.

Now create the two required files (index.html and meta.json) for this game following both documents AND the structural patterns from the reference example above:

Title: {TITLE}
Concept: {CONCEPT}

Implement what DESIGN.md specifies. If something in DESIGN.md is missing or unclear, you may extend it, but you must not contradict the Mechanic verification section or the First 3 seconds simulation — those are the contract.

Follow CONVENTIONS.md exactly: dt-based physics with the worked-example pattern, the safe-spawn rule (no hazards on top of the player at t=0 — match the simulation in DESIGN.md), cancelAnimationFrame discipline on restart, and the visible Restart button.

Match the reference example's section order and divider banners (`// === CONFIG ===`, `// === STATE ===`, `// === RESET ===`, `// === LOOP ===` / `// === UPDATE ===`, `// === RENDER ===`, `// === INPUT ===`, `// === AUDIO ===`, `// === OBSERVABLE CONTRACT ===`, `// === BOOT ===`). Use plain object literals for game state (no `class`). Poll input via a `keys` Set, not direct mutation from listeners.

Before you finish, re-read your code and confirm: pressing each control listed in meta.json actually changes a value that affects collision or score in the next frame. If not, fix it.

Wrap your animation loop body in a try/catch so a stray bug does not crash the game.
