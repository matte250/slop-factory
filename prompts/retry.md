Your previous {STAGE_NAME} attempt (attempt #{ATTEMPT_PREVIOUS}) failed validation. This is a fresh session — you have no memory of the previous attempt.

Game context:
Title: {TITLE}
Concept: {CONCEPT}

Validation errors from the previous attempt:
{ERRORS_LIST}

**Required output for this stage: {EXPECTED_OUTPUT}**

Re-read CONVENTIONS.md (and any other files in the working directory left by prior phases) before doing anything else. If a relevant output file already exists in the working directory, edit it in place to fix the validation errors above — do not start from scratch. If the required file does not exist yet, create it.

**You must use your write/edit tool to produce the required file(s) on disk.** The validator reads files from disk after your turn ends; if you only describe the answer in chat without calling a write/edit tool, validation will fail again. Do NOT reply with the content as inline chat text.

**Final check before you stop**: confirm you actually called your write/edit tool to produce the file(s) named in "Required output" above.
