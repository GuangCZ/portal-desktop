/** Mutable domain models publish a stable version; React owns all rendered DOM. */
import { publicErrorMessage } from '../../../shared/errors';
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
export const errorText = publicErrorMessage;
