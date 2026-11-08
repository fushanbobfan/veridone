import { expect, type Locator } from '@playwright/test';

/** What a hover style here changes: the text, the fill, the border, the shadow and the opacity. */
export const look = (button: Locator) =>
  button.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.color} on ${style.backgroundColor}, border ${style.borderTopColor}, shadow ${style.boxShadow}, opacity ${style.opacity}`;
  });

/**
 * A button's look with the pointer away from it, then with the pointer on it. Each is read once the browser places the
 * pointer there, so a hover style that has not applied yet cannot pass for one that never applies.
 */
export async function lookAwayAndOn(button: Locator): Promise<{ away: string; on: string }> {
  const underPointer = () => button.evaluate((element) => element.matches(':hover'));
  await expect.poll(underPointer).toBe(false);
  const away = await look(button);
  await button.hover({ force: true });
  await expect.poll(underPointer).toBe(true);
  return { away, on: await look(button) };
}
