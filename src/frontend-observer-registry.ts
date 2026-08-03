export type DisconnectableObserver = {
  disconnect: () => void;
};

export type ProtyleContent<Container> = {
  preview?: { previewElement: Container };
  wysiwyg?: { element: Container };
};

export function protyleContentContainers<Container>(protyle: ProtyleContent<Container>) {
  const containers: Container[] = [];
  if (protyle.wysiwyg) containers.push(protyle.wysiwyg.element);
  if (protyle.preview) containers.push(protyle.preview.previewElement);
  return containers;
}

export class LinkContentObserverRegistry<Container, Observer extends DisconnectableObserver> {
  private readonly observers = new Map<Container, Observer>();

  constructor(private readonly createObserver: (container: Container) => Observer) {}

  register(container: Container) {
    if (this.observers.has(container)) return false;
    this.observers.set(container, this.createObserver(container));
    return true;
  }

  unregister(container: Container) {
    const observer = this.observers.get(container);
    if (!observer) return false;
    this.observers.delete(container);
    observer.disconnect();
    return true;
  }

  containers() {
    return this.observers.keys();
  }

  destroy() {
    for (const container of [...this.observers.keys()]) this.unregister(container);
  }
}
