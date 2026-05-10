All implementation tasks completed, but the final full validation just failed. The page was loaded in a real browser and one or more checks did not pass. Fix the issues by editing the existing `index.html` and `meta.json` in place — do NOT rewrite from scratch.

This is the SAME session that implemented the game; you have full memory of what you did. The errors below are observed runtime behavior, not abstract complaints.

Validation errors:
{ERRORS_LIST}

This is fix iteration {ITERATION} of {MAX_ITERATIONS}. After your edits, the page will be reloaded and re-validated. If errors persist after {MAX_ITERATIONS} iterations, this game is abandoned.

Common interpretations:
- "canvas appears blank" → the game is loading but `render()` isn't drawing anything. Check that `startLoop()` actually got called at boot, that `render()` runs every frame, and that you're issuing `ctx.fill*` / `ctx.stroke*` calls per entity each frame (not just clearing the canvas).
- "controls list mismatch" → the `<ul class="game-controls">` in `index.html` and the `controls` array in `meta.json` disagree. Pick one source of truth, edit the other to match exactly.
- "playtest: player.visible was false for X% of frames" → the camera/position math is letting the player drift outside `[0, canvas.width) × [0, canvas.height)`. Either clamp the player or update `player.visible` to reflect the truth (don't just hardcode `true`).
- "playtest: state took invalid value" → `window.__game.state` must be exactly `"menu"`, `"playing"`, or `"gameover"`. No other strings.
- "Required file missing: meta.json" → you didn't write the file. Use your write tool now.
- "pageerror" / "console.error" → an exception is being thrown at runtime. Read the message, locate the line, fix the bug.

**Use your write/edit tool to apply the fixes.** Do NOT respond with code in chat — the files on disk are what gets validated.

**Final check before you stop**: confirm you actually called write/edit and that the files on disk now reflect your fixes.
