import {
  DEFAULT_PICKUP_ONLY_MESSAGE,
  createPickupOnlyRule,
  parseRuleSet,
  type ProductRule,
  type RuleAction,
  type RuleCondition,
  type RuleSet,
} from "./rule-engine";

export const CURRENT_RULES_VERSION = 1;
export const DEFAULT_PREORDER_MESSAGE = "Preorder now available.";
export const DEFAULT_PREORDER_BADGE = "Preorder";

export interface RuleTarget {
  id: string;
  title: string;
  type: "product" | "collection" | "group";
}

export interface PickupOnlyRule {
  enabled: boolean;
  message: string;
}

export interface PreorderRule {
  enabled: boolean;
  releaseDate: string;
  message: string;
  badgeText: string;
  showCountdown: boolean;
}

export interface ProductRulesV1 {
  version: 1;
  pickup_only: PickupOnlyRule;
  preorder?: PreorderRule;
}

export function createRuleTarget(
  id: string,
  title: string,
  type: RuleTarget["type"] = "product",
): RuleTarget {
  return { id, title, type };
}

export function upsertRuleTarget(
  targets: RuleTarget[],
  incoming: RuleTarget,
): RuleTarget[] {
  const next = targets.filter((target) => target.id !== incoming.id);
  return [...next, incoming];
}

export function removeRuleTarget(
  targets: RuleTarget[],
  targetId: string,
): RuleTarget[] {
  return targets.filter((target) => target.id !== targetId);
}

export function mergeRuleTargets(
  existing: RuleTarget[],
  incoming: RuleTarget[],
): RuleTarget[] {
  const map = new Map<string, RuleTarget>();
  for (const target of [...existing, ...incoming]) {
    map.set(target.id, target);
  }
  return Array.from(map.values());
}

export { DEFAULT_PICKUP_ONLY_MESSAGE } from "./rule-engine";
export type { ProductRule, RuleAction, RuleCondition, RuleSet };

export function createDefaultPreorderRule(): PreorderRule {
  return {
    enabled: false,
    releaseDate: "",
    message: DEFAULT_PREORDER_MESSAGE,
    badgeText: DEFAULT_PREORDER_BADGE,
    showCountdown: false,
  };
}

export function createDefaultProductRules(): ProductRulesV1 {
  const legacyRule = createPickupOnlyRule(false, DEFAULT_PICKUP_ONLY_MESSAGE);
  return {
    version: CURRENT_RULES_VERSION,
    pickup_only: {
      enabled: legacyRule.enabled,
      message:
        typeof legacyRule.actions[0]?.config.message === "string"
          ? legacyRule.actions[0].config.message
          : DEFAULT_PICKUP_ONLY_MESSAGE,
    },
    preorder: createDefaultPreorderRule(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProductRules(value: unknown): ProductRulesV1 | null {
  let legacy = value;
  if (typeof value === "string") {
    try {
      legacy = JSON.parse(value);
    } catch {
      legacy = value;
    }
  }

  if (isRecord(legacy) && !Array.isArray(legacy.rules) && legacy.version === CURRENT_RULES_VERSION) {
    const pickupOnly = legacy.pickup_only;
    if (!isRecord(pickupOnly) || typeof pickupOnly.enabled !== "boolean") {
      return null;
    }

    const preorder = isRecord(legacy.preorder) ? legacy.preorder : null;

    return {
      version: CURRENT_RULES_VERSION,
      pickup_only: {
        enabled: pickupOnly.enabled,
        message:
          typeof pickupOnly.message === "string"
            ? pickupOnly.message
            : DEFAULT_PICKUP_ONLY_MESSAGE,
      },
      preorder: preorder
        ? {
            enabled: preorder.enabled === true,
            releaseDate: typeof preorder.releaseDate === "string" ? preorder.releaseDate : "",
            message: typeof preorder.message === "string" ? preorder.message : DEFAULT_PREORDER_MESSAGE,
            badgeText: typeof preorder.badgeText === "string" ? preorder.badgeText : DEFAULT_PREORDER_BADGE,
            showCountdown: preorder.showCountdown === true,
          }
        : createDefaultPreorderRule(),
    };
  }

  const parsed = parseRuleSet(value);
  if (!parsed) return null;

  const pickupOnly = parsed.rules.find((rule) => rule.type === "pickup_only");
  const preorderRule = parsed.rules.find((rule) => rule.type === "preorder");

  if (!pickupOnly) return null;

  const bannerAction = pickupOnly.actions.find((action) => action.type === "show_banner");
  const message =
    typeof bannerAction?.config.message === "string"
      ? bannerAction.config.message
      : DEFAULT_PICKUP_ONLY_MESSAGE;

  return {
    version: CURRENT_RULES_VERSION,
    pickup_only: {
      enabled: pickupOnly.enabled,
      message,
    },
    preorder: preorderRule
      ? {
          enabled: preorderRule.enabled,
          releaseDate:
            typeof preorderRule.actions[0]?.config.releaseDate === "string"
              ? preorderRule.actions[0].config.releaseDate
              : "",
          message:
            typeof preorderRule.actions[0]?.config.message === "string"
              ? preorderRule.actions[0].config.message
              : DEFAULT_PREORDER_MESSAGE,
          badgeText:
            typeof preorderRule.actions[0]?.config.badgeText === "string"
              ? preorderRule.actions[0].config.badgeText
              : DEFAULT_PREORDER_BADGE,
          showCountdown: preorderRule.actions[0]?.config.showCountdown === true,
        }
      : createDefaultPreorderRule(),
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
