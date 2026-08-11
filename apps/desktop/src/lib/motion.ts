import type { Transition, Variants } from "framer-motion";

/**
 * Shared motion tokens.
 *
 * Before this, motion was three hand-tuned components and nothing else, so the
 * app had no consistent feel. The values here are taken from the two places
 * that were already well made, rather than invented, so existing surfaces do
 * not change character.
 *
 * design.md constrains all of it: animate only `transform` and `opacity`, keep
 * it calm, and never let motion become decoration.
 */

/**
 * Seconds, framer-motion's unit.
 *
 * Anything the user did not explicitly ask for stays at `base` or below. This
 * is a tool people use for an hour at a time; a 400ms transition between two
 * tables is a tax they pay repeatedly.
 */
export const duration = {
  instant: 0.12,
  fast: 0.18,
  base: 0.24,
  slow: 0.34
} as const;

/** `out` is the easeOutQuint already used by the table's row expansion. */
export const ease = {
  out: [0.23, 1, 0.32, 1],
  in: [0.4, 0, 1, 1],
  standard: [0.4, 0, 0.2, 1]
} as const;

/** The house spring, taken verbatim from ConfirmCancelButton. */
export const smoothSpring: Transition = { type: "spring", bounce: 0, duration: 0.28 };

/** For things that travel a real distance and should settle: tracker cards. */
export const settleSpring: Transition = { type: "spring", bounce: 0.12, duration: 0.42 };

/**
 * Page content entrance.
 *
 * Enter only, deliberately. Every screen mounts its own WorkspaceFrame, so the
 * shell unmounts on navigation and there is nothing for an exit animation to
 * hold on to. Waiting for an exit would also double the perceived latency of
 * every click in the sidebar.
 */
export const pageEnter: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { duration: duration.fast, ease: ease.out } }
};

/** Toasts leave sideways so they never appear to fall through the stack. */
export const toastVariants: Variants = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: smoothSpring },
  exit: { opacity: 0, x: 16, scale: 0.98, transition: { duration: duration.fast, ease: ease.in } }
};

/** Direction-aware step change. `custom` carries 1 forward, -1 back. */
export const stepVariants: Variants = {
  enter: (direction: 1 | -1) => ({ opacity: 0, x: direction * 24 }),
  center: { opacity: 1, x: 0, transition: { duration: duration.base, ease: ease.out } },
  exit: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction * -24,
    transition: { duration: duration.fast, ease: ease.in }
  })
};

/** A value replacing another in place: counts, button labels, status text. */
export const swapVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: duration.instant, ease: ease.out } },
  exit: { opacity: 0, y: -6, transition: { duration: duration.instant, ease: ease.in } }
};

/**
 * Stagger for bounded collections only — tracker columns, settings sections.
 * Never for the jobs table: at 100 rows the ripple costs real frames and buys
 * nothing.
 */
export const staggerParent: Variants = {
  animate: { transition: { staggerChildren: 0.025, delayChildren: 0.02 } }
};

export const staggerChild: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: duration.fast, ease: ease.out } }
};
