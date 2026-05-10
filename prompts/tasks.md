Read CONVENTIONS.md and DESIGN.md in your working directory before doing anything else.

Your job in this stage is to break the implementation into a numbered list of small, ordered tasks. The next stage will work through this list one task at a time, in a single LLM session, reloading the page after each task and capturing console errors for you to fix.

Title: {TITLE}
Concept: {CONCEPT}

Write your task list to a file called `TASKS.md` in the working directory. The format MUST be a numbered list, one task per line, each line starting with `<number>.`:

```
1. <Task title> — <one-sentence description of what to do>
2. <Task title> — <one-sentence description>
...
```

The next stage parses tasks by matching `^\d+\.` at the start of each line. Don't use bullet sub-lists, don't number sub-tasks (1.1, 1.2). One number, one task, one line.

### What makes a good task

- **Small enough** to complete in a single coding turn (~50–150 lines of edits).
- **Testable**: after this task, what does the page do that it didn't before?
- **Leaves the file runnable**: at the end of the task, no syntax errors, no uncaught exceptions on load. Even if the game isn't playable yet, it must load.
- **Specific**: don't say "implement player". Say "implement player movement: arrow keys set keys.left/right; in update(), apply acceleration in the pressed direction with cap at MAX_SPEED, friction otherwise; clamp x to canvas bounds."
- **Concrete numbers**: this is where pixel sizes, ms intervals, and px/sec speeds live. Pick them. The implement stage will use them verbatim.

### Required coverage (in roughly this order)

Cover at minimum, ordered as below. Add tasks if the design demands more (powerups, level progression, screen wrap, etc):

1. **HTML scaffold + meta.json**: header (h1, description, controls list), canvas, restart button per CONVENTIONS.md. Stub `<script>` block (empty). meta.json matching header text.
2. **Game state objects**: player, hazards, score, phase using plain object literals at the top of the script. Set initial values.
3. **requestAnimationFrame loop**: startLoop() with `cancelAnimationFrame(loopId)` discipline at the top. Body wrapped in try/catch. Calls update(dt) and render(). Don't draw anything yet besides clearing the canvas.
4. **Input**: a `keys` Set populated by document keydown/keyup. R-key restart hook. Restart button click hook. Both call the same reset() function.
5. **Player movement**: dt-based physics tied to the key inputs from task 4. Verify each control listed in meta.json actually changes a value.
6. **Hazards**: data structure, spawn rules with a SAFE_RADIUS so nothing spawns on top of the player at t=0, motion (dt-scaled).
7. **Collision detection**: player vs hazards. On hit, transition phase to "gameover" and stop the active gameplay.
8. **Score**: discrete events that increase score, drawn on canvas at top-left.
9. **Render**: clear canvas, draw background, hazards, player, HUD. Player must be the highest-contrast object on screen.
10. **Game-over overlay**: dim background, "Game Over", final score, "Press R or click Restart".
11. **Observable contract**: populate `window.__game = { state, score, player:{x,y,visible}, objective }` every frame. `state` is "playing" | "gameover". `objective` is a 10–200 char single-sentence description.
12. **Audio**: lazy-init AudioContext inside a beep() helper, wrapped in try/catch. Hook into hit / score / death events.

You may merge two trivial tasks if they truly belong together (e.g. tasks 1+2 if state is just three lines). You may split a complex task in two. Aim for 10–15 tasks total.

After writing TASKS.md, stop. Do not begin implementation.
