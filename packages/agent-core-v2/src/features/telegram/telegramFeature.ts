import { ScopeActivation } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ITelegramGatewayService, TelegramGatewayService } from './gateway';
import { ISessionTelegramBridge, SessionTelegramBridge } from './bridge';
import { ITelegramSendTool, TelegramSendTool, telegramConfigured } from './tools/telegramSend';

export class TelegramFeature extends Feature {
  static override readonly name = 'telegram';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, ITelegramGatewayService, TelegramGatewayService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, ISessionTelegramBridge, SessionTelegramBridge, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeTool(ITelegramSendTool, TelegramSendTool, {
      name: 'TelegramSend',
      domain: 'telegram',
      requiredRuntimeCapabilities: ['fs'],
      when: telegramConfigured,
    });
  }
}

registerFeature(TelegramFeature);
