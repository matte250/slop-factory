Read CONVENTIONS.md in your working directory before doing anything else.

Your job in this stage is **game design only**. Do NOT write any HTML or JavaScript code. Do NOT specify pixel coordinates, sprite sizes, or pixels-per-second speeds. The next stage will translate your design into an implementation plan; the stage after that will write the code. Your job here is to describe what the game IS, not how it's built.

Title: {TITLE}
Concept: {CONCEPT}

Write your design to a file called `DESIGN.md` in the working directory. It MUST contain these sections (use these exact headers; the validator checks for them):

## Concept
One or two sentences in your own words. What does the player do, and why is it satisfying?

## Player
Describe what the player controls — the avatar, ship, cursor, paddle, whatever it is. Visually, what is it (one sentence)? List its verbs (move, jump, shoot, place, type). Keep it abstract — no coordinates, no speeds.

## Core loop
What happens every 1–3 seconds of normal play. Be specific about the moment-to-moment experience: what's the player reading, what are they choosing between, what makes them lean forward.

## Hazards / Obstacles
What stands in the player's way. Describe each kind by behavior and threat — "fast horizontal sweepers that telegraph their path", "stationary blocks that explode when shot". Concepts and behaviors, not numbers.

## Score
What discrete events increase the score. Examples: "survived a wave", "collected a pickup", "killed an enemy at long range". Avoid score = elapsed time as the only mechanic.

## Win and lose
When does the player win? When do they lose? What happens on screen the moment it ends.

## Feel
The vibe. Pace (frantic / steady / meditative). Aesthetic direction (neon / pastel / monochrome / retro CRT). Sound character (chiptune / arcade beeps / silent). One short paragraph.

## Why it's fun
One sentence. The single moment that would make a player smile, curse, or shout. What is this game's hook?

Keep DESIGN.md focused on player experience. The next phase (tasks) will translate this into an implementation plan with concrete numbers. After writing DESIGN.md, stop. Do not begin coding or task-listing.
