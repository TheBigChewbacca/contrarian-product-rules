export type RuleKey = "pickup_only" | "preorder" | "prompt" | "graphic";

export interface RuleDefinition {
  key: RuleKey;
  label: string;
  description: string;
  enabledByDefault: boolean;
}

export const RULE_DEFINITIONS: RuleDefinition[] = [
  {
    key: "pickup_only",
    label: "Pickup Only",
    description: "Display a pickup-only warning and block shipping checkout flows.",
    enabledByDefault: false,
  },
  {
    key: "preorder",
    label: "Preorder",
    description: "Show release dates, badges, and shopping prompts for upcoming products.",
    enabledByDefault: false,
  },
  {
    key: "prompt",
    label: "Prompt",
    description: "Display a cart prompt or confirmation before purchase.",
    enabledByDefault: false,
  },
  {
    key: "graphic",
    label: "Graphic",
    description: "Attach storefront graphics or badges to products and collections.",
    enabledByDefault: false,
  },
];

export function getRuleDefinitions(): RuleDefinition[] {
  return [...RULE_DEFINITIONS];
}

export function isRuleKey(value: unknown): value is RuleKey {
  return typeof value === "string" && RULE_DEFINITIONS.some((rule) => rule.key === value);
}

export function getRuleDefinition(key: string): RuleDefinition | undefined {
  return RULE_DEFINITIONS.find((rule) => rule.key === key);
}
