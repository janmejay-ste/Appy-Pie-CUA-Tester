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
      if (minimizeBtn) {
        minimizeBtn.click();
        console.log('[dom-cleanup] Auto-clicked Minimize to restore layout');
      }

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
      // Only remove if Continue button is already visible (account is linked)
      var continueBtn = document.querySelector('[data-track="continue with account"] , [data-track="continue"] , .continue button');
      if (continueBtn) {
        document.querySelectorAll('[data-track="add account"], [data-track="change account"]').forEach(function(el) { el.remove(); });
        // Remove "Change" links next to account entries
        document.querySelectorAll('a').forEach(function(el) {
          var text = (el.textContent || '').trim().toLowerCase();
          if (text === 'change' || text === 'add an account' || text === 'add account') el.remove();
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
          var attrNames = ['id', 'name', 'type', 'data-testid', 'aria-label', 'href', 'role', 'placeholder', 'class'];
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
            value: el.value !== undefined ? String(el.value || '') : '',
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

  async typeBySelector(selector: string, text: string): Promise<ActionResult> {
    try {
      await this.activePage.fill(selector, text, { timeout: ACTION_TIMEOUT });
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
    try {
      await this.activePage.goto(url, { waitUntil: 'load', timeout: 15000 });
      return { success: true, effective: true, newUrl: this.activePage.url() };
    } catch (err) {
      return { success: false, effective: false, error: (err as Error).message };
    }
  }

  async keypress(key: string): Promise<ActionResult> {
    try {
      await this.activePage.keyboard.press(key);
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
