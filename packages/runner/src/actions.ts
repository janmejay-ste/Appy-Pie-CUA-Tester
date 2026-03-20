import type { Page } from 'playwright';
import type { ComputerAction, DOMElement, ModelAction, ActionResult } from './types.js';

function normalizePlaywrightKey(key: string): string {
  const lookup = key.trim().toUpperCase().replace(/_/g, '');
  switch (lookup) {
    case 'CTRL': case 'CONTROL': return 'Control';
    case 'CMD': case 'COMMAND': case 'META': return 'Meta';
    case 'ALT': case 'OPTION': return 'Alt';
    case 'SHIFT': return 'Shift';
    case 'ENTER': case 'RETURN': return 'Enter';
    case 'ESC': case 'ESCAPE': return 'Escape';
    case 'SPACE': return ' ';
    case 'TAB': return 'Tab';
    case 'BACKSPACE': return 'Backspace';
    case 'DELETE': case 'DEL': return 'Delete';
    case 'UP': case 'ARROWUP': return 'ArrowUp';
    case 'DOWN': case 'ARROWDOWN': return 'ArrowDown';
    case 'LEFT': case 'ARROWLEFT': return 'ArrowLeft';
    case 'RIGHT': case 'ARROWRIGHT': return 'ArrowRight';
    case 'PGUP': case 'PAGEUP': return 'PageUp';
    case 'PGDN': case 'PAGEDOWN': return 'PageDown';
    case 'HOME': return 'Home';
    case 'END': return 'End';
    case 'INSERT': return 'Insert';
    default: return key.trim();
  }
}

export async function executeAction(page: Page, action: ComputerAction): Promise<void> {
  const x = Number(action.x ?? 0);
  const y = Number(action.y ?? 0);
  const buttonValue = action.button;
  const button: 'left' | 'right' | 'middle' =
    buttonValue === 'right' || buttonValue === 2 || buttonValue === 3
      ? 'right'
      : buttonValue === 'middle' || buttonValue === 'wheel'
        ? 'middle'
        : 'left';

  try {
    switch (action.type) {
      case 'click':
        await page.mouse.click(x, y, { button });
        break;

      case 'double_click':
        await page.mouse.dblclick(x, y, { button });
        break;

      case 'type':
        await page.keyboard.type(String(action.text ?? ''));
        break;

      case 'keypress': {
        const keys = Array.isArray(action.keys)
          ? (action.keys as string[]).map(normalizePlaywrightKey).filter(Boolean)
          : [normalizePlaywrightKey(String(action.key ?? ''))].filter(Boolean);
        if (keys.length > 0) await page.keyboard.press(keys.join('+'));
        break;
      }

      case 'scroll': {
        const deltaX = Number(action.delta_x ?? action.deltaX ?? action.scroll_x ?? action.scrollX ?? 0);
        const deltaY = Number(action.delta_y ?? action.deltaY ?? action.scroll_y ?? action.scrollY ?? 0);
        if (Number.isFinite(x) && Number.isFinite(y)) await page.mouse.move(x, y);
        await page.mouse.wheel(deltaX, deltaY);
        break;
      }

      case 'move':
        await page.mouse.move(x, y);
        break;

      case 'drag': {
        const path = Array.isArray(action.path) ? (action.path as Array<{ x: number; y: number }>) : [];
        if (path.length >= 2) {
          await page.mouse.move(Number(path[0].x), Number(path[0].y));
          await page.mouse.down();
          for (const pt of path.slice(1)) await page.mouse.move(Number(pt.x), Number(pt.y));
          await page.mouse.up();
        } else if (action.startX != null && action.startY != null && action.endX != null && action.endY != null) {
          await page.mouse.move(Number(action.startX), Number(action.startY));
          await page.mouse.down();
          await page.mouse.move(Number(action.endX), Number(action.endY));
          await page.mouse.up();
        }
        break;
      }

      case 'wait': {
        const ms = Number(action.ms ?? action.duration_ms ?? 1000);
        await new Promise(r => setTimeout(r, ms));
        break;
      }

      case 'screenshot':
        // No-op — handled by the CUA loop
        break;

      default:
        console.warn(`[actions] Unknown action type: ${action.type}`);
    }
  } catch (err) {
    console.error(`[actions] Error executing ${action.type}:`, err);
  }
}

// ── DOM-First: Execute action by element ID with 4-layer fallback ──

async function clickElement(page: Page, el: DOMElement): Promise<void> {
  // Layer 1: CSS selector
  try {
    const loc = page.locator(el.selector).first();
    if (await loc.isVisible({ timeout: 2000 })) {
      await loc.click({ timeout: 5000 });
      return;
    }
  } catch { /* fallback */ }

  // Layer 2: Text match
  if (el.text) {
    try {
      const loc = el.role
        ? page.getByRole(el.role as any, { name: el.text }).first()
        : page.getByText(el.text, { exact: false }).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 5000 });
        return;
      }
    } catch { /* fallback */ }
  }

  // Layer 3: Role-based query
  if (el.role) {
    try {
      const loc = page.locator(`[role="${el.role}"]`).first();
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.click({ timeout: 5000 });
        return;
      }
    } catch { /* fallback */ }
  }

  // Layer 4: Coordinate click
  const cx = el.rect.x + el.rect.width / 2;
  const cy = el.rect.y + el.rect.height / 2;
  await page.mouse.click(cx, cy);
}

async function focusAndType(page: Page, el: DOMElement, text: string): Promise<void> {
  // Try selector first
  try {
    const loc = page.locator(el.selector).first();
    if (await loc.isVisible({ timeout: 2000 })) {
      await loc.click({ timeout: 3000 });
      await page.keyboard.press('Control+a');
      await page.keyboard.type(text);
      return;
    }
  } catch { /* fallback */ }

  // Coordinate fallback
  const cx = el.rect.x + el.rect.width / 2;
  const cy = el.rect.y + el.rect.height / 2;
  await page.mouse.click(cx, cy);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function selectOption(page: Page, el: DOMElement, value: string): Promise<void> {
  try {
    const loc = page.locator(el.selector).first();
    await loc.selectOption({ label: value });
    return;
  } catch { /* fallback — try by value */ }

  try {
    const loc = page.locator(el.selector).first();
    await loc.selectOption(value);
    return;
  } catch { /* fallback — click and choose */ }

  // Click the select then look for option text
  await clickElement(page, el);
  await new Promise(r => setTimeout(r, 300));
  try {
    await page.getByText(value, { exact: false }).first().click({ timeout: 3000 });
  } catch {
    throw new Error(`Could not select option "${value}" in ${el.selector}`);
  }
}

export async function executeModelAction(
  page: Page,
  action: ModelAction,
  elementMap: Map<string, DOMElement>,
): Promise<ActionResult> {
  // Validate target exists
  if (action.target && !elementMap.has(action.target) && action.action !== 'scroll' && action.action !== 'wait' && action.action !== 'navigate') {
    return { success: false, error: `Element ${action.target} not found in DOM`, description: `${action.action}: element ${action.target} not found` };
  }

  const el = action.target ? elementMap.get(action.target) : undefined;

  try {
    switch (action.action) {
      case 'click': {
        if (!el) return { success: false, error: 'No target element for click', description: 'click: no target' };
        if (el.disabled) return { success: false, error: `Element ${action.target} is disabled`, description: `click ${action.target}: disabled` };
        await clickElement(page, el);
        return { success: true, description: `clicked ${action.target} "${el.text || el.tag}"` };
      }

      case 'type': {
        if (!el) return { success: false, error: 'No target element for type', description: 'type: no target' };
        const text = action.value ?? '';
        await focusAndType(page, el, text);
        return { success: true, description: `typed "${text.slice(0, 30)}" into ${action.target}` };
      }

      case 'select': {
        if (!el) return { success: false, error: 'No target element for select', description: 'select: no target' };
        const value = action.value ?? '';
        await selectOption(page, el, value);
        return { success: true, description: `selected "${value}" in ${action.target}` };
      }

      case 'scroll': {
        if (el) {
          // Scroll element into view
          try {
            await page.locator(el.selector).first().scrollIntoViewIfNeeded({ timeout: 3000 });
          } catch {
            await page.mouse.click(el.rect.x + el.rect.width / 2, el.rect.y + el.rect.height / 2);
            await page.mouse.wheel(0, 300);
          }
          return { success: true, description: `scrolled to ${action.target}` };
        }
        // Generic scroll
        const direction = action.value?.toLowerCase() === 'up' ? -400 : 400;
        await page.mouse.wheel(0, direction);
        return { success: true, description: `scrolled ${direction > 0 ? 'down' : 'up'}` };
      }

      case 'wait': {
        const ms = parseInt(action.value || '1000') || 1000;
        await new Promise(r => setTimeout(r, Math.min(ms, 5000)));
        return { success: true, description: `waited ${ms}ms` };
      }

      case 'navigate': {
        const url = action.value;
        if (!url) return { success: false, error: 'No URL for navigate', description: 'navigate: no URL' };
        await page.goto(url, { waitUntil: 'load', timeout: 15000 });
        return { success: true, description: `navigated to ${url.slice(0, 60)}` };
      }

      case 'keypress': {
        const key = normalizePlaywrightKey(action.value || 'Enter');
        await page.keyboard.press(key);
        return { success: true, description: `pressed ${key}` };
      }

      case 'done':
        return { success: true, description: 'test completed' };

      default:
        return { success: false, error: `Unknown action: ${action.action}`, description: `unknown: ${action.action}` };
    }
  } catch (err) {
    const msg = (err as Error).message;
    return { success: false, error: msg, description: `${action.action} failed: ${msg.slice(0, 80)}` };
  }
}
