import { describe, expect, it } from "vitest";
import {
  LINK_CONTENT_OBSERVER_OPTIONS,
  planMutationDiscovery,
  type MutationDiscoveryElement,
} from "../src/frontend-mutation-discovery";

interface FakeElement extends MutationDiscoveryElement<FakeElement> {
  attributes: Map<string, string>;
  parentElement: FakeElement | null;
  roles: Set<string>;
  linkedDescendant: FakeElement | null;
}

function fakeElement(...roles: string[]): FakeElement {
  const roleSet = new Set(roles);
  if (roleSet.has("link")) roleSet.add("detached-link");
  const element: FakeElement = {
    attributes: new Map(),
    isConnected: true,
    linkedDescendant: null,
    parentElement: null,
    roles: roleSet,
    tagName: roles.includes("anchor") ? "A" : "SPAN",
    closest: (selector) => {
      let current: FakeElement | null = element;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    getAttribute: (name) => element.attributes.get(name) ?? null,
    matches: (selector) => element.roles.has(selector),
    querySelector: (selector) => element.linkedDescendant?.matches(selector) ? element.linkedDescendant : null,
  };
  return element;
}

const selectors = {
  link: "link",
  detachedLink: "detached-link",
  editor: "editor",
  block: "block",
  staticContainer: "static",
};

describe("planMutationDiscovery", () => {
  it("observes only structural and Link identity changes", () => {
    expect(LINK_CONTENT_OBSERVER_OPTIONS).toEqual({
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-href", "href", "data-type"],
    });
    expect(LINK_CONTENT_OBSERVER_OPTIONS.characterData).toBeUndefined();
  });

  it("uses local discovery for added links and full discovery for removed links", () => {
    const editor = fakeElement("editor");
    const block = fakeElement("block");
    const link = fakeElement("link");
    block.parentElement = editor;
    link.parentElement = block;

    expect(planMutationDiscovery([{
      type: "childList",
      addedElements: [link],
      removedElements: [fakeElement("formatting")],
    }], selectors)).toEqual({ kind: "local", regions: [link] });

    expect(planMutationDiscovery([{
      type: "childList",
      addedElements: [],
      removedElements: [link],
    }], selectors)).toEqual({ kind: "full" });
  });

  it("recognizes a removed Link after it loses its container ancestor", () => {
    const detachedLink = fakeElement("detached-link");
    const detachedBlock = fakeElement("block");
    detachedBlock.linkedDescendant = detachedLink;

    expect(planMutationDiscovery([{
      type: "childList",
      addedElements: [],
      removedElements: [detachedLink],
    }], selectors)).toEqual({ kind: "full" });
    expect(planMutationDiscovery([{
      type: "childList",
      addedElements: [],
      removedElements: [detachedBlock],
    }], selectors)).toEqual({ kind: "full" });
  });

  it("uses attribute history to distinguish a new URL from a rewritten URL", () => {
    const editor = fakeElement("editor");
    const block = fakeElement("block");
    const link = fakeElement("link");
    block.parentElement = editor;
    link.parentElement = block;
    link.attributes.set("data-type", "a");
    link.attributes.set("data-href", "https://new.example");

    expect(planMutationDiscovery([{
      type: "attributes",
      target: link,
      attributeName: "data-href",
      oldValue: null,
    }], selectors)).toEqual({ kind: "local", regions: [link] });

    expect(planMutationDiscovery([{
      type: "attributes",
      target: link,
      attributeName: "data-href",
      oldValue: "https://old.example",
    }], selectors)).toEqual({ kind: "full" });
  });

  it("treats link token transitions as scope additions or departures", () => {
    const editor = fakeElement("editor");
    const block = fakeElement("block");
    const link = fakeElement("link");
    block.parentElement = editor;
    link.parentElement = block;
    link.attributes.set("data-type", "a");
    link.attributes.set("data-href", "https://example.test");

    expect(planMutationDiscovery([{
      type: "attributes",
      target: link,
      attributeName: "data-type",
      oldValue: null,
    }], selectors)).toEqual({ kind: "local", regions: [link] });

    link.attributes.set("data-type", "strong");
    expect(planMutationDiscovery([{
      type: "attributes",
      target: link,
      attributeName: "data-type",
      oldValue: "a",
    }], selectors)).toEqual({ kind: "full" });

    link.attributes.set("data-type", "strong em");
    expect(planMutationDiscovery([{
      type: "attributes",
      target: link,
      attributeName: "data-type",
      oldValue: "strong",
    }], selectors)).toBeNull();
  });

  it("lets a departed scope supersede additions regardless of record order", () => {
    const editor = fakeElement("editor");
    const block = fakeElement("block");
    const added = fakeElement("link");
    const removed = fakeElement("link");
    block.parentElement = editor;
    added.parentElement = block;
    removed.parentElement = block;

    const records = [
      { type: "childList" as const, addedElements: [added], removedElements: [] },
      { type: "childList" as const, addedElements: [], removedElements: [removed] },
    ];
    expect(planMutationDiscovery(records, selectors)).toEqual({ kind: "full" });
    expect(planMutationDiscovery(records.reverse(), selectors)).toEqual({ kind: "full" });
  });
});
