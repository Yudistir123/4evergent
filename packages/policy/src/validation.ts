import type { PolicyRules } from "@4evergent/shared";
import { parseStrictAmount } from "./amount.js";

/**
 * Policy validation result.
 */
export interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Supported transaction types for txTypeRestrictions.
 */
const SUPPORTED_TX_TYPES = ["payment", "trustline", "contract_call", "account_settings"];

/**
 * Validates a policy configuration object.
 *
 * Rules:
 * - Numeric values must be finite and non-negative
 * - maxTxAmount values must be positive where present
 * - dailySpendingLimit values must be positive where present
 * - approvalThreshold must be positive if provided
 * - allowedAssets must be non-empty strings
 * - allowedDestinations must be valid Stellar addresses (G...) if present
 * - allowedContractIds must be non-empty strings if present
 * - txTypeRestrictions keys must be supported transaction types
 * - txTypeRestrictions values must be booleans
 */
export function validatePolicyRules(rules: any): PolicyValidationResult {
  const errors: string[] = [];

  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return { valid: false, errors: ["Policy must be an object"] };
  }

  // Validate maxTxAmount
  if (rules.maxTxAmount !== undefined) {
    if (typeof rules.maxTxAmount !== "object" || rules.maxTxAmount === null) {
      errors.push("maxTxAmount must be an object");
    } else {
      for (const [asset, amount] of Object.entries(rules.maxTxAmount)) {
        if (typeof amount !== "string" && typeof amount !== "number") {
          errors.push(`maxTxAmount.${asset} must be a string or number`);
        } else {
          const num = parseStrictAmount(amount);
          if (num === null || num <= 0) {
            errors.push(`maxTxAmount.${asset} must be a positive number, got ${amount}`);
          }
        }
      }
    }
  }

  // Validate dailySpendingLimit
  if (rules.dailySpendingLimit !== undefined) {
    if (typeof rules.dailySpendingLimit !== "object" || rules.dailySpendingLimit === null) {
      errors.push("dailySpendingLimit must be an object");
    } else {
      for (const [asset, limit] of Object.entries(rules.dailySpendingLimit)) {
        if (typeof limit !== "string" && typeof limit !== "number") {
          errors.push(`dailySpendingLimit.${asset} must be a string or number`);
        } else {
          const num = parseStrictAmount(limit);
          if (num === null || num < 0) {
            errors.push(`dailySpendingLimit.${asset} must be a non-negative number, got ${limit}`);
          }
        }
      }
    }
  }

  // Validate approvalThreshold
  if (rules.approvalThreshold !== undefined && rules.approvalThreshold !== null) {
    if (typeof rules.approvalThreshold !== "string" && typeof rules.approvalThreshold !== "number") {
      errors.push("approvalThreshold must be a string or number");
    } else {
      const num = parseStrictAmount(rules.approvalThreshold);
      if (num === null || num < 0) {
        errors.push(`approvalThreshold must be a non-negative number, got ${rules.approvalThreshold}`);
      }
    }
  }

  // Validate requireHumanApprovalForAmountAbove (alias for approvalThreshold)
  if (rules.requireHumanApprovalForAmountAbove !== undefined && rules.requireHumanApprovalForAmountAbove !== null) {
    if (typeof rules.requireHumanApprovalForAmountAbove !== "string" && typeof rules.requireHumanApprovalForAmountAbove !== "number") {
      errors.push("requireHumanApprovalForAmountAbove must be a string or number");
    } else {
      const num = parseStrictAmount(rules.requireHumanApprovalForAmountAbove);
      if (num === null || num < 0) {
        errors.push(`requireHumanApprovalForAmountAbove must be a non-negative number, got ${rules.requireHumanApprovalForAmountAbove}`);
      }
    }
  }

  // Validate allowedAssets
  if (rules.allowedAssets !== undefined) {
    if (!Array.isArray(rules.allowedAssets)) {
      errors.push("allowedAssets must be an array");
    } else {
      for (let i = 0; i < rules.allowedAssets.length; i++) {
        const asset = rules.allowedAssets[i];
        if (typeof asset !== "string" || asset.trim() === "") {
          errors.push(`allowedAssets[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // Validate allowedDestinations
  if (rules.allowedDestinations !== undefined) {
    if (!Array.isArray(rules.allowedDestinations)) {
      errors.push("allowedDestinations must be an array");
    } else {
      for (let i = 0; i < rules.allowedDestinations.length; i++) {
        const dest = rules.allowedDestinations[i];
        if (typeof dest !== "string" || !dest.startsWith("G") || dest.length !== 56) {
          errors.push(`allowedDestinations[${i}] must be a valid Stellar address (G...), got "${dest}"`);
        }
      }
    }
  }

  // Validate allowedContractIds
  if (rules.allowedContractIds !== undefined) {
    if (!Array.isArray(rules.allowedContractIds)) {
      errors.push("allowedContractIds must be an array");
    } else {
      for (let i = 0; i < rules.allowedContractIds.length; i++) {
        const id = rules.allowedContractIds[i];
        if (typeof id !== "string" || id.trim() === "") {
          errors.push(`allowedContractIds[${i}] must be a non-empty string`);
        }
      }
    }
  }

  // Validate txTypeRestrictions
  if (rules.txTypeRestrictions !== undefined) {
    if (typeof rules.txTypeRestrictions !== "object" || rules.txTypeRestrictions === null) {
      errors.push("txTypeRestrictions must be an object");
    } else {
      for (const [type, allowed] of Object.entries(rules.txTypeRestrictions)) {
        if (!SUPPORTED_TX_TYPES.includes(type)) {
          errors.push(`txTypeRestrictions.${type} is not a supported transaction type`);
        }
        if (typeof allowed !== "boolean") {
          errors.push(`txTypeRestrictions.${type} must be a boolean`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normalizes a partial policy input into a complete PolicyRules object.
 *
 * Fills in DEFAULT_RULES for any missing fields.
 */
export function normalizePolicyRules(partial: Partial<PolicyRules>): PolicyRules {
  const DEFAULT_RULES: PolicyRules = {
    maxTxAmount: { XLM: "100" },
    dailySpendingLimit: { XLM: "500" },
    allowedAssets: ["XLM"],
    allowedDestinations: [],
    allowedContractIds: [],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      contract_call: false,
      account_settings: false,
    },
    approvalThreshold: "50",
    requireHumanApprovalForAmountAbove: "50",
  };

  return {
    maxTxAmount: { ...DEFAULT_RULES.maxTxAmount, ...partial.maxTxAmount },
    dailySpendingLimit: { ...DEFAULT_RULES.dailySpendingLimit, ...partial.dailySpendingLimit },
    allowedAssets: partial.allowedAssets ?? DEFAULT_RULES.allowedAssets,
    allowedDestinations: partial.allowedDestinations ?? DEFAULT_RULES.allowedDestinations,
    allowedContractIds: partial.allowedContractIds ?? DEFAULT_RULES.allowedContractIds,
    txTypeRestrictions: { ...DEFAULT_RULES.txTypeRestrictions, ...partial.txTypeRestrictions },
    approvalThreshold: partial.approvalThreshold ?? partial.requireHumanApprovalForAmountAbove ?? DEFAULT_RULES.approvalThreshold,
    requireHumanApprovalForAmountAbove: partial.requireHumanApprovalForAmountAbove ?? partial.approvalThreshold ?? DEFAULT_RULES.requireHumanApprovalForAmountAbove,
  };
}
