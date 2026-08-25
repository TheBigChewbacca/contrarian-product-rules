export type RuleType =
  | "pickup_only"
  | "preorder"
  | "prompt"
  | "graphic"
  | "custom";

export type RuleConditionOperator =
  | "equals"
  | "in"
  | "contains"
  | "gt"
  | "lt"
  | "exists";

export interface RuleCondition {
  id: string;
  field: string;
  operator: RuleConditionOperator;
  value: unknown;
}

export interface RuleAction {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface ProductRule {
  id: string;
  name: string;
  type: RuleType;
  priority: number;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface RuleSet {
  version: number;
  rules: ProductRule[];
}

export const DEFAULT_RULE_PRIORITY = 100;
export const DEFAULT_PICKUP_ONLY_MESSAGE =
  "This item is available for in-store pickup only.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeAction(action: unknown): RuleAction | null {
  if (!isRecord(action)) return null;
  const type = getString(action.type);
  if (!type) return null;

  const config = isRecord(action.config) ? action.config : {};

  return {
    id: getString(action.id, `action-${Math.random().toString(36).slice(2, 9)}`),
    type,
    config,
  };
}

function normalizeCondition(condition: unknown): RuleCondition | null {
  if (!isRecord(condition)) return null;
  const field = getString(condition.field);
  const operator = getString(condition.operator, "equals");
  if (!field) return null;

  return {
    id: getString(condition.id, `condition-${Math.random().toString(36).slice(2, 9)}`),
    field,
    operator: ["equals", "in", "contains", "gt", "lt", "exists"].includes(
      operator,
    )
      ? (operator as RuleConditionOperator)
      : "equals",
    value: condition.value,
  };
}

export function createPickupOnlyRule(
  enabled: boolean,
  message = DEFAULT_PICKUP_ONLY_MESSAGE,
): ProductRule {
  return {
    id: "pickup_only",
    name: "Pickup Only",
    type: "pickup_only",
    priority: DEFAULT_RULE_PRIORITY,
    enabled,
    conditions: [],
    actions: [
      {
        id: "pickup_only_banner",
        type: "show_banner",
        config: { message },
      },
    ],
  };
}

export function parseRuleSet(value: unknown): RuleSet | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed)) return null;

  if (Array.isArray(parsed.rules)) {
    const rules = parsed.rules
      .map((rule) => {
        if (!isRecord(rule)) return null;
        const type = getString(rule.type, "custom");
        const id = getString(rule.id);
        const name = getString(rule.name, type);
        const priority = typeof rule.priority === "number" ? rule.priority : DEFAULT_RULE_PRIORITY;
        const enabled = typeof rule.enabled === "boolean" ? rule.enabled : true;

        const conditions = Array.isArray(rule.conditions)
          ? rule.conditions.map(normalizeCondition).filter(Boolean)
          : [];
        const actions = Array.isArray(rule.actions)
          ? rule.actions.map(normalizeAction).filter(Boolean)
          : [];

        if (!id) return null;

        return {
          id,
          name,
          type: ["pickup_only", "preorder", "prompt", "graphic", "custom"].includes(type)
            ? (type as RuleType)
            : "custom",
          priority,
          enabled,
          conditions: conditions as RuleCondition[],
          actions: actions as RuleAction[],
        } satisfies ProductRule;
      })
      .filter((rule): rule is ProductRule => rule !== null);

    return { version: Number(parsed.version) || 1, rules };
  }

  if (isRecord(parsed.pickup_only) && typeof parsed.version === "number") {
    const pickupOnly = parsed.pickup_only;
    const enabled = typeof pickupOnly.enabled === "boolean" ? pickupOnly.enabled : false;
    const message =
      typeof pickupOnly.message === "string"
        ? pickupOnly.message
        : DEFAULT_PICKUP_ONLY_MESSAGE;

    return {
      version: parsed.version,
      rules: [createPickupOnlyRule(enabled, message)],
    };
  }

  return null;
}

export function normalizeRuleSet(
  value: unknown,
  legacyPickupOnly = false,
): RuleSet {
  const parsed = parseRuleSet(value);
  if (parsed) return parsed;

  return {
    version: 1,
    rules: [createPickupOnlyRule(legacyPickupOnly, DEFAULT_PICKUP_ONLY_MESSAGE)],
  };
}
