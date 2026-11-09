import { expect, type Locator } from '@playwright/test';

/** What a hover style here changes: the text, the fill, the border, the shadow and the opacity. */
export const look = (button: Locator) =>
  button.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.color} on ${style.backgroundColor}, border ${style.borderTopColor}, shadow ${style.boxShadow}, opacity ${style.opacity}`;
  });

/**
 * A button's look with the pointer away from it, then with the pointer on it. Each is read once `:hover` matches as
 * expected, so a pointer that has not reached the button yet cannot pass for a hover style that never applies. A hover
 * style with a transition would also need a wait for the transition to end.
 */
export async function lookAwayAndOn(button: Locator): Promise<{ away: string; on: string }> {
  const underPointer = () => button.evaluate((element) => element.matches(':hover'));
  await expect.poll(underPointer).toBe(false);
  const away = await look(button);
  await button.hover({ force: true });
  await expect.poll(underPointer).toBe(true);
  return { away, on: await look(button) };
}
