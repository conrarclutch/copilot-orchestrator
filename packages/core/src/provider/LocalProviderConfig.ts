import type { ProviderInstanceConfigMap, ServerSettings } from '@t3tools/contracts';

/** The standalone runtime registers its Copilot instance explicitly. */
export const deriveProviderInstanceConfigMap = (settings: ServerSettings): ProviderInstanceConfigMap =>
  settings.providerInstances;
