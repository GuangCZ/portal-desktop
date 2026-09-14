import { useSyncExternalStore } from "react";
import type { Store } from "../models/store";

export function useModel<T extends Store>(model: T): T {
  useSyncExternalStore(model.subscribe, model.getVersion);
  return model;
}
