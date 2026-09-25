# Add a test to the core

Goal: check a budget rule with a test, watch it pass, and save it with a commit. You need the [getting started guide](../getting-started.md) completed up to section 7.

## 1. Find the right file

Tests live next to the code they check, with the same name plus `.test.ts`:

| Code | Test |
| --- | --- |
| `packages/core/src/money.ts` | `packages/core/src/money.test.ts` |
| `packages/core/src/budget/budget-month.ts` | `packages/core/src/budget/budget-month.test.ts` |

## 2. Write the test

Each test is an `it("what should happen", () => { ... })` block inside a `describe`. The pattern is always the same: arrange the data, act by calling the function, assert on the result.

Example: a refund must increase a category's available balance. Add it inside `describe("computeBudgetMonth", ...)` in `budget-month.test.ts`:

```ts
it("a refund increases the available balance", () => {
  // Arrange: €100 assigned, €30 spent, €10 refunded
  const input: BudgetInput = {
    categoryIds: ["fun"],
    income: [{ month: "2026-09", amount: 10000 }],
    assignments: [{ categoryId: "fun", month: "2026-09", amount: 10000 }],
    activity: [
      { categoryId: "fun", month: "2026-09", amount: -3000 },
      { categoryId: "fun", month: "2026-09", amount: 1000 },
    ],
  };

  // Act
  const result = computeBudgetMonth(input, "2026-09");

  // Assert: 100 − 30 + 10 = €80
  assert.equal(category(result.categories, "fun").available, 8000);
});
```

Remember: amounts are in cents, so €80 is written `8000`.

## 3. Run the tests

```bash
pnpm --filter @envelope/core test
```

Look for `# fail 0` in the final summary. When a test fails, the output shows the `expected` value and the `actual` one.

**Recommended counter-check:** temporarily change `8000` to `8001` and run again. The test must fail: if it still passed, it would not be checking anything. Then put `8000` back.

## 4. Check types

```bash
pnpm --filter @envelope/core typecheck
```

No output means no errors. A typical error: forgetting a required field, for example `month`, in an `Activity` object.

## 5. Save the change

```bash
git add packages/core/src/budget/budget-month.test.ts
git commit -m "Test: a refund increases the available balance"
git push
```

The CI on GitHub runs all the tests again.

## Exercise

Write a test checking that assigning a negative amount (taking money out of a category) **increases** ready to assign. Hint: start from the "rule 1" test and add a second, negative assignment to the same category.
