// How the conversation reaches Town. Registered in app/models/registry.ts;
// 2026-09-16.
//
// BeingDesktop 0.8.26's composer publishes an `@` mention to the bonfire itself,
// because there every bridge hangs off one `window.beingDesktop`
// (chat-composer.js `publish`). Here the conversation is handed `chat` and
// nothing else: `AppModel` constructs it that way and `app/models/app.ts` is not
// a file this unit may edit.
//
// The registry is the seam that answers it. A feature model is built with the
// whole `DesktopAPI`, so this one takes `townDesktop` from there and hands it to
// the conversation's directory — which is the only object that ever calls
// `speak`. Nothing else about the conversation depends on Town: without this
// model the menus, the notices and the warnings all still work, and only the
// publication is refused, in words that say so.
import { Store } from '../../shared/models/store';
import type { DesktopAPI } from '../../../shared/types';
import type { FeatureModel, FeatureModelFactory } from '../../app/models/registry';
import type { ConversationModel } from './conversation';

declare module '../../app/models/registry' {
  interface AppFeatureModels {
    /** No state of its own: it exists to connect two models the shell owns. */
    conversationMentions: ConversationMentions;
  }
}

export class ConversationMentions extends Store {
  constructor(private readonly api: DesktopAPI, private readonly app: unknown) { super(); }

  /** Called once, from `AppModel.start()`, with every built-in model built. */
  start(): () => void {
    const conversation = (this.app as { conversation?: ConversationModel } | null)?.conversation;
    const town = this.api?.townDesktop;
    if (!conversation || !town) return () => {};
    return conversation.directory.bindTown(town);
  }
}

export const conversationMentionsModel: FeatureModelFactory = {
  key: 'conversationMentions',
  create: (api, app): FeatureModel => new ConversationMentions(api, app),
};
