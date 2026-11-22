import { describe, it, expect } from '@jest/globals';
import { CommandFactory } from './command.factory';
import { GetAllStoreProductsCommand } from './get-all-store-products.command';

const factory = new CommandFactory();

describe('Store flat query validation', () => {
  it('preserves false and zero while accepting an empty query', async () => {
    const query = await factory.create(GetAllStoreProductsCommand, {
      productShowing: false,
      variantShowing: false,
      quantityMin: 0,
      quantityMax: 0,
      reservedMax: 0,
      availableMax: 0,
    });
    expect(query).toMatchObject({
      productShowing: false,
      variantShowing: false,
      quantityMin: 0,
      quantityMax: 0,
      reservedMax: 0,
      availableMax: 0,
    });
    await expect(factory.create(GetAllStoreProductsCommand, {})).resolves.toBeInstanceOf(GetAllStoreProductsCommand);
  });
  it.each([
    { brandCode: '' },
    { brandCode: null },
    { brandCode: ['apple', 1] },
    { brandCode: 'a'.repeat(257) },
    { categoryUuid: '' },
    { categoryUuid: 'not-a-uuid' },
    { categoryUuid: null },
    { categoryUuid: ['be250838-85f9-41fa-b9f3-99aba3590640', 'invalid'] },
    { categoryUuid: [null] },
    { categoryUuid: { uuid: 'be250838-85f9-41fa-b9f3-99aba3590640' } },
    { quantityMin: -1 },
    { reservedMax: 1.5 },
    { availableMin: '1' },
    { quantityMin: 5, quantityMax: 4 },
    { reservedMin: 2, reservedMax: 0 },
    { availableMin: 2, availableMax: 1 },
    { productShowing: 'false' },
    { variantShowing: null },
    { productStatus: 'draft' },
    { variantStatus: 'deleted' },
  ])('rejects malformed or contradictory filters: %j', async (query) => {
    await expect(factory.create(GetAllStoreProductsCommand, query)).rejects.toThrow();
  });
  it('preserves the selected category in the query', async () => {
    const categoryUuid = 'be250838-85f9-41fa-b9f3-99aba3590640';
    for (const value of [categoryUuid, [categoryUuid], [categoryUuid, categoryUuid], []]) {
      await expect(factory.create(GetAllStoreProductsCommand, { categoryUuid: value })).resolves.toMatchObject({
        categoryUuid: value,
      });
    }
  });
  it('accepts one or several exact brand codes', async () => {
    for (const brandCode of ['apple', ['apple', 'samsung'], []]) {
      await expect(factory.create(GetAllStoreProductsCommand, { brandCode })).resolves.toMatchObject({ brandCode });
    }
  });
});
