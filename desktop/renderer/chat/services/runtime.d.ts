import type { ChatState, ChatRuntime, RuntimeOptions } from "../models/chat";
export function createChatRuntime(
  state: ChatState,
  options?: RuntimeOptions,
): ChatRuntime;
