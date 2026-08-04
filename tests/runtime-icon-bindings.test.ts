import { describe, expect, it, vi } from "vitest";
import {
  LINKMARK_BINDING_ATTRIBUTE,
  RuntimeIconBindingPublisher,
} from "../src/runtime-icon-bindings";

class FakeStyleDeclaration {
  readonly properties = new Map<string, string>();

  constructor(body = "", private readonly operations?: string[]) {
    for (const declaration of body.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      this.properties.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
  }

  setProperty(name: string, value: string) {
    this.operations?.push(`set:${name}`);
    this.properties.set(name, value);
  }
}

class FakeStyleRule {
  readonly style: FakeStyleDeclaration;

  constructor(readonly selectorText: string, body: string, operations: string[]) {
    this.style = new FakeStyleDeclaration(body, operations);
  }
}

class FakeStyleSheet {
  private readonly rules: FakeStyleRule[] = [];
  failInsert = false;

  constructor(private readonly operations: string[]) {}

  get cssRules() {
    this.operations.push("rules:read");
    return [...this.rules];
  }

  insertRule(text: string, index: number) {
    this.operations.push("insert");
    if (this.failInsert) throw new Error("insert failed");
    const rule = parseRule(text, this.operations);
    this.rules.splice(index, 0, rule);
    return index;
  }

  deleteRule(index: number) {
    this.operations.push("delete");
    this.rules.splice(index, 1);
  }

  replace(text: string) {
    this.rules.splice(0, this.rules.length, ...parseRules(text, this.operations));
  }
}

class FakeElement {
  private readonly attributes = new Map<string, string>();

  constructor(private readonly operations: string[]) {}

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.operations.push("marker:set");
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    if (this.attributes.has(name)) this.operations.push("marker:remove");
    this.attributes.delete(name);
  }
}

class FakeStyleElement {
  id = "";
  isConnected = false;
  readonly sheet: FakeStyleSheet;
  textWrites = 0;
  failText = false;
  private text = "";

  constructor(private readonly owner: FakeDocument, operations: string[]) {
    this.sheet = new FakeStyleSheet(operations);
  }

  get textContent() {
    return this.text;
  }

  set textContent(value: string) {
    this.textWrites += 1;
    if (this.failText || this.owner.failStyleText) throw new Error("text failed");
    this.text = value;
    this.sheet.replace(value);
  }

  remove() {
    this.isConnected = false;
  }
}

class FakeDocument {
  readonly operations: string[] = [];
  readonly elements: FakeElement[] = [];
  readonly styles: FakeStyleElement[] = [];
  failStyleText = false;
  readonly head = {
    appendChild: (style: FakeStyleElement) => {
      style.isConnected = true;
      this.styles.push(style);
      return style;
    },
  };

  createElement() {
    return new FakeStyleElement(this, this.operations);
  }

  querySelectorAll() {
    return this.elements.filter((element) => element.getAttribute(LINKMARK_BINDING_ATTRIBUTE) !== null);
  }

  link() {
    const element = new FakeElement(this.operations);
    this.elements.push(element);
    return element;
  }

  get connectedStyle() {
    for (let index = this.styles.length - 1; index >= 0; index -= 1) {
      if (this.styles[index].isConnected) return this.styles[index];
    }
    return null;
  }
}

describe("RuntimeIconBindingPublisher", () => {
  it("publishes one shared rule plus one short rule per binding", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    const bindings = new Map(Array.from({ length: 500 }, (_, index) => [
      `scope-${index}`,
      `https://icons.example/${index}.png`,
    ]));
    const markers = new Map<HTMLElement, string>();
    for (let index = 0; index < 2_000; index += 1) {
      markers.set(document.link() as unknown as HTMLElement, `scope-${index % 500}`);
    }

    publisher.replaceBindings(bindings, 1);
    publisher.publish(markers, true);

    const rules = document.connectedStyle!.sheet.cssRules;
    expect(rules).toHaveLength(501);
    expect(rules[0].selectorText).toBe(`[${LINKMARK_BINDING_ATTRIBUTE}]::before`);
    expect(rules.slice(1).every((rule) => rule.selectorText.startsWith(`[${LINKMARK_BINDING_ATTRIBUTE}=`))).toBe(true);
    expect(rules.every((rule) => !rule.selectorText.includes("href"))).toBe(true);
    expect(document.elements.every((element) => element.getAttribute(LINKMARK_BINDING_ATTRIBUTE))).toBe(true);
  });

  it("updates one icon and icon size in place without rebuilding text", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    publisher.replaceBindings(new Map([["scope", "icon-a.png"]]), 1);
    publisher.publish(new Map(), false);
    const style = document.connectedStyle!;
    const layout = style.sheet.cssRules[0];
    const binding = style.sheet.cssRules[1];
    const textWrites = style.textWrites;

    publisher.replaceBindings(new Map([["scope", "icon-b.png"]]), 1.4);
    publisher.publish(new Map(), false);

    expect(document.connectedStyle).toBe(style);
    expect(style.textWrites).toBe(textWrites);
    expect(style.sheet.cssRules[0]).toBe(layout);
    expect(style.sheet.cssRules[1]).toBe(binding);
    expect(layout.style.properties.get("width")).toBe("1.4em");
    expect(binding.style.properties.get("background-image")).toBe('url("icon-b.png")');
  });

  it("inserts destination rules before changing markers and deletes departed rules last", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    const link = document.link();
    publisher.replaceBindings(new Map([["old", "old.png"]]), 1);
    publisher.publish(new Map([[link as unknown as HTMLElement, "old"]]), true);
    document.operations.length = 0;

    publisher.replaceBindings(new Map([["next", "next.png"]]), 1);
    publisher.publish(new Map([[link as unknown as HTMLElement, "next"]]), true);

    expect(document.operations).toEqual(["rules:read", "insert", "rules:read", "marker:set", "rules:read", "delete"]);
  });

  it("removes hundreds of departed rules from one cssRules snapshot", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    const bindings = new Map(Array.from({ length: 500 }, (_, index) => [
      `scope-${index}`,
      `https://icons.example/${index}.png`,
    ]));
    const markers = new Map<HTMLElement, string>();
    for (let index = 0; index < 2_000; index += 1) {
      markers.set(document.link() as unknown as HTMLElement, `scope-${index % 500}`);
    }
    publisher.replaceBindings(bindings, 1);
    publisher.publish(markers, true);

    publisher.replaceBindings(new Map([...bindings].slice(0, 10)), 1);
    document.operations.length = 0;
    publisher.publish(new Map([...markers.entries()].slice(0, 40)), true);

    // The whole departure pass reads the stylesheet once, not once per departed rule.
    expect(document.operations.filter((operation) => operation === "rules:read")).toHaveLength(1);

    const rules = document.connectedStyle!.sheet.cssRules;
    expect(rules).toHaveLength(11);
    expect(rules[0].selectorText).toBe(`[${LINKMARK_BINDING_ATTRIBUTE}]::before`);
    expect(rules.slice(1).map((rule) => rule.selectorText)).toEqual(
      Array.from({ length: 10 }, (_, index) => `[${LINKMARK_BINDING_ATTRIBUTE}="${index + 1}"]::before`),
    );
    for (const [element] of [...markers.entries()].slice(40)) {
      expect(element.getAttribute(LINKMARK_BINDING_ATTRIBUTE)).toBeNull();
    }
  });

  it("removes stale markers on full publication and all markers on clear", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    const current = document.link();
    const stale = document.link();
    stale.setAttribute(LINKMARK_BINDING_ATTRIBUTE, "stale");
    publisher.replaceBindings(new Map([["scope", "icon.png"]]), 1);
    publisher.publish(new Map([[current as unknown as HTMLElement, "scope"]]), true);
    expect(stale.getAttribute(LINKMARK_BINDING_ATTRIBUTE)).toBeNull();

    publisher.clear();
    expect(current.getAttribute(LINKMARK_BINDING_ATTRIBUTE)).toBeNull();
    expect(document.connectedStyle).toBeNull();
  });

  it("rebuilds the compact stylesheet after a CSSOM insertion failure", () => {
    const document = new FakeDocument();
    const publisher = createPublisher(document);
    publisher.replaceBindings(new Map([["a", "a.png"]]), 1);
    publisher.publish(new Map(), false);
    document.connectedStyle!.sheet.failInsert = true;

    publisher.replaceBindings(new Map([["a", "a.png"], ["b", "b.png"]]), 1);
    publisher.publish(new Map(), false);

    expect(document.connectedStyle!.sheet.cssRules).toHaveLength(3);
    expect(document.connectedStyle!.sheet.cssRules.map((rule) => rule.selectorText)).toEqual([
      `[${LINKMARK_BINDING_ATTRIBUTE}]::before`,
      `[${LINKMARK_BINDING_ATTRIBUTE}="1"]::before`,
      `[${LINKMARK_BINDING_ATTRIBUTE}="2"]::before`,
    ]);
  });

  it("fails invisible when normal and compact publication both fail", () => {
    const document = new FakeDocument();
    const stale = document.link();
    stale.setAttribute(LINKMARK_BINDING_ATTRIBUTE, "stale");
    document.failStyleText = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publisher = createPublisher(document);
    publisher.replaceBindings(new Map([["scope", "icon.png"]]), 1);

    publisher.publish(new Map([[stale as unknown as HTMLElement, "scope"]]), true);

    expect(stale.getAttribute(LINKMARK_BINDING_ATTRIBUTE)).toBeNull();
    expect(document.connectedStyle).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

function createPublisher(document: FakeDocument) {
  return new RuntimeIconBindingPublisher(document as unknown as Document, "runtime-style");
}

function parseRules(text: string, operations: string[]) {
  const rules: FakeStyleRule[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push(new FakeStyleRule(match[1].trim(), match[2], operations));
  }
  return rules;
}

function parseRule(text: string, operations: string[]) {
  const [rule] = parseRules(text, operations);
  if (!rule) throw new Error("invalid rule");
  return rule;
}
