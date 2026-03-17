import type { Page } from 'playwright';
import type { ComputerAction } from './types.js';

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
