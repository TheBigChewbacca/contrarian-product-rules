export const CURRENT_RULES_VERSION = 1;
export const DEFAULT_PICKUP_ONLY_MESSAGE =
  "This item is available for in-store pickup only.";

export interface PickupOnlyRule {
  enabled: boolean;
  message: string;
}

export interface ProductRulesV1 {
  version: 1;
  pickup_only: PickupOnlyRule;
}

export function createDefaultProductRules(): ProductRulesV1 {
  return {
    version: CURRENT_RULES_VERSION,
    pickup_only: { enabled: false, message: DEFAULT_PICKUP_ONLY_MESSAGE },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProductRules(value: unknown): ProductRulesV1 | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed) || parsed.version !== CURRENT_RULES_VERSION)
    return null;
  const pickupOnly = parsed.pickup_only;
  if (!isRecord(pickupOnly) || typeof pickupOnly.enabled !== "boolean")
    return null;

  return {
    version: CURRENT_RULES_VERSION,
    pickup_only: {
      enabled: pickupOnly.enabled,
      message:
        typeof pickupOnly.message === "string"
          ? pickupOnly.message
          : DEFAULT_PICKUP_ONLY_MESSAGE,
    },
  };
}

export function normalizeProductRules(
  value: unknown,
  legacyPickupOnly = false,
): ProductRulesV1 {
  const parsed = parseProductRules(value);
  if (parsed) return parsed;
  const defaults = createDefaultProductRules();
  defaults.pickup_only.enabled = legacyPickupOnly;
  return defaults;
}
