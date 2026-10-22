/**
 * Asks before a tap ends or abandons an attempt. The answer sits in the middle of the screen,
 * so a palm resting on the page cannot press the button and then answer too.
 */

const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('confirm'));

/** @typedef {{ title: string, text: string, yes: string, no: string }} Question */

/** @type {Record<string, Question>} */
export const QUESTIONS = {
  finishTrace: { title: 'Finished tracing?', text: 'Your score is worked out when you finish.', yes: "Yes, I've finished", no: 'Keep tracing' },
  sendCopy: { title: 'Finished writing?', text: 'Your writing is sent for review.', yes: 'Yes, send it', no: 'Keep writing' },
  finishWrite: { title: 'Finished writing?', text: 'We read your writing and give you a score.', yes: "Yes, I've finished", no: 'Keep writing' },
  leave: { title: 'Leave this activity?', text: 'What you have done so far is not saved.', yes: 'Yes, leave', no: 'Keep going' },
};

/**
 * Resolves true only when the child presses yes. Escape, the no button and {@link dismiss} resolve false.
 * @param {Question} question
 * @returns {Promise<boolean>}
 */
export function ask({ title, text, yes, no }) {
  dismiss();
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-yes').textContent = yes;
  document.getElementById('confirm-no').textContent = no;
  dialog.returnValue = '';
  dialog.showModal();
  document.getElementById('confirm-no').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
  });
}

/** Closes an open question as a no, for when the attempt ended some other way, such as the timer. */
export function dismiss() {
  if (dialog.open) dialog.close();
}
