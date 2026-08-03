/**
 * Minimal Plugin API surface used here. The current npm SDK declaration has
 * unrelated upstream errors, so this keeps local type checking deterministic.
 */
declare module "siyuan" {
  export type MenuItem = {
    checked?: boolean;
    label?: string;
    click?: () => void | Promise<void>;
    type?: "separator" | "submenu" | "readonly" | "empty";
    submenu?: MenuItem[];
  };

  export class Dialog {
    element: HTMLElement;
    constructor(options: {
      title?: string;
      content: string;
      width?: string;
      height?: string;
      destroyCallback?: () => void;
    });
    destroy(): void;
  }

  export class Menu {
    constructor(id?: string);
    addItem(options: MenuItem): HTMLElement;
    addSeparator(): HTMLElement;
    open(options: { x: number; y: number; isLeft?: boolean }): void;
  }

  export class Setting {
    constructor(options: { confirmCallback?: () => void | Promise<void> });
    addItem(options: {
      title: string;
      description?: string;
      createActionElement: () => HTMLElement;
    }): void;
  }

  export interface IProtyle {
    preview?: { previewElement: HTMLElement };
    wysiwyg?: { element: HTMLDivElement };
  }

  type ProtyleEventMap = {
    "destroy-protyle": { protyle: IProtyle };
    "loaded-protyle-dynamic": { protyle: IProtyle; position: "afterend" | "beforebegin" };
    "loaded-protyle-static": { protyle: IProtyle };
    "switch-protyle": { protyle: IProtyle };
    "switch-protyle-mode": { protyle: IProtyle };
  };

  export class EventBus {
    on<K extends keyof ProtyleEventMap>(
      type: K,
      listener: (event: CustomEvent<ProtyleEventMap[K]>) => unknown,
    ): void;
    off<K extends keyof ProtyleEventMap>(
      type: K,
      listener: (event: CustomEvent<ProtyleEventMap[K]>) => unknown,
    ): void;
  }

  export class Plugin {
    eventBus: EventBus;
    setting?: Setting;
    i18n: Record<string, any>;
    kernel?: {
      rpc: {
        call: Record<string, (...args: any[]) => Promise<any>>;
        bind: (name: string, handler: (params: any) => void | Promise<void>) => void;
      };
    };
    loadData<T = any>(name: string): Promise<T>;
    saveData(name: string, data: unknown): Promise<void>;
    addTopBar(options: {
      icon: string;
      title: string;
      callback: (event: MouseEvent) => void;
      position?: "right" | "left";
    }): HTMLElement;
    openSetting(): void;
  }

  export function confirm(
    title: string,
    text: string,
    confirmCallback?: (dialog: Dialog) => void,
    cancelCallback?: (dialog: Dialog) => void,
  ): void;
  export function showMessage(message: string): void;
}
