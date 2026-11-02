# House style

Write in American English, in the register of careful technical
correspondence: precise, measured and practical. The reader is a capable
colleague who wants the finding, the reason for it and what to do next.

## The standard

- Lead with the relevant finding. Background follows only where the reader
  needs it to act on the finding.
- Name the actor, the operation and the consequence. "The sweeper deletes the
  row; the next read misses the cache" rather than "this can lead to issues".
- Prefer concrete nouns and ordinary verbs. Say "use", "help" and "can"; name
  the component instead of "the system" or "the experience".
- Explain mechanisms and limitations instead of asserting quality. A property
  is shown by a number, a mechanism or a named behavior, never by an adjective
  such as "robust" or "seamless".
- Keep the qualifications that are true and drop the ones that are reflexive.
  A real uncertainty is stated with its cause.
- Say each thing once. End a section on its last concrete point, not on a
  summary of what it said.
- Distinguish facts from inferences, and say which is which.
- Quote sources exactly, including their spelling. Keep proper names, code
  identifiers, API values and titles of works as they are written.

## Profiles

The standard holds everywhere; the profiles change shape, not voice.

- **Technical documentation.** Complete sentences in paragraphs of at most
  about 150 words. Headings in sentence case. Lists only for items that are
  genuinely parallel. Code, paths and values in code spans.
- **UI text.** The shortest wording that names the action or the state:
  "Delete note", "Saved 2 minutes ago", "Needs a wider window". Sentence case;
  no closing period on a label; a full sentence where the text explains.
- **Essays and notes.** Longer paragraphs and an argument that builds, in the
  same plain register. A claim is attributed to the person who made it. Block
  quotations hold sources and are not edited.
- **Agent instructions and skills.** Imperative instructions, one per line or
  sentence, each naming the action and its condition.
- **Commit messages.** `type(scope): summary`, at most 72 characters, the
  summary starting with a lowercase past-tense verb and no closing period. An
  optional body of up to six `- ` bullets, each a complete past-tense sentence,
  wrapped at 72 columns with two-space continuation.

## What the rules check

`vale` checks these on every draft. The three spelling rules (Spelling,
SpellingCompound, American) are errors; the rest are warnings, because each
pattern also has legitimate uses, and an alert asks for a second look rather
than a rewrite. A project may hold more of them as errors.

- **Spelling:** American spelling against the SCOWL en_US dictionary:
  "color", "behavior", "organize", "center", "traveled", "catalog", "gray".
- **SpellingCompound:** the same check on each part of a hyphenated word
  ("color-coded", "catalog-style"), which Spelling skips.
- **American:** forms the dictionary accepts but the house does not use:
  "while" for "whilst", "analog" for "analogue", "oriented" for "orientated",
  "percent" for "per cent".
- **Filler:** quality claimed without content: load-bearing, comprehensive,
  robust, seamless, simply, delve, foster, empower, cutting-edge, paradigm
  shift, game changer, tapestry, realm, beacon, multifaceted, paramount,
  transformative, embark, ever-evolving.
- **Tics:** stock phrases of machine-written prose: crucial, pivotal,
  vibrant, nuanced, holistic, synergy, unleash, dive into, deep dive,
  testament, at the end of the day, groundbreaking, unwavering, garner,
  elucidate, a myriad of, plethora, boasts, valuable insights, whether you're
  a, look no further, rest assured, in essence.
- **Inflated:** one-word swaps, applied as the alert says: use for utilize
  and leverage, help for facilitate, simplify for streamline, speed up for
  supercharge, careful for meticulous, complex for intricate.
- **WeakVerbs:** decide for make a decision, can for is able to or has the
  ability to, to for in order to.
- **Hedging:** "it's worth noting", "it's important to note", "you may want
  to", "one could argue", "is likely because".
- **Puffery:** importance asserted: "stands as a testament", "marks a pivotal
  moment", "plays a vital role", "thrilled to announce".
- **Weasel:** "studies show", "experts agree", "widely regarded as" with no
  source named.
- **ThroatClearing:** "here's the thing", "let me be clear", "the
  uncomfortable truth is".
- **Signoff:** "I hope this helps", "let me know if", "feel free to", "in
  summary".
- **SuperficialAnalysis:** a trailing ", highlighting ...", ", underscoring
  ...", ", reflecting ..." that interprets instead of informing.
- **Recap:** a section's last paragraph opening "In conclusion",
  "Ultimately" or "Overall".
- **Lead:** the paragraph under a document's title opening "This document
  describes" or "In this guide"; open with what the reader needs to know.
- **ConsequenceParticiple:** a finished clause with ", leaving the ...",
  ", making it ...", ", ensuring the ..." tacked on; end the sentence and state
  the effect as its own claim.
- **ContrastiveFormulas:** "it's not just X; it's Y". Keep a contrast only
  when the reader would really make the mistake it rules out.
- **MicDrop:** "It matters." "This is key." as a sentence of its own.
- **PseudoCleft:** "What you get is ...", "All you need is ..."; put the
  claim first.
- **ShellNounCopula:** "The problem is that ...", "The difference is that
  ..."; start at the claim.
- **Dashes:** an em dash joining clauses; use a semicolon, comma, colon or
  period. En dashes in ranges are correct.
- **Concerns:** "concerns whether" and similar; say what the work claims,
  argues or asks.
- **DisclaimerTail:** ", not a proof", "not simply", "does not by itself"
  rebutting a reading nobody offered.
- **SemicolonDensity:** more than one semicolon in a paragraph.
- **ShellSubject:** "The question turns on ..."; start with the claim or the
  person making it.

The commit rules run only on commit messages (a `[COMMIT_EDITMSG]` section
with `View = Commit`), and all are errors:

- **CommitHeader:** `type(scope): summary` or `type: summary`, with a
  lowercase scope of at most two `/`-separated segments.
- **CommitHeaderLength:** a header of at most 72 characters.
- **CommitPastTense:** a summary opening with a lowercase past-tense verb. The
  check is lexical: an `-ed` word or a listed irregular form passes.
- **CommitHeaderPeriod:** no period at the end of the header.
- **CommitGap:** a blank line between the header and the body.
- **CommitBodyLength:** body lines of at most 72 columns.
- **CommitBodyStructure:** a body of `- ` bullets and two-space continuation
  lines only, without prose paragraphs.
- **CommitBulletCount:** at most six bullets.
- **CommitBulletPeriod:** each bullet ending with a period.

## What the rules cannot check

A pattern cannot tell whether a claim is supported, whether a referent is
clear, whether a list is parallel or whether a paragraph repeats the one
before it. Those are editorial judgments. When reviewing, report each one with
the exact passage, the part of this standard it breaks, the reason and the
smallest revision that fixes it. "This sounds machine-written" is not a
finding.
