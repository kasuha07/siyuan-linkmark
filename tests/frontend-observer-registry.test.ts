import { describe, expect, it } from "vitest";
import {
  LinkContentObserverRegistry,
  protyleContentContainers,
} from "../src/frontend-observer-registry";

type FakeObserver = { disconnect: () => void };

describe("LinkContentObserverRegistry", () => {
  it("returns both content containers exposed by a Protyle", () => {
    const editor = { id: "editor" };
    const preview = { id: "preview" };

    expect(protyleContentContainers({
      wysiwyg: { element: editor },
      preview: { previewElement: preview },
    })).toEqual([editor, preview]);
    expect(protyleContentContainers({})).toEqual([]);
  });

  it("registers each container once and disconnects it on removal", () => {
    const observers = new Map<string, FakeObserver>();
    const registry = new LinkContentObserverRegistry<string, FakeObserver>((container) => {
      const observer = { disconnect: () => observers.delete(container) };
      observers.set(container, observer);
      return observer;
    });

    expect(registry.register("editor")).toBe(true);
    expect(registry.register("editor")).toBe(false);
    expect([...registry.containers()]).toEqual(["editor"]);
    expect(registry.unregister("editor")).toBe(true);
    expect(registry.unregister("editor")).toBe(false);
    expect(observers.size).toBe(0);
  });

  it("disconnects all registered containers when destroyed", () => {
    const disconnected: string[] = [];
    const registry = new LinkContentObserverRegistry<string, FakeObserver>((container) => ({
      disconnect: () => disconnected.push(container),
    }));

    registry.register("editor");
    registry.register("preview");
    registry.destroy();

    expect(disconnected).toEqual(["editor", "preview"]);
    expect([...registry.containers()]).toEqual([]);
  });
});
