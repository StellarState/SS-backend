import { Invoice } from "../../src/models/Invoice.model";
import {
  allowedTransitionsFrom,
  isTerminalStatus,
  isValidInvoiceTransition,
  TERMINAL_INVOICE_STATUSES,
  INVOICE_TRANSITIONS_MAP,
  VALID_INVOICE_TRANSITIONS,
  findTransitionDivergences,
} from "../../src/lib/invoice-transitions";
import { InvoiceStatus } from "../../src/types/enums";
import { AppError } from "../../src/utils/http-error";

describe("Unified invoice transition graph and full status matrix (issue #731)", () => {
  const ALL_STATUSES = Object.values(InvoiceStatus);

  describe("Acceptance Criteria 1: State-only helpers and allowedTransitionsFrom agree for every status pair", () => {
    it("agrees across the entire 8x8 status matrix between Invoice.isValidTransition and allowedTransitionsFrom", () => {
      for (const from of ALL_STATUSES) {
        const allowedList = allowedTransitionsFrom(from);
        for (const to of ALL_STATUSES) {
          const expectedValid = allowedList.includes(to);
          const entityValid = Invoice.isValidTransition(from, to);
          const helperValid = isValidInvoiceTransition(from, to);

          expect(entityValid).toBe(expectedValid);
          expect(helperValid).toBe(expectedValid);
        }
      }
    });

    it("shares the identical transition map reference", () => {
      expect(VALID_INVOICE_TRANSITIONS).toBe(INVOICE_TRANSITIONS_MAP);
    });
  });

  describe("Acceptance Criteria 2: Draft-to-pending is recognized consistently", () => {
    it("recognizes DRAFT -> PENDING across all helpers", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.DRAFT, InvoiceStatus.PENDING)).toBe(true);
      expect(isValidInvoiceTransition(InvoiceStatus.DRAFT, InvoiceStatus.PENDING)).toBe(true);
      expect(allowedTransitionsFrom(InvoiceStatus.DRAFT)).toContain(InvoiceStatus.PENDING);
    });

    it("allows transitioning an invoice from DRAFT to PENDING via Invoice.transitionTo", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.DRAFT;

      Invoice.transitionTo(invoice, InvoiceStatus.PENDING);
      expect(invoice.status).toBe(InvoiceStatus.PENDING);
    });
  });

  describe("Acceptance Criteria 3: Settled cannot transition to cancelled through entity helpers", () => {
    it("rejects SETTLED -> CANCELLED via Invoice.isValidTransition and helper", () => {
      expect(Invoice.isValidTransition(InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED)).toBe(false);
      expect(isValidInvoiceTransition(InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED)).toBe(false);
      expect(allowedTransitionsFrom(InvoiceStatus.SETTLED)).not.toContain(InvoiceStatus.CANCELLED);
    });

    it("throws AppError 400 when attempting Invoice.transitionTo(SETTLED, CANCELLED)", () => {
      const invoice = new Invoice();
      invoice.status = InvoiceStatus.SETTLED;

      expect(() => Invoice.transitionTo(invoice, InvoiceStatus.CANCELLED)).toThrow(AppError);
      try {
        Invoice.transitionTo(invoice, InvoiceStatus.CANCELLED);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).code).toBe("INVALID_STATUS_TRANSITION");
      }
    });

    it("treats SETTLED as a terminal state with zero outgoing transitions", () => {
      expect(isTerminalStatus(InvoiceStatus.SETTLED)).toBe(true);
      expect(allowedTransitionsFrom(InvoiceStatus.SETTLED)).toEqual([]);
      expect(TERMINAL_INVOICE_STATUSES).toContain(InvoiceStatus.SETTLED);
    });
  });

  describe("Acceptance Criteria 5: Sharing the graph introduces no circular entity/service import", () => {
    it("verifies Invoice and invoice-transitions modules load cleanly without undefined exports", () => {
      expect(typeof Invoice.isValidTransition).toBe("function");
      expect(typeof Invoice.transitionTo).toBe("function");
      expect(typeof isValidInvoiceTransition).toBe("function");
      expect(typeof allowedTransitionsFrom).toBe("function");
      expect(typeof isTerminalStatus).toBe("function");
      expect(INVOICE_TRANSITIONS_MAP).toBeDefined();
    });
  });

  describe("Acceptance Criteria 6: A full status matrix detects a deliberately divergent transition fixture", () => {
    it("reports zero divergences against the authoritative graph", () => {
      const divergences = findTransitionDivergences(INVOICE_TRANSITIONS_MAP);
      expect(divergences).toHaveLength(0);
    });

    it("detects deliberately divergent transition fixtures (e.g. legacy entity map)", () => {
      // Legacy entity fixture had omitted DRAFT -> PENDING and allowed SETTLED -> CANCELLED
      const legacyDivergentFixture: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
        [InvoiceStatus.DRAFT]: [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED, InvoiceStatus.REJECTED],
        [InvoiceStatus.PENDING]: [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED, InvoiceStatus.REJECTED],
        [InvoiceStatus.PUBLISHED]: [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED, InvoiceStatus.FAILED],
        [InvoiceStatus.FUNDED]: [InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED],
        [InvoiceStatus.SETTLED]: [InvoiceStatus.CANCELLED], // Divergence: illegal edge
        [InvoiceStatus.CANCELLED]: [],
        [InvoiceStatus.REJECTED]: [],
        [InvoiceStatus.FAILED]: [],
      };

      const divergences = findTransitionDivergences(legacyDivergentFixture);

      // Must detect both the missing DRAFT -> PENDING and the illegal SETTLED -> CANCELLED
      expect(divergences).toContain("Missing transition: draft -> pending");
      expect(divergences).toContain("Divergent illegal transition: settled -> cancelled");
      expect(divergences.length).toBeGreaterThanOrEqual(2);
    });

    it("detects arbitrary extra and missing edges across the matrix", () => {
      const mockBrokenGraph: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
        ...INVOICE_TRANSITIONS_MAP,
        [InvoiceStatus.CANCELLED]: [InvoiceStatus.DRAFT], // Illegal revival
        [InvoiceStatus.DRAFT]: [], // Missing all transitions
      };

      const divergences = findTransitionDivergences(mockBrokenGraph);
      expect(divergences).toContain("Divergent illegal transition: cancelled -> draft");
      expect(divergences).toContain("Missing transition: draft -> pending");
      expect(divergences).toContain("Missing transition: draft -> published");
    });
  });
});
