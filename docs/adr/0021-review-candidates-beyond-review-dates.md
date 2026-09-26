# ADR 0021: Review Candidates Beyond Review Dates

Date: 2026-07-01
Status: Accepted

## Context

The Review workflow was strictly review-date-driven: items surface in Daily Review and the Focus review-due section only when `reviewAt` is due. Issue #804 (consolidating #685, #317, #724) asked whether Review should also surface candidates for people who never set review dates.

Signals from users split two ways:

- Power users drive everything through `someday + review date` and treat due dates as hard commitments only (#724). For them the date-driven model works and extra items are noise.
- Users who do not set review dates found the review-date surfaces empty and reviewed ad-hoc from Projects/Next/Someday (#317, #685).

Stale-item detection already existed in core (`getStaleItems`, 14-day threshold over next/waiting tasks and active projects) but was only consumed by the AI review step, so users without an AI provider never saw it. Separately, #317 deferred an "advance review date" action because it needed an interval decision.

## Decision

1. **Weekly Review gets a "Stale items" step; Daily Review stays date-driven.** The weekly wizard shows the plain `getStaleItems` list to everyone (no AI required). When AI review is enabled, the AI analysis tools appear inside the same step instead of a separate AI-only step — one surface, no duplication. The step auto-skips when there are no stale items, so date-driven users see nothing new unless items actually go stale.
2. **"Review in 1 week" joins "Mark reviewed" as a post-review action.** The interval is a fixed 7 days from now (`getAdvancedReviewDate` in core), matching the weekly review cadence. No per-task interval field and no settings knob: per-task intervals are recurrence-style complexity for a niche need, and editing `reviewAt` directly remains available for custom cadences. The new date preserves the original value's date-only vs datetime shape.
3. **Candidate logic stays a core predicate.** Both platforms consume `getStaleItems` and `getAdvancedReviewDate` from `@mindwtr/core`; no per-platform copies.

## Consequences

- Users without review dates get one weekly surface listing neglected items; users with disciplined review dates see no change unless items stall for 14+ days.
- No new task fields, no new settings, no sync schema change (`reviewAt` writes go through the existing update path).
- The 14-day stale threshold stays a core default rather than a setting; revisit only if real usage shows the fixed threshold failing.

## Follow-up: distinguish reminders from the overview (2026-09-24)

Discussion #1281 showed that the Review overview looked like a queue of outstanding
review reminders. Marking an item reviewed cleared its `reviewAt`, but the item
remained in the overview, so the action appeared to do nothing.

The Review page offers **Due for review** and **All open tasks**. The due queue
contains live actionable tasks whose explicit review date has arrived; tasks with
no review date or a future review date are not outstanding reminders. Mark reviewed
clears the review date and removes the item from this queue. Review in 1 week keeps
the existing seven-day behavior. The scope is local UI state, not a synced setting.

The full overview and Weekly Review retain waiting, someday, and stale candidates.
Finishing a daily or weekly guide does not acknowledge individual review reminders.
Completed work remains accessible for retrospection through the existing completed
task surface. This adds no task status, review-history field, or separate planning
module.
