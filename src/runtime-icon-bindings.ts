import { cssString } from "./icon-rule";

export const LINKMARK_BINDING_ATTRIBUTE = "data-linkmark-key";

type DesiredBinding = {
  token: string;
  iconUrl: string;
};

type PublishedBinding = DesiredBinding & {
  rule: CSSStyleRule;
};

export class RuntimeIconBindingPublisher {
  private desired = new Map<string, DesiredBinding>();
  private published = new Map<string, PublishedBinding>();
  private style: HTMLStyleElement | null = null;
  private layoutRule: CSSStyleRule | null = null;
  private iconSize = 1;
  private publishedIconSize = 1;
  private nextToken = 1;
  private failureLogged = false;

  constructor(
    private readonly document: Document,
    private readonly styleId: string,
  ) {}

  replaceBindings(bindings: ReadonlyMap<string, string>, iconSize: number) {
    const next = new Map<string, DesiredBinding>();
    for (const [key, iconUrl] of bindings) {
      const current = this.desired.get(key) ?? this.published.get(key);
      next.set(key, {
        token: current?.token ?? String(this.nextToken++),
        iconUrl,
      });
    }
    const changed = iconSize !== this.iconSize || !sameBindings(this.desired, next);
    this.desired = next;
    this.iconSize = iconSize;
    return changed;
  }

  tokenFor(bindingKey: string | undefined) {
    return bindingKey ? this.desired.get(bindingKey)?.token : undefined;
  }

  publish(markerBindings: ReadonlyMap<HTMLElement, string | undefined>, full: boolean) {
    if (this.desired.size === 0) {
      this.applyMarkers(markerBindings, full);
      this.removeAllMarkers();
      this.removeStylesheet();
      this.published.clear();
      return;
    }
    try {
      this.syncRulesBeforeMarkers();
      this.applyMarkers(markerBindings, full);
      this.removeDepartedRules();
      this.failureLogged = false;
    } catch (error) {
      try {
        this.rebuildCompactStylesheet(true);
        this.applyMarkers(markerBindings, full);
        this.removeDepartedRules();
        this.failureLogged = false;
      } catch (recoveryError) {
        this.removeAllMarkers();
        this.removeStylesheet();
        this.published.clear();
        if (!this.failureLogged) {
          this.failureLogged = true;
          console.warn("[siyuan-linkmark] Unable to publish runtime icon bindings", error, recoveryError);
        }
      }
    }
  }

  clear() {
    this.desired.clear();
    this.removeAllMarkers();
    this.removeStylesheet();
    this.published.clear();
  }

  destroy() {
    this.clear();
    this.nextToken = 1;
  }

  private syncRulesBeforeMarkers() {
    const sheet = this.ensureStylesheet();
    if (this.iconSize !== this.publishedIconSize) {
      this.layoutRule?.style.setProperty("width", `${this.iconSize}em`);
      this.layoutRule?.style.setProperty("height", `${this.iconSize}em`);
      this.publishedIconSize = this.iconSize;
    }
    for (const [key, desired] of this.desired) {
      const current = this.published.get(key);
      if (current) {
        if (current.iconUrl !== desired.iconUrl) {
          current.rule.style.setProperty("background-image", `url(${cssString(desired.iconUrl)})`);
          current.iconUrl = desired.iconUrl;
        }
        continue;
      }
      const index = sheet.insertRule(bindingRule(desired), sheet.cssRules.length);
      const rule = sheet.cssRules[index] as CSSStyleRule;
      this.published.set(key, { ...desired, rule });
    }
  }

  private ensureStylesheet() {
    if (!this.style?.isConnected) {
      this.style = this.document.createElement("style");
      this.style.id = this.styleId;
      this.style.textContent = layoutRule(this.iconSize);
      this.document.head.appendChild(this.style);
      this.layoutRule = this.style.sheet?.cssRules[0] as CSSStyleRule | undefined ?? null;
      this.published.clear();
      this.publishedIconSize = this.iconSize;
    }
    const sheet = this.style.sheet;
    if (!sheet || !this.layoutRule) throw new Error("Runtime icon stylesheet is unavailable");
    return sheet;
  }

  private applyMarkers(markerBindings: ReadonlyMap<HTMLElement, string | undefined>, full: boolean) {
    const seen = full ? new Set<HTMLElement>() : null;
    for (const [element, bindingKey] of markerBindings) {
      seen?.add(element);
      const token = this.tokenFor(bindingKey);
      if (token) {
        if (element.getAttribute(LINKMARK_BINDING_ATTRIBUTE) !== token) {
          element.setAttribute(LINKMARK_BINDING_ATTRIBUTE, token);
        }
      } else {
        element.removeAttribute(LINKMARK_BINDING_ATTRIBUTE);
      }
    }
    if (!seen) return;
    for (const element of this.markedElements()) {
      if (!seen.has(element)) element.removeAttribute(LINKMARK_BINDING_ATTRIBUTE);
    }
  }

  private removeDepartedRules() {
    const sheet = this.style?.sheet;
    if (!sheet) throw new Error("Runtime icon stylesheet is unavailable");
    const rules = Array.from(sheet.cssRules);
    const indexByRule = new Map<CSSRule, number>();
    for (let index = 0; index < rules.length; index += 1) {
      indexByRule.set(rules[index], index);
    }
    const departed: Array<{ key: string; index: number }> = [];
    for (const [key, binding] of this.published) {
      if (this.desired.has(key)) continue;
      const index = indexByRule.get(binding.rule);
      if (index === undefined) throw new Error("Published icon rule is unavailable");
      departed.push({ key, index });
    }
    departed.sort((left, right) => right.index - left.index);
    for (const { key, index } of departed) {
      sheet.deleteRule(index);
      this.published.delete(key);
    }
  }

  private rebuildCompactStylesheet(includeDeparted: boolean) {
    const retained = new Map<string, DesiredBinding>();
    if (includeDeparted) {
      for (const [key, binding] of this.published) retained.set(key, binding);
    }
    for (const [key, binding] of this.desired) retained.set(key, binding);
    this.removeStylesheet();
    const style = this.document.createElement("style");
    style.id = this.styleId;
    style.textContent = [layoutRule(this.iconSize), ...[...retained.values()].map(bindingRule)].join("\n");
    this.document.head.appendChild(style);
    const sheet = style.sheet;
    if (!sheet || sheet.cssRules.length !== retained.size + 1) {
      style.remove();
      throw new Error("Runtime icon stylesheet reconstruction failed");
    }
    this.style = style;
    this.layoutRule = sheet.cssRules[0] as CSSStyleRule;
    this.published = new Map([...retained.entries()].map(([key, binding], index) => [
      key,
      { ...binding, rule: sheet.cssRules[index + 1] as CSSStyleRule },
    ]));
    this.publishedIconSize = this.iconSize;
  }

  private markedElements() {
    return this.document.querySelectorAll<HTMLElement>(`[${LINKMARK_BINDING_ATTRIBUTE}]`);
  }

  private removeAllMarkers() {
    for (const element of this.markedElements()) element.removeAttribute(LINKMARK_BINDING_ATTRIBUTE);
  }

  private removeStylesheet() {
    this.style?.remove();
    this.style = null;
    this.layoutRule = null;
  }
}

function sameBindings(left: ReadonlyMap<string, DesiredBinding>, right: ReadonlyMap<string, DesiredBinding>) {
  if (left.size !== right.size) return false;
  for (const [key, binding] of right) {
    const current = left.get(key);
    if (!current || current.token !== binding.token || current.iconUrl !== binding.iconUrl) return false;
  }
  return true;
}

function layoutRule(iconSize: number) {
  return `[${LINKMARK_BINDING_ATTRIBUTE}]::before {
      display: inline-block;
      width: ${iconSize}em;
      height: ${iconSize}em;
      margin-right: 0.22em;
      vertical-align: -0.12em;
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
    }`;
}

function bindingRule(binding: DesiredBinding) {
  return `[${LINKMARK_BINDING_ATTRIBUTE}=${cssString(binding.token)}]::before {
      content: "";
      background-image: url(${cssString(binding.iconUrl)});
    }`;
}
