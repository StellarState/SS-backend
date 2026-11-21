import {
  allocateSettlementProceeds,
  reconcileProRataAllocations,
  type InvestorProRataAllocation,
} from "../../src/lib/investor-return";

describe("allocateSettlementProceeds (largest-remainder, #841)", () => {
  function scaled(amount: string): bigint {
    const [intPart, fracPart = ""] = amount.split(".");
    const scaledFrac = (fracPart + "0000").slice(0, 4);
    return BigInt(intPart) * 10000n + BigInt(scaledFrac);
  }

  function allocationOf(
    amount: string,
    investorId: string,
    investmentId: string
  ) {
    return {
      investmentAmountScaled: scaled(amount),
      investorId,
      investmentId,
    };
  }

  it("allocates exactly the total with zero remainder when it divides evenly", () => {
    const { allocations, unallocatedRemainderScaled } = allocateSettlementProceeds(
      [
        allocationOf("50.0000", "u-1", "inv-1"),
        allocationOf("50.0000", "u-2", "inv-2"),
      ],
      scaled("100.0000"),
      scaled("100.0000")
    );

    expect(unallocatedRemainderScaled).toBe(0n);
    expect(allocations).toHaveLength(2);
    for (const a of allocations) {
      expect(a.returnAmountScaled).toBe(scaled("50.0000"));
      expect(a.remainderShareScaled).toBe(0n);
    }
    expect(reconcileProRataAllocations(scaled("100.0000"), allocations)).toBe(true);
  });

  it("distributes the single leftover unit to the first investmentId on tied fractional remainders", () => {
    // 3 equal investors splitting 100.0000: base 33.3333 each, dust 0.0001
    // All fractions equal; tie-break by investmentId ascending -> inv-1 gets the dust
    const { allocations, unallocatedRemainderScaled } = allocateSettlementProceeds(
      [
        allocationOf("100.0000", "u-1", "inv-1"),
        allocationOf("100.0000", "u-2", "inv-2"),
        allocationOf("100.0000", "u-3", "inv-3"),
      ],
      scaled("100.0000"),
      scaled("300.0000")
    );

    expect(unallocatedRemainderScaled).toBe(0n);
    expect(allocations).toHaveLength(3);
    expect(allocations.find((a) => a.investmentId === "inv-1")?.returnAmountScaled).toBe(
      scaled("33.3334")
    );
    expect(allocations.find((a) => a.investmentId === "inv-2")?.returnAmountScaled).toBe(
      scaled("33.3333")
    );
    expect(allocations.find((a) => a.investmentId === "inv-3")?.returnAmountScaled).toBe(
      scaled("33.3333")
    );
    expect(allocations.find((a) => a.investmentId === "inv-1")?.remainderShareScaled).toBe(1n);
    expect(reconcileProRataAllocations(scaled("100.0000"), allocations)).toBe(true);
  });

  it("allocates so allocations always sum exactly to the total (no dust lost)", () => {
    const { allocations, unallocatedRemainderScaled } = allocateSettlementProceeds(
      [
        allocationOf("100.0000", "u-1", "inv-1"),
        allocationOf("200.0000", "u-2", "inv-2"),
        allocationOf("100.0000", "u-3", "inv-3"),
      ],
      scaled("10.0000"),
      scaled("400.0000")
    );

    expect(unallocatedRemainderScaled).toBe(0n);
    const sum = allocations.reduce((s, a) => s + a.returnAmountScaled, 0n);
    expect(sum).toBe(scaled("10.0000"));
    expect(reconcileProRataAllocations(scaled("10.0000"), allocations)).toBe(true);
  });

  it("gives everything to a single investor", () => {
    const { allocations, unallocatedRemainderScaled } = allocateSettlementProceeds(
      [allocationOf("100.0000", "u-1", "inv-1")],
      scaled("250.0000"),
      scaled("100.0000")
    );

    expect(unallocatedRemainderScaled).toBe(0n);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].returnAmountScaled).toBe(scaled("250.0000"));
    expect(reconcileProRataAllocations(scaled("250.0000"), allocations)).toBe(true);
  });

  it("returns nothing for no investors", () => {
    const { allocations, unallocatedRemainderScaled } = allocateSettlementProceeds(
      [],
      scaled("50.0000"),
      scaled("100.0000")
    );

    expect(allocations).toHaveLength(0);
    expect(unallocatedRemainderScaled).toBe(scaled("50.0000"));
  });

  it("is deterministic regardless of input order", () => {
    const base = [
      allocationOf("100.0000", "u-1", "inv-z"),
      allocationOf("100.0000", "u-2", "inv-a"),
      allocationOf("100.0000", "u-3", "inv-m"),
    ];
    const a = allocateSettlementProceeds(base, scaled("100.0000"), scaled("300.0000"));
    const b = allocateSettlementProceeds([...base].reverse(), scaled("100.0000"), scaled("300.0000"));

    expect(a.allocations).toEqual(b.allocations);
    const dustRecipient = (allocs: readonly InvestorProRataAllocation[]) =>
      allocs.find((x) => x.remainderShareScaled === 1n)?.investmentId;
    expect(dustRecipient(a.allocations)).toBe("inv-a");
    expect(dustRecipient(b.allocations)).toBe("inv-a");
    expect(reconcileProRataAllocations(scaled("100.0000"), a.allocations)).toBe(true);
  });

  it("throws on zero total funded", () => {
    expect(() =>
      allocateSettlementProceeds(
        [allocationOf("50.0000", "u-1", "inv-1")],
        scaled("50.0000"),
        0n
      )
    ).toThrow("totalFundedScaled must be greater than zero");
  });

  it("throws on negative total", () => {
    expect(() =>
      allocateSettlementProceeds(
        [allocationOf("50.0000", "u-1", "inv-1")],
        -1n,
        scaled("100.0000")
      )
    ).toThrow("totalScaled must not be negative");
  });
});

describe("reconcileProRataAllocations", () => {
  it("returns true when allocations sum to the total", () => {
    const { allocations } = allocateSettlementProceeds(
      [allocationOf("100.0000", "u-1", "inv-1"), allocationOf("100.0000", "u-2", "inv-2")],
      scaled("100.0000"),
      scaled("200.0000")
    );
    expect(reconcileProRataAllocations(scaled("100.0000"), allocations)).toBe(true);
  });

  it("returns false when allocations do not sum to the total", () => {
    const bad: InvestorProRataAllocation[] = [
      {
        investmentId: "inv-1",
        investorId: "u-1",
        baseReturnScaled: scaled("30.0000"),
        remainderShareScaled: 0n,
        returnAmountScaled: scaled("30.0000"),
      },
      {
        investmentId: "inv-2",
        investorId: "u-2",
        baseReturnScaled: scaled("30.0000"),
        remainderShareScaled: 0n,
        returnAmountScaled: scaled("30.0000"),
      },
    ];
    expect(reconcileProRataAllocations(scaled("100.0000"), bad)).toBe(false);
  });

  it("returns false when any allocation is negative", () => {
    const bad: InvestorProRataAllocation[] = [
      {
        investmentId: "inv-1",
        investorId: "u-1",
        baseReturnScaled: scaled("60.0000"),
        remainderShareScaled: 0n,
        returnAmountScaled: scaled("60.0000"),
      },
      {
        investmentId: "inv-2",
        investorId: "u-2",
        baseReturnScaled: scaled("40.0000"),
        remainderShareScaled: 0n,
        returnAmountScaled: -1n,
      },
    ];
    expect(reconcileProRataAllocations(scaled("100.0000"), bad)).toBe(false);
  });
});
