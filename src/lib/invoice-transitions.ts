import { InvoiceStatus } from "../types/enums";

/**
 * Terminal statuses in the invoice lifecycle from which no outgoing transitions are possible.
 * Once an invoice reaches one of these states, its lifecycle has completed.
 */
export const TERMINAL_INVOICE_STATUSES: readonly InvoiceStatus[] = Object.freeze([
  InvoiceStatus.SETTLED,
  InvoiceStatus.CANCELLED,
  InvoiceStatus.REJECTED,
  InvoiceStatus.FAILED,
]);

/**
 * Authoritative invoice status transition adjacency map.
 * Single source of truth shared between the Invoice entity and InvoiceStateMachine.
 *
 * Lifecycle flow:
 *   draft -> pending -> published -> funded -> settled (terminal)
 *   with draft -> published as direct self-serve publish,
 *   rejected reachable from draft/pending (terminal),
 *   cancelled as escape hatch before settlement (terminal),
 *   failed set by maturity job when underfunded at due date (terminal).
 */
export const INVOICE_TRANSITIONS_MAP: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = Object.freeze({
  [InvoiceStatus.DRAFT]: Object.freeze([
    InvoiceStatus.PENDING,
    InvoiceStatus.PUBLISHED,
    InvoiceStatus.REJECTED,
    InvoiceStatus.CANCELLED,
  ]),
  [InvoiceStatus.PENDING]: Object.freeze([
    InvoiceStatus.PUBLISHED,
    InvoiceStatus.REJECTED,
    InvoiceStatus.CANCELLED,
  ]),
  [InvoiceStatus.PUBLISHED]: Object.freeze([
    InvoiceStatus.FUNDED,
    InvoiceStatus.CANCELLED,
    InvoiceStatus.FAILED,
  ]),
  [InvoiceStatus.FUNDED]: Object.freeze([
    InvoiceStatus.SETTLED,
    InvoiceStatus.CANCELLED,
  ]),
  [InvoiceStatus.SETTLED]: Object.freeze([]),
  [InvoiceStatus.CANCELLED]: Object.freeze([]),
  [InvoiceStatus.REJECTED]: Object.freeze([]),
  [InvoiceStatus.FAILED]: Object.freeze([]),
});

/**
 * Backward-compatible alias for existing callers.
 */
export const VALID_INVOICE_TRANSITIONS = INVOICE_TRANSITIONS_MAP;

/**
 * Checks if a transition from current status to target status is topologically valid.
 * Pure state-only check with no actor-role or precondition validation.
 */
export function isValidInvoiceTransition(
  currentStatus: InvoiceStatus | null | undefined,
  targetStatus: InvoiceStatus | null | undefined
): boolean {
  if (!currentStatus || !targetStatus) {
    return false;
  }
  const allowed = INVOICE_TRANSITIONS_MAP[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(targetStatus);
}

/**
 * Returns the list of statuses reachable from `from`, in declaration order.
 * Returns an empty array for terminal states.
 */
export function allowedTransitionsFrom(from: InvoiceStatus): InvoiceStatus[] {
  const allowed = INVOICE_TRANSITIONS_MAP[from];
  return allowed ? [...allowed] : [];
}

/**
 * Returns true if the status is a terminal state (no outgoing transitions).
 */
export function isTerminalStatus(status: InvoiceStatus): boolean {
  return allowedTransitionsFrom(status).length === 0;
}

/**
 * Helper to detect divergences between any given transition map and the authoritative graph.
 * Returns an array of divergence descriptions, or empty array if they match.
 */
export function findTransitionDivergences(
  candidateGraph: Record<InvoiceStatus, readonly InvoiceStatus[]>
): string[] {
  const divergences: string[] = [];
  const allStatuses = Object.values(InvoiceStatus);

  for (const from of allStatuses) {
    const authoritative = INVOICE_TRANSITIONS_MAP[from] ?? [];
    const candidate = candidateGraph[from] ?? [];

    // Check for missing edges
    for (const to of authoritative) {
      if (!candidate.includes(to)) {
        divergences.push(`Missing transition: ${from} -> ${to}`);
      }
    }

    // Check for extra/illegal edges
    for (const to of candidate) {
      if (!authoritative.includes(to)) {
        divergences.push(`Divergent illegal transition: ${from} -> ${to}`);
      }
    }
  }

  return divergences;
}
