/**
 * Utility functions for account type checks
 */

export function isAgency(accountType: string | null | undefined): boolean {
  return accountType === 'BASIC_AGENCY' || accountType === 'MAX_AGENCY';
}

export function isBasicAgency(accountType: string | null | undefined): boolean {
  return accountType === 'BASIC_AGENCY';
}

export function isMaxAgency(accountType: string | null | undefined): boolean {
  return accountType === 'MAX_AGENCY';
}

export function isCreator(accountType: string | null | undefined): boolean {
  return accountType === 'CREATOR';
}
