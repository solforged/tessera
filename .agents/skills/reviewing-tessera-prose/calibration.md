# Editorial calibration record

Append a dated entry after each calibration.
Keep passages and answer keys in `holdout.yml`.

## 2026-11-02

Model: `openai-codex/gpt-6.1-sol`.

Result: 1 of 4 approved defects detected (25 percent); 0 of 3 counterexamples
received a finding (0 percent false positives).
There were no unrelated findings on the approved revision cases.

### Method

This was a single-context review, not an independent second reviewer.
A script selected four historical revision candidates and three current Vale
warning passages.
It printed only the old passages, their source locations and surrounding
sections before the reviewer fixed all seven decisions.
No approved revisions or reasons for these cases were read before that point.
The reviewer knew how the candidates were selected, so this was blind to the
answers, not to the selection process.

The fixed review was recorded before answer reveal with this SHA-256 value:

```text
ee00346566353dcaab69da5bc4669234b7e08149461fc0aabcf68aefcc93d142
```

### Decisions and scores

| Case | Fixed review | Score after answer reveal |
| --- | --- | --- |
| `holdout-01` | Flagged an ambiguous date referent under the actor, operation and consequence clause. | Detected: the approved revision names the saved expression and its resolution on each read. |
| `holdout-02` | Kept the picker operations and their conditions. | Correctly kept. |
| `holdout-03` | Kept the storage list and the passage distinction. | Missed the more concrete statement of what passages retain. |
| `holdout-04` | Kept the query grammar and resolution conditions. | Correctly kept. |
| `holdout-05` | Kept the recipe explanation because the surrounding section explained the criteria. | Missed the direct statement that the recipe derives suggestions. |
| `holdout-06` | Kept the completion, fallback and dismissal conditions. | Correctly kept. |
| `holdout-07` | Kept the distinction between a failed request and a missing card. | Missed the direct requirement about the displayed error state. |

The one finding concerned historical `docs/domain-model.md:298` at the input
revision recorded in `holdout.yml`.
It was advisory and cited **The standard**, "Name the actor, the operation and
the consequence."
Its reason was ambiguity between the day of review and the date obtained by
resolving a relative filter.
The proposed minimum change named the resolved value explicitly.
The approved revision avoided the same ambiguity by stating the resolution
operation, so it counted as a detection despite different wording.

### Guidance change and limits

The review avoided false positives but missed clearer positive operations and
an explicit state requirement.
Added guidance to check the operation producing derived data and the required
visible state, even when a technical contrast is justified.
Kept the instruction to preserve real distinctions; a contrast alone remains
insufficient grounds for a finding.
The score above is from the original guidance and was not revised afterward.

All four approved revisions come from one documentation commit.
Three counterexamples concern dense technical instructions.
These cases do not establish accuracy on unsupported claims, buried findings,
UI copy or repetition across sections.
All seven answers are now exposed to this reviewer.
Replace them before another blind calibration; an immediate repeat would
measure recall rather than editorial judgment.
