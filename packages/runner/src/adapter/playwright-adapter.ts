import type { Page, BrowserContext } from 'playwright';
import type { ExecutionAdapter, BrowserState, ActionResult, IndexedElement } from './types.js';
import crypto from 'crypto';

// ── Config ──────────────────────────────────────────────────────
const BASE_MAX_ELEMENTS = 30;
const ACTION_TIMEOUT = 5000;

// ── Stable element ID generator ─────────────────────────────────
// Position is NOT included — only stable attributes that survive scroll/reflow
function generateElementId(el: { tag: string; text: string; attributes: Record<string, string> }): string {
  const raw = [
    el.tag,
    el.attributes['id'] || '',
    el.attributes['name'] || '',
    el.attributes['data-testid'] || '',
    el.attributes['aria-label'] || '',
    el.text.slice(0, 20),
  ].join('|');
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 8);
}

// ── DOM extraction is inlined in PlaywrightAdapter.getState() ──
// Passed as a proper function to page.evaluate() to avoid template literal issues

// ── PlaywrightAdapter ───────────────────────────────────────────
// Raw execution only. NO fallback logic. That's in Action Engine.

export class PlaywrightAdapter implements ExecutionAdapter {
  private page: Page;
  private activePage: Page;
  private context: BrowserContext;

  constructor(page: Page) {
    this.page = page;
    this.activePage = page;
    this.context = page.context();

    this.context.on('page', (newPage) => {
      console.log(`[adapter] New tab: ${newPage.url()}`);
      this.activePage = newPage;
      newPage.on('close', () => { this.activePage = this.page; });
    });
  }

  async getState(): Promise<BrowserState> {
    const url = this.activePage.url();
    const title = await this.activePage.title().catch(() => '');

    // Dynamic cap: larger viewport = more elements
    let viewportHeight = 900;
    try {
      const vp = this.activePage.viewportSize();
      if (vp) viewportHeight = vp.height;
    } catch {}
    const maxElements = viewportHeight < 800 ? BASE_MAX_ELEMENTS : Math.min(70, BASE_MAX_ELEMENTS + 35);

    // AUTO-CLICK CONTINUE on account steps — prevents OAuth redirect entirely
    // If URL contains /account/ on customeditor, click Continue immediately — skip account check
    const currentUrl = this.activePage.url();
    let autoClickedContinue = false;

    if (currentUrl.includes('/customeditor/')) {
      // Auto-click Continue on account steps — checks if there's a linked account + active Continue
      autoClickedContinue = (await this.activePage.evaluate(`(() => {
        // Check if there's a linked account visible (green checkmark + account email/name)
        var hasLinkedAccount = false;
        document.querySelectorAll('.fa-check-circle, [class*="done-app"], [class*="trgrevent-icon"]').forEach(function(el) {
          hasLinkedAccount = true;
        });
        // Also check for "Connect Account" section with a dropdown/selection
        document.querySelectorAll('span, div, h5').forEach(function(el) {
          var text = (el.textContent || '').trim().toLowerCase();
          if (text.includes('account:') || text.includes('connected') ||
              (text.includes('@') && text.includes('.'))) {
            hasLinkedAccount = true;
          }
        });
        if (!hasLinkedAccount) return false;

        // Find Continue button — by data-track first, then by text
        var btn = document.querySelector('[data-track="continue with account"]');
        if (!btn) btn = document.querySelector('[data-track*="continue"]:not([data-track*="event"])');
        if (!btn) {
          var buttons = document.querySelectorAll('.continue button, .continue a');
          for (var i = 0; i < buttons.length; i++) {
            var text = (buttons[i].textContent || '').trim().toLowerCase();
            if (text === 'continue' || text === 'continue & run test') { btn = buttons[i]; break; }
          }
        }
        // Only click if active
        if (btn && !btn.disabled && btn.offsetParent !== null &&
            !btn.classList.contains('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click();
          return true;
        }
        return false;
      })()`).catch(() => false)) as boolean;
    }

    if (autoClickedContinue) {
      console.log('[adapter] Auto-clicked Continue on account step (/account/ URL) — skipping account setup');
      // Wait for page to process the click
      await new Promise(r => setTimeout(r, 2000));
    }

    // AUTO-FILL: On action options/config page, proactively fill empty "+ Add or Select" fields
    if (currentUrl.includes('/customeditor/') && currentUrl.includes('/options/')) {
      try {
        const fillResult = await this.autoFillActionFields();
        if (fillResult.filled > 0) {
          console.log(`[adapter] Auto-filled ${fillResult.filled} fields: ${fillResult.fields.join(', ')}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch {}
    }

    // Remove trap elements + auto-recover from expanded layout
    await this.activePage.evaluate(`(() => {
      // AUTO-RECOVER: If expand was clicked, the Minimize button will be visible — click it to restore layout
      var minimizeBtn = document.querySelector('[data-tooltip="Minimize"]');
      if (!minimizeBtn) {
        // Also check by SVG pattern: polyline points="4 14 10 14 10 20" is the minimize icon
        document.querySelectorAll('button.rotate-180, button svg polyline').forEach(function(poly) {
          if ((poly.getAttribute('points') || '').includes('4 14 10 14 10 20')) {
            minimizeBtn = poly.closest('button');
          }
        });
      }
      if (!minimizeBtn) {
        // Check for expanded panel state: panel takes >90% of viewport width
        var panel = document.querySelector('.halfcolume, [class*="half-column"], [class*="sidebar-content"], [class*="trigger-details"], [class*="action-details"]');
        if (panel) {
          var panelRect = panel.getBoundingClientRect();
          if (panelRect.width > window.innerWidth * 0.85) {
            // Panel is expanded — find any collapse/minimize button inside it
            var collapseBtn = panel.querySelector('[data-tooltip="Minimize"], [data-tooltip="Collapse"], button.rotate-180');
            if (!collapseBtn) {
              // Try the panel toggle icon at top-right of the panel
              collapseBtn = panel.querySelector('button:last-child') || panel.querySelector('svg').closest('button');
            }
            if (collapseBtn) minimizeBtn = collapseBtn;
          }
        }
      }
      if (minimizeBtn) {
        minimizeBtn.click();
        console.log('[dom-cleanup] Auto-clicked Minimize to restore layout');
      }
      // Also remove ALL expand buttons more aggressively
      document.querySelectorAll('[data-tooltip="Expand"], [data-tooltip="Full Screen"], [data-tooltip="Maximize"], [data-tooltip="Full screen"]').forEach(function(el) { el.remove(); });
      document.querySelectorAll('button').forEach(function(el) {
        var tooltip = (el.getAttribute('data-tooltip') || el.getAttribute('title') || el.getAttribute('aria-label') || '').toLowerCase();
        if (tooltip.includes('expand') || tooltip.includes('full screen') || tooltip.includes('maximize') || tooltip.includes('fullscreen')) el.remove();
        var svg = el.querySelector('svg polyline[points*="15 3 21 3"]');
        if (svg) el.remove();
        // Also catch custom-options-tooltip class
        if (el.classList.contains('custom-options-tooltip')) el.remove();
      });

      // Remove forgot password, social login links
      document.querySelectorAll('a').forEach(function(el) {
        var href = (el.getAttribute('href') || '').toLowerCase();
        var text = (el.textContent || '').trim().toLowerCase();
        if (href.includes('forgot') || href.includes('forgotpassword') ||
            text.includes('forgot password') || text.includes('forgot your password') ||
            text === 'forgot' ||
            href.includes('signup') || href.includes('register') ||
            text.includes('sign in with google') || text.includes('sign in with apple') ||
            text.includes('sign in with facebook')) {
          el.remove();
        }
      });
      // Remove expand/fullscreen buttons — they break the layout
      document.querySelectorAll('[data-tooltip="Expand"], [data-tooltip="Full Screen"], [data-tooltip="Maximize"]').forEach(function(el) {
        el.remove();
      });
      // Remove by SVG pattern: polyline points="15 3 21 3" is the expand icon
      document.querySelectorAll('button').forEach(function(el) {
        var svg = el.querySelector('svg polyline[points*="15 3 21 3"]');
        if (svg) el.remove();
      });

      // Remove Guide button (question circle icon) — model must never click it
      document.querySelectorAll('#step_guide_Btn, .step_guide, [tooltip="Guide"], button[id*="guide"]').forEach(function(el) {
        el.remove();
      });
      // Also remove by icon class pattern
      document.querySelectorAll('button .fa-question-circle').forEach(function(icon) {
        var btn = icon.closest('button');
        if (btn) btn.remove();
      });

      // Remove "Add an Account" / "Change" buttons — model should only click Continue
      // Find Continue button by ANY method
      var continueBtn = null;
      document.querySelectorAll('button, a, [role="button"]').forEach(function(el) {
        var text = (el.textContent || '').trim().toLowerCase();
        var track = (el.getAttribute('data-track') || '').toLowerCase();
        if (text === 'continue' || text === 'continue & run test' || text === 'skip run test' ||
            track.includes('continue')) {
          continueBtn = el;
        }
      });
      // Also check .continue class container
      if (!continueBtn) continueBtn = document.querySelector('.continue button, [data-track*="continue"]');

      if (continueBtn) {
        // Remove ALL account-related buttons/links that could trigger OAuth
        document.querySelectorAll('button, a, [role="button"]').forEach(function(el) {
          if (el === continueBtn) return; // keep Continue
          var text = (el.textContent || '').trim().toLowerCase();
          var href = (el.getAttribute('href') || '').toLowerCase();
          var track = (el.getAttribute('data-track') || '').toLowerCase();
          if (text === 'change' || text === 'add an account' || text === 'add account' ||
              text === 'connect account' || text === 'connect an account' || text === 'reconnect' ||
              text.includes('add an account') || text.includes('add account') ||
              href.includes('/app/auth/') || href.includes('connectauth') ||
              track.includes('add account') || track.includes('change account') ||
              track.includes('connect account')) {
            el.remove();
          }
        });
        // Remove "Request a demo" links
        document.querySelectorAll('a').forEach(function(el) {
          if ((el.textContent || '').trim().toLowerCase().includes('request a demo')) el.remove();
        });
      }
    })()`).catch(() => {});

    let rawData: any;
    try {
      // IMPORTANT: Use string-based evaluate to avoid tsx/esbuild __name injection
      // TypeScript compilers add __name helpers to functions, which don't exist in browser context
      rawData = await this.activePage.evaluate(`(() => {
        var MAX = ${maxElements};
        var seen = new Set();
        var results = [];
        var selectors = [
          'input:not([type="hidden"])', 'textarea', 'select', 'button', 'a[href]',
          '[role="button"]', '[role="tab"]', '[role="link"]', '[contenteditable]',
          '[onclick]', '[data-testid]',
          '[role="option"]', '[role="listbox"] li', '[role="menuitem"]', '[role="menuitemradio"]',
          '[role="combobox"]', '[role="treeitem"]',
          '.dropdown-item', '.dropdown-menu li', '.dropdown-menu a',
          '[class*="option"]', '[class*="select-option"]', '[class*="menu-item"]',
          '[class*="suggestion"]', '[class*="search-result"]', '[class*="list-item"]',
          '[class*="popover"] li', '[class*="popover"] a', '[class*="popover"] button',
          '[class*="panel"] li', '[class*="panel"] button',
          'ul[class*="dropdown"] li', 'div[class*="dropdown"] div[class*="item"]',
          'li[class*="result"]', 'div[class*="result"]',
          '[class*="app-card"]', '[class*="app-item"]', '[class*="appCard"]',
          '[class*="card"][class*="click"]', '[class*="integration"]',
          'div[style*="cursor: pointer"]', 'div[style*="cursor:pointer"]',
          '[class*="trigger"] [class*="item"]', '[class*="action"] [class*="item"]',
          'a[data-track]', '.landing-apps a', '.listingAppsList a',
          '.listingAppsList li', '[class*="listing"] li', '[class*="listing"] a',
          '[class*="event"] li', '[class*="event"] a',
          '[class*="scrollheight"] li', '[class*="scrollheight"] a',
          '.cdk-overlay-pane li', '.cdk-overlay-pane a', '.cdk-overlay-pane button',
          '.mat-option', '.mat-menu-item',
          'label.form-check-label', '.form-checkbox label',
          '[class*="form-checkbox"] label', '[data-track="select trigger event"]',
          '[data-track="select action event"]',
          '.menu_icon-box', '.menu_icon', '.selected_value',
          '.menu_dropdown li', '.menu_dropdown a', '.menu_dropdown .formcontrol',
          '.menu_dropdown div[class*="option"]',
          '[data-track="continue"]', '[data-track="continue with event"]',
          '.continue button', '.continue a',
          '.change-btn', '.advanced-mapping-btn'
        ];
        var candidates = [];
        for (var si = 0; si < selectors.length; si++) {
          try {
            var els = document.querySelectorAll(selectors[si]);
            for (var ei = 0; ei < els.length; ei++) {
              var el = els[ei];
              if (seen.has(el)) continue;
              seen.add(el);
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (rect.top > window.innerHeight + 300) continue;
              var style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;
              var tag = el.tagName.toLowerCase();
              var sc = (tag === 'input' || tag === 'textarea' || tag === 'select') ? 30 : (tag === 'button' ? 20 : (tag === 'a' ? 10 : 5));
              candidates.push({ el: el, score: sc, top: rect.top });
            }
          } catch(e) {}
        }
        // Find all <a> tags without href that have meaningful text (Angular app items)
        document.querySelectorAll('a:not([href])').forEach(function(el) {
          if (seen.has(el)) return;
          var rect = el.getBoundingClientRect();
          if (rect.width < 30 || rect.height < 20) return;
          if (rect.top > window.innerHeight + 300 || rect.bottom < 0) return;
          var text = (el.textContent || '').trim();
          if (text.length < 2 || text.length > 100) return;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          seen.add(el);
          candidates.push({ el: el, score: 12, top: rect.top });
        });

        // Find clickable divs with images (app selection cards in connect editor)
        document.querySelectorAll('div > img, div > svg').forEach(function(child) {
          var parent = child.parentElement;
          if (!parent || seen.has(parent) || parent.tagName !== 'DIV') return;
          var rect = parent.getBoundingClientRect();
          if (rect.width < 40 || rect.width > 250 || rect.height < 40 || rect.height > 250) return;
          if (rect.top > window.innerHeight + 300) return;
          var style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          // Check if it looks like a card (has text + image, reasonable size)
          var text = (parent.textContent || '').trim();
          if (text.length > 1 && text.length < 100) {
            seen.add(parent);
            candidates.push({ el: parent, score: 15, top: rect.top });
          }
        });

        candidates.sort(function(a, b) { return b.score - a.score || a.top - b.top; });
        var limited = candidates.slice(0, MAX);
        for (var i = 0; i < limited.length; i++) {
          var el = limited[i].el;
          var rect = el.getBoundingClientRect();
          var tag = el.tagName.toLowerCase();
          var attrs = {};
          var attrNames = ['id', 'name', 'type', 'data-testid', 'aria-label', 'href', 'role', 'placeholder', 'class', 'contenteditable', 'data-slate-editor', 'data-lexical-editor'];
          for (var ai = 0; ai < attrNames.length; ai++) {
            var v = el.getAttribute(attrNames[ai]);
            if (v) attrs[attrNames[ai]] = v.slice(0, 80);
          }
          // Skip expand/fullscreen/maximize buttons and WhatsApp widget
          var elClass = (el.getAttribute('class') || '').toLowerCase();
          var elTitle = (el.getAttribute('title') || el.getAttribute('aria-label') || '').toLowerCase();
          var elTooltip = (el.getAttribute('data-tooltip') || el.getAttribute('data-original-title') || '').toLowerCase();
          var elText = (el.textContent || '').trim().toLowerCase();
          if (elClass.includes('expand') || elClass.includes('fullscreen') || elClass.includes('maximize') ||
              elTitle.includes('expand') || elTitle.includes('fullscreen') || elTitle.includes('maximize') ||
              elTooltip.includes('expand') || elTooltip.includes('fullscreen') || elTooltip.includes('maximize') ||
              elClass.includes('whatsapp') || elClass.includes('wa-widget') ||
              elClass.includes('custom-options-tooltip') ||
              (tag === 'svg' && el.closest && el.closest('[data-tooltip="Expand"]')) ||
              (tag === 'svg' && el.closest && el.closest('[class*="expand"]')) ||
              (tag === 'button' && el.querySelector && el.querySelector('svg polyline[points*="15 3 21 3"]')) ||
              elClass.includes('step_guide') || el.id === 'step_guide_Btn' ||
              (el.getAttribute('tooltip') || '').toLowerCase() === 'guide' ||
              (tag === 'button' && el.querySelector && el.querySelector('.fa-question-circle'))) continue;

          var cssSelector = '';
          if (el.id) cssSelector = '#' + el.id;
          else if (el.getAttribute('data-testid')) cssSelector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
          else if (el.getAttribute('name')) cssSelector = tag + '[name="' + el.getAttribute('name') + '"]';
          results.push({
            tag: tag,
            type: attrs['type'] || '',
            text: (el.textContent || '').trim().slice(0, 50),
            value: el.value !== undefined ? String(el.value || '') : (el.getAttribute('contenteditable') ? (el.textContent || '').trim().slice(0, 100) : ''),
            placeholder: attrs['placeholder'] || '',
            attributes: attrs,
            boundingBox: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
            isInteractable: !el.disabled,
            isVisible: true,
            _cssSelector: cssSelector
          });
        }
        var keyText = [];
        var headings = document.querySelectorAll('h1,h2,h3,label');
        for (var hi = 0; hi < headings.length && keyText.length < 10; hi++) {
          var t = (headings[hi].textContent || '').trim().slice(0, 60);
          if (t.length > 2) keyText.push(t);
        }
        var overlayEl = document.querySelector('[role="dialog"],[role="alertdialog"],.modal,.overlay');
        var hasOverlay = !!(overlayEl && overlayEl.offsetParent);
        var canvasEl = document.querySelector('canvas');
        var hasCanvas = !!(canvasEl && canvasEl.width > 100);
        var textMap = {};
        for (var ri = 0; ri < results.length; ri++) {
          var txt = results[ri].text.trim();
          if (txt.length > 2) textMap[txt] = (textMap[txt] || 0) + 1;
        }
        var dupCount = 0;
        for (var k in textMap) { if (textMap[k] > 1) dupCount++; }
        var errorMessages = [];
        var errEls = document.querySelectorAll('[role="alert"],.error-message,[class*="alert-danger"]');
        for (var eei = 0; eei < errEls.length && errorMessages.length < 5; eei++) {
          var et = (errEls[eei].textContent || '').trim().slice(0, 100);
          if (et.length > 3 && errEls[eei].offsetParent) errorMessages.push(et);
        }
        return { elements: results, keyText: keyText.slice(0, 10), hasOverlay: hasOverlay, hasCanvas: hasCanvas, duplicateTextCount: dupCount, errorMessages: errorMessages.slice(0, 5) };
      })()`);
    } catch (err) {
      console.error('[adapter] DOM extraction failed:', (err as Error).message);
      return { url, title, elements: [], keyText: [], formValues: {}, domFingerprint: 'error', hasOverlay: false, hasCanvas: false, duplicateTextCount: 0, errorMessages: [] };
    }

    if (!rawData || !rawData.elements) {
      console.warn('[adapter] DOM extraction returned empty/undefined');
      return { url, title, elements: [], keyText: [], formValues: {}, domFingerprint: 'empty', hasOverlay: false, hasCanvas: false, duplicateTextCount: 0, errorMessages: [] };
    }

    // Assign indices + stable elementId, filter out trap elements
    const BLOCKED_TEXTS = [
      'forgot password', 'forgot your password', 'forgot',
      'sign in with google', 'sign in with apple', 'sign in with facebook', 'sign in with microsoft',
      'sign up', 'create account', 'register',
      'guide', 'choose your preferred', 'take a tour', 'watch tutorial', 'help center',
      'request a demo',
    ];
    const elements: IndexedElement[] = rawData.elements
      .map((el: any, i: number) => ({
        ...el,
        index: i,
        elementId: generateElementId(el),
      } as IndexedElement))
      .filter((el: IndexedElement) => {
        const t = el.text?.toLowerCase() || '';
        const href = el.attributes?.['href']?.toLowerCase() || '';
        // Remove "Forgot Password" and social login links — model must never see these
        if (BLOCKED_TEXTS.some(b => t.includes(b))) return false;
        if (href.includes('forgotpassword') || href.includes('forgot-password')) return false;
        return true;
      });

    // Form values keyed by elementId
    const formValues: Record<string, string> = {};
    for (const el of elements) {
      if (el.value && (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select')) {
        formValues[el.elementId] = el.value;
      }
    }

    // DOM fingerprint — includes form values + element count for sensitivity
    const fpParts = [
      url,
      String(elements.length),
      elements.map(e => `${e.tag}:${e.text.slice(0, 15)}:${e.value?.slice(0, 10) || ''}:${e.boundingBox.y}`).join('|'),
      Object.entries(formValues).map(([k, v]) => `${k}=${v.slice(0, 10)}`).join('|'),
    ];
    const domFingerprint = crypto.createHash('md5').update(fpParts.join('||')).digest('hex').slice(0, 12);

    return {
      url, title, elements,
      keyText: rawData.keyText || [],
      formValues,
      domFingerprint,
      hasOverlay: rawData.hasOverlay || false,
      hasCanvas: rawData.hasCanvas || false,
      duplicateTextCount: rawData.duplicateTextCount || 0,
      errorMessages: rawData.errorMessages || [],
    };
  }

  async dismissTitleEdit(): Promise<boolean> {
    try {
      const dismissed = await this.activePage.evaluate(`(() => {
        var focused = document.activeElement;
        if (!focused || focused.tagName !== 'INPUT') return false;
        var val = (focused.value || '').toLowerCase();
        var cls = (focused.className || '').toLowerCase();
        if (val.includes('integration') || val.includes('connect') || val.includes('workflow') ||
            val.includes('google') || val.includes('gmail') || val.includes('sheets') ||
            cls.includes('name') || cls.includes('title') || cls.includes('editable')) {
          focused.blur();
          return true;
        }
        return false;
      })()`);
      if (dismissed) {
        await this.activePage.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 300));
      }
      return !!dismissed;
    } catch { return false; }
  }

  async getUrl(): Promise<string> { return this.activePage.url(); }
  async getTitle(): Promise<string> { return this.activePage.title().catch(() => ''); }

  // ── Raw actions (no fallback — Action Engine handles fallback) ──

  async clickBySelector(selector: string): Promise<ActionResult> {
    try {
      await this.activePage.click(selector, { timeout: ACTION_TIMEOUT });
      return { success: true, effective: false }; // effective set by action engine
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async clickByText(text: string, role?: string): Promise<ActionResult> {
    try {
      if (role) {
        await this.activePage.getByRole(role as any, { name: text }).first().click({ timeout: ACTION_TIMEOUT });
      } else {
        await this.activePage.getByText(text, { exact: false }).first().click({ timeout: ACTION_TIMEOUT });
      }
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async clickByCoordinates(x: number, y: number): Promise<ActionResult> {
    try {
      await this.activePage.mouse.click(x, y);
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async doubleClickByCoordinates(x: number, y: number): Promise<ActionResult> {
    try {
      await this.activePage.mouse.dblclick(x, y);
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async doubleClickByText(text: string): Promise<ActionResult> {
    try {
      await this.activePage.getByText(text, { exact: false }).first().dblclick({ timeout: ACTION_TIMEOUT });
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async clickByPanelText(text: string): Promise<ActionResult> {
    try {
      // Search entire page for clickable element containing the text
      // Priority: label (Appy Pie checkboxes) → a → li → button → div → span
      const clicked = await this.activePage.evaluate(`(() => {
        var searchText = ${JSON.stringify(text.toLowerCase())};
        var blocked = ['forgot', 'sign up', 'create account', 'register', 'sign in with', 'google sign', 'apple sign'];
        var selectors = ['label', '.form-checkbox', 'a', 'li', 'button', 'div', 'span', 'p'];
        for (var si = 0; si < selectors.length; si++) {
          var els = document.querySelectorAll(selectors[si]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            var elText = (el.textContent || '').trim().toLowerCase();
            if (elText.length < 2 || elText.length > 150) continue;
            var isBlocked = false;
            for (var bi = 0; bi < blocked.length; bi++) { if (elText.includes(blocked[bi])) { isBlocked = true; break; } }
            if (isBlocked) continue;
            var href = (el.getAttribute('href') || '').toLowerCase();
            if (href.includes('forgot') || href.includes('signup') || href.includes('register')) continue;
            if (!elText.includes(searchText) && searchText.length > 3) continue;
            if (elText === searchText || elText.startsWith(searchText) || elText.includes(searchText)) {
              var rect = el.getBoundingClientRect();
              if (rect.width < 10 || rect.height < 10) continue;
              var style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              if (rect.top < 0 || rect.top > window.innerHeight + 100) continue;
              var labelFor = el.tagName === 'LABEL' ? (el.getAttribute('for') || '') : '';
              return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: elText.slice(0, 40), labelFor: labelFor };
            }
          }
        }
        return null;
      })()`);

      if (clicked) {
        const c = clicked as { x: number; y: number; text: string; labelFor?: string };

        // Strategy 1: If it's a label with `for` attribute → toggle checkbox via JS
        if (c.labelFor) {
          await this.activePage.evaluate(`(() => {
            var el = document.getElementById(${JSON.stringify(c.labelFor)});
            if (el) {
              var wasDisabled = el.disabled;
              el.disabled = false;
              el.checked = !el.checked;
              el.click();
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (wasDisabled) el.disabled = true;
            }
          })()`);
          console.log(`[adapter] Panel text click (label+checkbox JS): "${c.text}" for="${c.labelFor}"`);
        } else {
          // Strategy 2: Click by coordinates
          await this.activePage.mouse.click(c.x, c.y);
          console.log(`[adapter] Panel text click: "${c.text}" at (${c.x}, ${c.y})`);

          // Strategy 3: Also try to find and click any nearby checkbox/radio via JS
          await this.activePage.evaluate(`(() => {
            var searchText = ${JSON.stringify(c.text.toLowerCase())};
            var labels = document.querySelectorAll('label');
            for (var i = 0; i < labels.length; i++) {
              var lt = (labels[i].textContent || '').trim().toLowerCase();
              if (lt.includes(searchText)) {
                var forId = labels[i].getAttribute('for');
                if (forId) {
                  var inp = document.getElementById(forId);
                  if (inp) {
                    var wasDisabled = inp.disabled;
                    inp.disabled = false;
                    inp.checked = true;
                    inp.click();
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    if (wasDisabled) inp.disabled = true;
                    return;
                  }
                }
                // Also try clicking the label itself
                labels[i].click();
                return;
              }
            }
          })()`);
        }
        // Delay for Angular to process
        await new Promise(r => setTimeout(r, 500));
        return { success: true, effective: false };
      }
      return { success: false, effective: false, error: `No visible element found with text "${text.slice(0, 30)}"` };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  // Select an event from Appy Pie's checkbox-based event list + click Continue
  async selectAppyPieEvent(eventText: string): Promise<ActionResult> {
    try {
      const result = await this.activePage.evaluate(`(() => {
        var target = ${JSON.stringify(eventText.toLowerCase())};
        // Find all form-checkbox containers
        var checkboxes = document.querySelectorAll('.form-checkbox, [class*="form-check"]');
        for (var i = 0; i < checkboxes.length; i++) {
          var box = checkboxes[i];
          var text = (box.textContent || '').trim().toLowerCase();
          if (text.includes(target)) {
            // Found the event — click the checkbox input
            var input = box.querySelector('input[type="checkbox"], input[type="radio"]');
            if (input) {
              input.disabled = false;
              input.checked = true;
              input.click();
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Also click the label
            var label = box.querySelector('label');
            if (label) label.click();
            return { success: true, text: text.slice(0, 50) };
          }
        }
        // Also try matching by span/h5 text inside any container
        var spans = document.querySelectorAll('.dropdown_menu_body_event span, .choose-trigger-event span, .scrollheight span');
        for (var j = 0; j < spans.length; j++) {
          var st = (spans[j].textContent || '').trim().toLowerCase();
          if (st.includes(target) && !st.includes('(')) {
            var parentCheck = spans[j].closest('.form-checkbox, [class*="form-check"]');
            if (parentCheck) {
              var inp = parentCheck.querySelector('input');
              if (inp) {
                inp.disabled = false;
                inp.checked = true;
                inp.click();
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              }
              var lbl = parentCheck.querySelector('label');
              if (lbl) lbl.click();
              return { success: true, text: st.slice(0, 50) };
            }
            // Click the span itself
            spans[j].click();
            return { success: true, text: st.slice(0, 50) };
          }
        }
        return { success: false, error: 'Event not found: ' + target };
      })()`);

      const r = result as any;
      if (r?.success) {
        console.log(`[adapter] Selected Appy Pie event: "${r.text}"`);
        await new Promise(res => setTimeout(res, 1000));

        // Now click Continue button
        const continueClicked = await this.activePage.evaluate(`(() => {
          var btns = document.querySelectorAll('[data-track="continue with event"], [data-track="continue"], .continue a, .continue button');
          for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            var rect = btn.getBoundingClientRect();
            if (rect.width > 20 && rect.height > 20) {
              btn.removeAttribute('aria-disabled');
              btn.removeAttribute('disabled');
              btn.classList.remove('disabled');
              btn.click();
              return { clicked: true, text: (btn.textContent||'').trim().slice(0,30) };
            }
          }
          return { clicked: false };
        })()`);

        const cr = continueClicked as any;
        if (cr?.clicked) {
          console.log(`[adapter] Clicked Continue: "${cr.text}"`);
          await new Promise(res => setTimeout(res, 1500));
        }

        return { success: true, effective: true };
      }
      return { success: false, effective: false, error: r?.error || 'Event selection failed' };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async openAndSelectDropdown(dropdownLabel: string, optionText: string): Promise<ActionResult> {
    try {
      // Appy Pie custom dropdown flow:
      // 1. Find the dropdown by label text (e.g., "Spreadsheet", "Worksheet")
      // 2. Click the menu_icon-box to open it
      // 3. Wait for options to load
      // 4. Click the matching option
      const result = await this.activePage.evaluate(`(async () => {
        var label = ${JSON.stringify(dropdownLabel.toLowerCase())};
        var option = ${JSON.stringify(optionText.toLowerCase())};

        // Find all labels, match by text
        var labels = document.querySelectorAll('label');
        var targetMenu = null;
        for (var i = 0; i < labels.length; i++) {
          var lt = (labels[i].textContent || '').trim().toLowerCase();
          if (lt.includes(label)) {
            // Found label — find the sibling .menu container
            var parent = labels[i].closest('.form-check') || labels[i].closest('.multiple-menu') || labels[i].parentElement;
            if (parent) {
              targetMenu = parent.querySelector('.menu_icon-box') || parent.querySelector('.menu_icon') || parent.querySelector('.menu');
            }
            break;
          }
        }
        if (!targetMenu) return { success: false, error: 'Dropdown label not found: ' + label };

        // Click to open dropdown
        targetMenu.click();
        await new Promise(r => setTimeout(r, 1500));

        // Find the opened dropdown list
        var dropdowns = document.querySelectorAll('.menu_dropdown');
        var openDropdown = null;
        for (var d = 0; d < dropdowns.length; d++) {
          var dd = dropdowns[d];
          if (!dd.classList.contains('hide') && dd.offsetParent !== null) {
            openDropdown = dd;
            break;
          }
        }
        // Also try visible ones
        if (!openDropdown) {
          for (var d = 0; d < dropdowns.length; d++) {
            var dd = dropdowns[d];
            var rect = dd.getBoundingClientRect();
            if (rect.height > 10 && rect.width > 10) {
              openDropdown = dd;
              break;
            }
          }
        }
        if (!openDropdown) return { success: false, error: 'Dropdown did not open' };

        // Look for options — they could be li, a, div, span with text
        var allItems = openDropdown.querySelectorAll('li, a, div, span, label');
        var bestMatch = null;
        var bestScore = 0;
        for (var j = 0; j < allItems.length; j++) {
          var item = allItems[j];
          var itemText = (item.textContent || '').trim().toLowerCase();
          if (itemText.length < 2 || itemText.length > 200) continue;
          var rect = item.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 15) continue;

          // Exact match
          if (itemText === option || itemText.startsWith(option)) {
            bestMatch = item;
            bestScore = 100;
            break;
          }
          // Partial match
          if (itemText.includes(option) && bestScore < 50) {
            bestMatch = item;
            bestScore = 50;
          }
        }

        if (bestMatch) {
          var r = bestMatch.getBoundingClientRect();
          return { success: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (bestMatch.textContent||'').trim().slice(0,40) };
        }

        // If no option text match, select the first available option
        if (option === '' || option === 'first') {
          for (var j = 0; j < allItems.length; j++) {
            var item = allItems[j];
            var itemText = (item.textContent || '').trim();
            if (itemText.length > 2 && itemText.length < 100 && !itemText.includes('Search') && !itemText.includes('Refresh')) {
              var r = item.getBoundingClientRect();
              if (r.width > 20 && r.height > 15) {
                return { success: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: itemText.slice(0,40) };
              }
            }
          }
        }

        return { success: false, error: 'Option not found in dropdown: ' + option };
      })()`);

      const r = result as any;
      if (r && r.success && r.x) {
        await this.activePage.mouse.click(r.x, r.y);
        await new Promise(res => setTimeout(res, 500));
        console.log(`[adapter] Dropdown select: "${dropdownLabel}" → "${r.text}" at (${r.x}, ${r.y})`);
        return { success: true, effective: true };
      }
      return { success: false, effective: false, error: r?.error || 'Dropdown interaction failed' };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async insertVariableToken(fieldLabel: string, tokenText: string): Promise<ActionResult> {
    try {
      const result = await this.activePage.evaluate(`(async () => {
        var label = ${JSON.stringify(fieldLabel.toLowerCase())};
        var token = ${JSON.stringify(tokenText.toLowerCase())};

        // Step 1: Find the field row by label text
        var rows = document.querySelectorAll('.form-group, .field-row, .input-row, [class*="field"], [class*="form"]');
        var targetRow = null;
        for (var i = 0; i < rows.length; i++) {
          var t = (rows[i].textContent || '').toLowerCase();
          if (t.includes(label)) { targetRow = rows[i]; break; }
        }
        // Fallback: search all labels
        if (!targetRow) {
          var allLabels = document.querySelectorAll('label, .label, [class*="label"]');
          for (var i = 0; i < allLabels.length; i++) {
            if ((allLabels[i].textContent || '').toLowerCase().includes(label)) {
              targetRow = allLabels[i].closest('.form-group') || allLabels[i].parentElement;
              break;
            }
          }
        }
        if (!targetRow) return { success: false, error: 'Field not found: ' + label };

        // Step 2: Click the "+ Add or Select" button in that row
        var addBtn = targetRow.querySelector('[class*="add"], [class*="select"], button, a');
        if (!addBtn) {
          var els = targetRow.querySelectorAll('*');
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].textContent || '').trim().toLowerCase();
            if ((t.includes('add') || t.includes('select')) && t.length < 30) {
              addBtn = els[i]; break;
            }
          }
        }
        if (!addBtn) return { success: false, error: 'Add/Select button not found in field row' };
        addBtn.click();
        await new Promise(function(r) { setTimeout(r, 1500); });

        // Step 3: Find the opened variable picker modal/dropdown
        var picker = null;
        var candidates = document.querySelectorAll('[class*="picker"], [class*="modal"], [class*="dropdown"], [class*="variable"], [class*="data-field"], [class*="mapping"]');
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          var cRect = c.getBoundingClientRect();
          if (cRect.width > 100 && cRect.height > 50 && cRect.top >= 0) {
            picker = c; break;
          }
        }
        if (!picker) return { success: false, error: 'Variable picker did not open' };

        // Step 4: Find matching token option
        var items = picker.querySelectorAll('li, a, div, span, label, [class*="option"], [class*="item"]');
        var bestMatch = null;
        for (var i = 0; i < items.length; i++) {
          var itemText = (items[i].textContent || '').trim().toLowerCase();
          if (itemText.length < 2 || itemText.length > 200) continue;
          var iRect = items[i].getBoundingClientRect();
          if (iRect.width < 20 || iRect.height < 10) continue;
          if (itemText.includes(token) || token.includes(itemText.slice(0, 15))) {
            bestMatch = items[i]; break;
          }
        }
        // Fallback: first available item
        if (!bestMatch && (token === '' || token === 'first')) {
          for (var i = 0; i < items.length; i++) {
            var iRect = items[i].getBoundingClientRect();
            if (iRect.width > 20 && iRect.height > 10) { bestMatch = items[i]; break; }
          }
        }
        if (!bestMatch) return { success: false, error: 'Token not found in picker: ' + token };

        var r = bestMatch.getBoundingClientRect();
        return { success: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (bestMatch.textContent||'').trim().slice(0,50) };
      })()`);

      const r = result as any;
      if (r?.success && r.x) {
        await this.activePage.mouse.click(r.x, r.y);
        await new Promise(res => setTimeout(res, 500));
        console.log(`[adapter] Variable token: "${fieldLabel}" → "${r.text}"`);
        return { success: true, effective: true };
      }
      return { success: false, effective: false, error: r?.error || 'Variable token insertion failed' };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async autoFillActionFields(): Promise<{ filled: number; fields: string[] }> {
    // Proactively fill ALL empty fields that have "+ Add or Select" buttons on the action options page.
    // For each field: click its "Add or Select" button → wait for picker → click first token item.
    try {
      // Step 1: Find all "+ Add or Select" buttons on the page
      const fieldButtons = await this.activePage.evaluate(`(() => {
        var results = [];
        var seen = {};
        // Look for "add or select" / "+ add" text in the side panel
        var allEls = document.querySelectorAll('a, button, span, div');
        for (var i = 0; i < allEls.length; i++) {
          var el = allEls[i];
          var t = (el.textContent || '').trim().toLowerCase();
          if (!(t.includes('add or select') || t.includes('+ add') || (t === '+ add or select'))) continue;
          if (t.length > 40) continue;
          var rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10 || rect.top < 0) continue;
          // Find the parent field label
          var parent = el.closest('.form-group, [class*="field"], [class*="form"], [class*="row"]') || el.parentElement;
          var label = '';
          if (parent) {
            var labelEl = parent.querySelector('label, .label, [class*="label"]');
            if (labelEl) label = (labelEl.textContent || '').trim();
          }
          if (!label) {
            var prev = el.parentElement;
            while (prev && !label) {
              var lbl = prev.querySelector('label');
              if (lbl) label = (lbl.textContent || '').trim();
              prev = prev.parentElement;
            }
          }
          // Check if the field already has a value (token already inserted)
          var hasValue = false;
          if (parent) {
            var chips = parent.querySelectorAll('[class*="chip"], [class*="tag"], [class*="token"], [class*="badge"]');
            if (chips.length > 0) hasValue = true;
            var inputs = parent.querySelectorAll('input, textarea');
            for (var j = 0; j < inputs.length; j++) {
              if (inputs[j].value && inputs[j].value.trim().length > 0) hasValue = true;
            }
          }
          var key = label || ('btn-' + i);
          if (!seen[key] && !hasValue) {
            seen[key] = true;
            results.push({ label: label || 'field-' + i, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) });
          }
        }
        return results;
      })()`);

      const buttons = fieldButtons as Array<{ label: string; x: number; y: number }>;
      if (!buttons || buttons.length === 0) return { filled: 0, fields: [] };

      const filledFields: string[] = [];

      for (const btn of buttons) {
        try {
          // Click the "+ Add or Select" button
          await this.activePage.mouse.click(btn.x, btn.y);
          await new Promise(r => setTimeout(r, 1500));

          // Find the picker that opened and click the first available token
          const tokenResult = await this.activePage.evaluate(`(() => {
            // Find opened picker/dropdown/modal
            var picker = null;
            var candidates = document.querySelectorAll('[class*="picker"], [class*="dropdown-menu"], [class*="popup"], [class*="popover"], [class*="modal-body"], [class*="mapping"], [class*="field-list"], [class*="searchable"]');
            for (var i = 0; i < candidates.length; i++) {
              var c = candidates[i];
              var rect = c.getBoundingClientRect();
              if (rect.width > 80 && rect.height > 40 && rect.top >= 0 && c.offsetParent !== null) {
                picker = c; break;
              }
            }
            // Fallback: any recently-visible popup/dropdown
            if (!picker) {
              var allDivs = document.querySelectorAll('div, ul');
              for (var i = 0; i < allDivs.length; i++) {
                var d = allDivs[i];
                var cls = (d.className || '').toLowerCase();
                var style = d.style;
                if ((cls.includes('show') || cls.includes('open') || cls.includes('active') || cls.includes('visible')) &&
                    (cls.includes('drop') || cls.includes('pick') || cls.includes('list') || cls.includes('pop'))) {
                  var rect = d.getBoundingClientRect();
                  if (rect.width > 80 && rect.height > 40) { picker = d; break; }
                }
              }
            }
            if (!picker) return { success: false, error: 'picker not found' };

            // Find clickable items inside picker (skip search inputs, headers)
            var items = picker.querySelectorAll('li, a, [class*="option"], [class*="item"], [class*="field-name"], [role="option"]');
            for (var i = 0; i < items.length; i++) {
              var item = items[i];
              var text = (item.textContent || '').trim();
              if (text.length < 2 || text.length > 200) continue;
              if (item.tagName === 'INPUT' || item.tagName === 'LABEL') continue;
              var rect = item.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 8) continue;
              // Skip search box text
              if (text.toLowerCase().includes('search')) continue;
              return { success: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), text: text.slice(0, 50) };
            }
            // Second pass: any div/span that looks clickable
            var spans = picker.querySelectorAll('div, span');
            for (var i = 0; i < spans.length; i++) {
              var sp = spans[i];
              var text = (sp.textContent || '').trim();
              if (text.length < 3 || text.length > 100) continue;
              if (sp.children.length > 3) continue; // skip containers
              var rect = sp.getBoundingClientRect();
              if (rect.width < 30 || rect.height < 12) continue;
              if (text.toLowerCase().includes('search') || text.toLowerCase().includes('select')) continue;
              return { success: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), text: text.slice(0, 50) };
            }
            return { success: false, error: 'no clickable items in picker' };
          })()`);

          const token = tokenResult as any;
          if (token?.success && token.x) {
            await this.activePage.mouse.click(token.x, token.y);
            await new Promise(r => setTimeout(r, 800));
            console.log(`[adapter] Auto-filled "${btn.label}" → "${token.text}"`);
            filledFields.push(btn.label);
          } else {
            // Close picker if we couldn't select anything
            await this.activePage.keyboard.press('Escape');
            await new Promise(r => setTimeout(r, 300));
            console.log(`[adapter] Auto-fill "${btn.label}" failed: ${token?.error}`);
          }
        } catch (err) {
          console.log(`[adapter] Auto-fill "${btn.label}" error: ${(err as Error).message}`);
        }
      }

      return { filled: filledFields.length, fields: filledFields };
    } catch (err) {
      console.log(`[adapter] autoFillActionFields error: ${(err as Error).message}`);
      return { filled: 0, fields: [] };
    }
  }

  async clickContinueRunTest(): Promise<ActionResult> {
    try {
      // Wait up to 10s for "Continue & Run Test" (or "Skip Run Test") to become enabled
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = await this.activePage.evaluate(`(() => {
          var btns = document.querySelectorAll('button, a, [role="button"]');
          for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            var text = (btn.textContent || '').trim().toLowerCase();
            var track = (btn.getAttribute('data-track') || '').toLowerCase();
            var isContinueBtn = text === 'continue & run test' || text === 'skip run test' ||
                                track.includes('continue & run') || track.includes('skip run');
            if (!isContinueBtn) continue;
            var isDisabled = btn.disabled || btn.classList.contains('disabled') ||
                             btn.getAttribute('aria-disabled') === 'true' ||
                             btn.getAttribute('disabled') !== null;
            if (isDisabled) return { found: true, enabled: false };
            var rect = btn.getBoundingClientRect();
            if (rect.width < 20) return { found: true, enabled: false };
            return { found: true, enabled: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), text: text };
          }
          return { found: false };
        })()`);

        const r = result as any;
        if (r?.found && r?.enabled && r?.x) {
          await this.activePage.mouse.click(r.x, r.y);
          console.log(`[adapter] Clicked "${r.text}" at (${r.x}, ${r.y})`);
          await new Promise(res => setTimeout(res, 1500));
          return { success: true, effective: true };
        }
        if (!r?.found) break; // button not on page at all
        // Button found but disabled — wait 1s and retry
        await new Promise(res => setTimeout(res, 1000));
      }
      return { success: false, effective: false, error: 'Continue & Run Test button not found or stayed disabled' };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async typeBySelector(selector: string, text: string): Promise<ActionResult> {
    try {
      await this.activePage.fill(selector, text, { timeout: ACTION_TIMEOUT });
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async typeByContentEditable(selector: string, text: string): Promise<ActionResult> {
    try {
      const el = this.activePage.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
      await el.click({ timeout: ACTION_TIMEOUT });
      // Select all existing content and replace with new text
      await this.activePage.keyboard.press('Control+A');
      await this.activePage.keyboard.type(text, { delay: 20 });
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async typeByCoordinates(x: number, y: number, text: string): Promise<ActionResult> {
    try {
      await this.activePage.mouse.click(x, y);
      await this.activePage.keyboard.press('Control+A');
      await this.activePage.keyboard.type(text, { delay: 30 });
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async selectBySelector(selector: string, value: string): Promise<ActionResult> {
    try {
      await this.activePage.selectOption(selector, { label: value }, { timeout: ACTION_TIMEOUT });
      return { success: true, effective: false };
    } catch {
      try {
        await this.activePage.selectOption(selector, value, { timeout: ACTION_TIMEOUT });
        return { success: true, effective: false };
      } catch (err) {
        return { success: false, effective: false, error: (err as Error).message };
      }
    }
  }

  async scroll(direction: 'up' | 'down', amount: number = 300): Promise<ActionResult> {
    try {
      await this.activePage.mouse.wheel(0, direction === 'down' ? amount : -amount);
      await new Promise(r => setTimeout(r, 200));
      return { success: true, effective: true };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async navigate(url: string): Promise<ActionResult> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return { success: true, effective: true, newUrl: this.activePage.url() };
      } catch (err) {
        lastErr = err as Error;
        console.warn(`[adapter] navigate attempt ${attempt + 1} failed: ${lastErr.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
    return { success: false, effective: false, error: lastErr!.message };
  }

  async keypress(key: string): Promise<ActionResult> {
    // Normalize key names — Playwright is case-sensitive
    const KEY_MAP: Record<string, string> = {
      'HOME': 'Home', 'END': 'End',
      'PAGEUP': 'PageUp', 'PAGEDOWN': 'PageDown',
      'ENTER': 'Enter', 'RETURN': 'Enter',
      'TAB': 'Tab', 'ESC': 'Escape', 'ESCAPE': 'Escape',
      'SPACE': 'Space', 'DEL': 'Delete', 'DELETE': 'Delete',
      'BACKSPACE': 'Backspace',
      'ARROWUP': 'ArrowUp', 'ARROWDOWN': 'ArrowDown',
      'ARROWLEFT': 'ArrowLeft', 'ARROWRIGHT': 'ArrowRight',
      'UP': 'ArrowUp', 'DOWN': 'ArrowDown',
      'LEFT': 'ArrowLeft', 'RIGHT': 'ArrowRight',
    };
    // Modifier map for combo keys (e.g. "Ctrl+R", "Ctrl+Shift+N")
    const MODIFIER_MAP: Record<string, string> = {
      'CTRL': 'Control', 'CONTROL': 'Control',
      'ALT': 'Alt', 'SHIFT': 'Shift',
      'META': 'Meta', 'CMD': 'Meta', 'WIN': 'Meta', 'SUPER': 'Meta',
    };
    let normalizedKey: string;
    if (key.includes('+')) {
      // Combo key: normalize each part separately
      const parts = key.split('+');
      normalizedKey = parts.map((p, i) => {
        const upper = p.trim().toUpperCase();
        if (MODIFIER_MAP[upper]) return MODIFIER_MAP[upper];
        // Last part is the actual key (not a modifier) — lowercase single chars
        const mapped = KEY_MAP[upper];
        if (mapped) return mapped;
        return p.trim().length === 1 ? p.trim().toLowerCase() : p.trim();
      }).join('+');
    } else {
      normalizedKey = KEY_MAP[key.toUpperCase()] ?? key;
    }
    try {
      await this.activePage.keyboard.press(normalizedKey);
      return { success: true, effective: false };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async wait(ms: number): Promise<ActionResult> {
    await new Promise(r => setTimeout(r, Math.min(ms, 5000)));
    return { success: true, effective: false };
  }

  async screenshot(filePath: string): Promise<void> {
    await this.activePage.screenshot({ path: filePath });
  }

  async screenshotJPEG(): Promise<string> {
    const buffer = await this.activePage.screenshot({ type: 'jpeg', quality: 50 });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  async close(): Promise<void> {}

  getActivePage(): Page { return this.activePage; }
}
