---
name: reviewing-tessera-prose
description: "Reviews new or changed Tessera prose against the house standard before landing; learns from the author's accepted revisions and rejected findings. Covers README, documentation, changelog, skills and UI copy. Findings are advisory."
---

# Reviewing Tessera prose

Use this skill before landing new or changed prose in `README.md`, `docs/`,
`CHANGELOG.md`, `.agents/skills/` or UI copy in `web/src/`.
Review the writing, not the author's identity or the tool that drafted it.

## Prepare

1. Run `ts-docs-lint` from the owned Tessera worktree.
   Fix every error before editorial review.
   If an error belongs to another owner, report its exact location and wait for
   that owner to fix it.
   Let Vale own mechanical checks; do not repeat its alerts as editorial findings.
2. Read [the house standard](../../../.vale/styles/Voice/Brief.md),
   [approved revisions](examples.yml) and [passages to keep](counterexamples.yml).
   Treat the standard as the authority and the examples as decisions in context.
   Do not turn a repeated pattern into a rule without the author's approval.
3. Read each changed paragraph with its heading and surrounding section.
   For a UI label, read the control, state and nearby explanation.
   Preserve source quotations, proper names, titles, identifiers and API values.

Do not open `holdout.yml` or `calibration.md` during an ordinary review.
Keep those files out of review prompts and automatic context collection.

## Review meaning and structure

Check what a pattern rule cannot decide:

- Check each claim against the cited evidence or described mechanism.
  Identify an unsupported claim rather than inventing support for it.
- Name an actor or referent when the surrounding section leaves it ambiguous.
- Check whether a description names the operation that produces derived data.
  For a state distinction, check whether the required visible state is explicit.
  Preserve the distinction while making its operation or requirement concrete.
- Compare neighboring paragraphs for repeated claims.
  Keep repetition that a separate instruction needs to stand alone.
- Check whether list items are parallel and useful to the reader.
  Do not invent a list or heading merely to make the page more regular.
- Find a result buried behind background the reader does not need first.
- Keep a qualification that limits a claim truthfully.
  State the cause of uncertainty when evidence permits it.

Do not flag a word, punctuation mark, contrast or three-item list merely because
it resembles a pattern in a rejected passage.
Keep technical terms, real state distinctions and authorization boundaries when
they carry information.
A shorter passage is not better if it loses a condition, actor or limitation.

## Report findings

Report each finding with all four parts:

1. Quote the exact passage and give its `file:line` location.
2. Cite the heading and exact clause from `Brief.md` that it breaks.
3. Explain the specific ambiguity, unsupported claim, repetition or structural
   problem in this context.
4. Propose the smallest revision that fixes that problem without changing the
   technical meaning.

Use evidence about the passage, not labels about who or what wrote it.
If a factual revision needs missing evidence, name that evidence instead of
supplying an unverified fact.
Mark every finding advisory; editorial findings never block landing.
An unresolved Vale error remains a separate mechanical check.
Report no finding when the context supports keeping the passage.

## Record the author's decision

Wait for the author to accept or reject a finding before recording it.
Do not treat the reviewer's preference as an approved decision.

- For an accepted revision, append an entry to `examples.yml` with a unique ID,
  source commit and path, exact before and after passages, the standard clause
  and one factual sentence explaining the change.
- For a rejected finding, append an entry to `counterexamples.yml` with a unique
  ID, source path and line, the exact passage, the proposed objection and why
  the author kept it.
- Record the decision's date and source when available.
  Committed prose revisions on `main` count as approved seed examples.
  Preserve historical text exactly apart from line wrapping.
- Check YAML syntax after an addition and run Vale on changed Markdown.
  Keep example passages in YAML, not in this file or the calibration record.

## Calibrate the review

Reserve about a quarter of approved pairs and two or three passages to keep in
`holdout.yml`.
Do not duplicate these cases in either training file.
Use calibration to measure the guidance, not to approve new editorial decisions.

1. Have a separate reader prepare a mixed, input-only packet from each case's
   `input` fields in `holdout.yml`.
   The packet must omit `answer`, case type, approved revisions and reasons.
   Include the source location and surrounding context.
   If the reviewer has seen the answers, use a fresh reviewer context.
2. Review every packet passage using this procedure, the standard and the two
   training files.
   Record findings or an explicit decision to keep each passage before opening
   any answers.
3. Reveal the answers only after the review is fixed.
   Count one detection when a finding identifies the defect that the approved
   revision fixes, even if its wording differs.
   Count a miss for every approved defect not identified.
   Count one false positive for each counterexample that received any finding.
   Count unrelated findings on defective cases separately.
4. Append the date, model, case IDs, detections and denominator, false positives
   and denominator, unrelated findings, and notes to `calibration.md`.
   State how the answers were withheld and retain the review decisions there
   without reproducing the passages.
5. Narrow guidance when correct technical distinctions attract findings.
   Widen it when a missed defect reveals a check absent from the procedure.
   Record the change and do not revise the first score after seeing answers.
   Replace exposed cases before claiming another blind calibration result.
