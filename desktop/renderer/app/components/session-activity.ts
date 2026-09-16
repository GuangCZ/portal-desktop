// The sidebar's activity light, as one rule; ported from BeingDesktop 0.8.26
// renderer/sidebar.js lines 62-67 on 2026-09-16 (IM).
//
//   const activity = window.beingOrchestration?.hasActiveWorkers(item.id)
//     ? 'talking'
//     : state.chatSessionActivity?.[item.id];
//
// A RUNNING WORKER OUTRANKS EVERYTHING, and it shows as「进行中」rather than as a
// state of its own. That is the whole rule and it is easy to get backwards: a
// session whose Being is idle while a CLI is still working is not idle, and a
// session that is both streaming a reply and running a worker is one light, not
// two. The comment above line 62 in 0.8.26 says why the worker half is read from
// the same snapshot the group below the row counts: the light and the count must
// never disagree.
//
// It lives here, as a function of plain values, because vitest has no DOM in this
// repository — `sidebar.tsx` can be rendered by nobody, so a rule embedded in its
// JSX is a rule nothing checks (tests/sidebar-activity.test.ts).

/** The three states of the light. The empty string is「no light」— 0.8.26 renders
 * the same element with `inactive` and no label. */
export type SessionActivity = 'talking' | 'waiting' | '';

/** The two flags the conversation layer publishes per session. */
export interface SessionActivityInput {
  /** A reply is streaming in right now. */
  busy?: boolean;
  /** A request is out and nothing has come back yet. */
  inFlight?: boolean;
}

export function sessionActivity(session: SessionActivityInput, hasActiveWorkers = false): SessionActivity {
  if (hasActiveWorkers) return 'talking';
  if (session.busy) return 'talking';
  return session.inFlight ? 'waiting' : '';
}

/** The visible name of a state, used for the row's `aria-label` and its tooltip.
 * Empty for an idle session: 0.8.26 appends nothing rather than「空闲」. */
export function sessionActivityLabel(activity: SessionActivity): string {
  if (activity === 'talking') return '进行中';
  return activity === 'waiting' ? '等待回复' : '';
}

/** The class the light carries. 0.8.26: `session-activity-light ${…'inactive'}`. */
export function sessionActivityClass(activity: SessionActivity): string {
  return `session-activity-light ${activity || 'inactive'}`;
}
