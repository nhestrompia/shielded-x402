import assert from "assert";
import generated from "generated";
import type { ShieldedPool_Deposited } from "generated";
const { TestHelpers } = generated as typeof import("generated");
const { MockDb, ShieldedPool } = TestHelpers;

describe("ShieldedPool contract Deposited event tests", () => {
  // Create mock db
  const mockDb = MockDb.createMockDb();

  // Creating mock for ShieldedPool contract Deposited event
  const event = ShieldedPool.Deposited.createMockEvent({/* It mocks event fields with default values. You can overwrite them if you need */});

  it("ShieldedPool_Deposited is created correctly", async () => {
    // Processing the event
    const mockDbUpdated = await ShieldedPool.Deposited.processEvent({
      event,
      mockDb,
    });

    // Getting the actual entity from the mock database
    let actualShieldedPoolDeposited = mockDbUpdated.entities.ShieldedPool_Deposited.get(
      `${event.chainId}_${event.block.number}_${event.logIndex}`
    );

    // Creating the expected entity
    const expectedShieldedPoolDeposited: ShieldedPool_Deposited = {
      id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
      commitment: event.params.commitment,
      leafIndex: event.params.leafIndex,
      root: event.params.root,
      amount: event.params.amount,
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualShieldedPoolDeposited, expectedShieldedPoolDeposited, "Actual ShieldedPoolDeposited should be the same as the expectedShieldedPoolDeposited");
  });
});
