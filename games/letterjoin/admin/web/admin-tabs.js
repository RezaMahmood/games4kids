/** The admin page shows one section at a time. The URL hash names it, so reload and Back keep the place. */
export const TABS = ['activities', 'review', 'practice', 'progress', 'settings'];

/** @param {string} hash e.g. `#users`. Anything else is the first tab. */
export const tabFromHash = (hash) => TABS.find((tab) => hash === `#${tab}`) ?? TABS[0];
