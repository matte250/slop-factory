You previously implemented this game in this directory. Many past games have shipped with broken core mechanics that nobody caught. Your job in this stage is to verify the game is actually playable, then fix everything that isn't.

Title: {TITLE}
Concept: {CONCEPT}

Re-read DESIGN.md (in this directory) first — the implement stage was supposed to follow it.

Work through the four steps below in order. You MUST wrap the entire analysis in a JS comment block at the top of index.html using these EXACT marker lines (the validator checks for them):

  /* === CRITIQUE ANALYSIS — preserve through polish ===
     Step 1: ...
     Step 2: ...
     Step 3: ...
     Step 4: ...
     === END CRITIQUE === */

If those markers are missing the validator will reject the file and you will be retried.

## Step 1 — Trace the first 3 seconds with NO input

Read the relevant code (player init, hazard spawn, update loop). Then write out the simulation as text:

  t=0.0s: player position is X, hazards at [list], distances [list], time-to-impact for each [list]
  t=1.0s: where will player be (no input)? where will each hazard be?
  t=2.0s: same.
  t=3.0s: same.

Then answer: with NO INPUT from the player, would they die before t=2.0s?
  - If YES: the spawn is too aggressive. Push hazards further away, define a SAFE_RADIUS, or skip spawns inside it for the first 3 seconds. Fix it.
  - If the player can NEVER die regardless of input: the collision/end-condition is broken. Fix it.

## Step 2 — Trace one frame of input

For EACH control listed in meta.json:
  - What state value does the keypress / click change? (be specific: ship.vx, ship.angle, isJumping, etc.)
  - In the next frame, does that state change actually affect collision OR score outcomes?

If any control is purely cosmetic (changes nothing collision-relevant), the game's mechanic is fundamentally broken — fix it so the input has a real gameplay effect that matches the concept.

## Step 3 — Verify the playable contract AND the design match

For each item, write PASS or FAIL: <how>. Reference specific code:

  1. Can the player lose? (collision/end condition that fires gameOver and stops the active loop)
  2. Can the player score on discrete events? (not just elapsed time)
  3. Does game-over draw final score on the canvas?
  4. Does R-key reset state? Does the Restart button do the SAME thing?
  5. Does restart cancelAnimationFrame the previous loop? (otherwise loops stack)
  6. Are all physics scaled by dt (delta seconds)? Or are there per-frame constants like `x += 5`?
  7. Is there visual feedback (flash/particle/shake) on death AND on score?
  8. Does the implemented mechanic actually do what the concept describes?
  9. Does the implementation match DESIGN.md? Specifically: hazard spawn rules, score event, mechanic verification, first-3-seconds simulation. Quote one mismatch if you find any.

## Step 4 — Fix every FAIL

Edit index.html in place to fix every FAIL from steps 1–3. Do NOT recreate the file from scratch — preserve what works. If you change controls or description, also update meta.json (the validator will reject mismatch).

When done: re-read index.html to confirm it's syntactically valid AND that the `=== CRITIQUE ANALYSIS ===` / `=== END CRITIQUE ===` markers are present in your top-of-file comment block. The polish stage will preserve this block.
