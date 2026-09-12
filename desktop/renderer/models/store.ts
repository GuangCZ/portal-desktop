import { useSyncExternalStore } from "react";

/** Mutable domain models publish a stable version; React owns all rendered DOM. */
export class Store {
  private revision = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getVersion = () => this.revision;
  changed = () => {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  };
}
export function useModel<T extends Store>(model: T): T {
  useSyncExternalStore(model.subscribe, model.getVersion);
  return model;
}
export const errorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^(?:Error: )?Error invoking remote method '[^']+': Error: /,
    "",
  );
