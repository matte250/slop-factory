Read the file CONVENTIONS.md in your working directory carefully before doing anything else.

Then design the game described below. Do NOT write any HTML or JS code yet — only the design document.

Title: {TITLE}
Concept: {CONCEPT}

Write your design to a file called `DESIGN.md` in the working directory. It MUST contain these sections (use these exact headers; the validator checks for them):

## Player
- Starting position (e.g. canvas center, bottom edge)
- Every state variable (position, velocity, rotation, score, lives, …)
- For each control listed below, what state value it changes

## Hazards
- Each hazard type: appearance, where it spawns, when it spawns, how often, how it kills the player
- Concrete numbers (spawn interval seconds, speeds in px/sec, sizes)

## Score
- The discrete event(s) that increase score (e.g. 'survived obstacle', 'collected pickup')
- Win condition (if any) or 'survival only'

## Game-over and restart
- Exact end conditions
- What state must the restart code path reset (everything)

## Mechanic verification
- Quote the concept verbatim
- For the primary control, write: 'Press X → state change Y → next frame, collision/score check Z reads Y → outcome W'
- Be honest. If the concept says 'mirrored gaps', the design must have TWO gaps per obstacle. If it says 'horizontal stretch fits narrow gaps', gaps must be horizontal. Confirm in writing that the design realizes the concept.

## First 3 seconds (no input simulation)
- t=0.0s: player at (X, Y). Hazards on screen: [list with positions]
- t=1.0s: with NO INPUT, player at (X, Y). Hazards at [list]
- t=2.0s: same
- t=3.0s: same
- Verdict: PASS (player still alive at t=3.0s with no input) or FAIL (must redesign — push hazards further away or define a SAFE_RADIUS)

Keep DESIGN.md focused — the implement stage will read it and turn it into code, so be specific about numbers (px, seconds, sizes) but don't over-elaborate prose. After writing, do not start coding. The implement stage takes over from here.
