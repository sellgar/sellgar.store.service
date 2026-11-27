import 'reflect-metadata';
import { catalogArchives } from './catalog-archives.fixture';

import { CursorPagination } from '@sellgar/pagination';
import { OutboxWriter } from '@sellgar/outbox';
import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { config } from 'dotenv';

import { STORE_OUTBOX_OPTIONS } from '../src/integration/outbox/store-outbox.options';
import { StoreProductCategoryRepository } from '../src/api/v1/store-product/repository/store-product-category.repository';
import { StoreDatabaseOptions } from '../src/database/store-database.options';
import { StoreProductRepository } from '../src/api/v1/store-product/repository/store-product.repository';
import { StoreProductQueryRepository } from '../src/api/v1/store-product/repository/store-product-query.repository';
import { StoreOfferRepository } from '../src/api/v1/store-product/repository/store-offer.repository';
import { AccountingRecordRepository } from '../src/api/v1/store-product/repository/accounting-record.repository';
import { CommandRequestRepository } from '../src/api/v1/store-product/repository/command-request.repository';
import { StoreEventRepository } from '../src/api/v1/store-product/repository/store-event.repository';
import { InventoryRepository } from '../src/api/v1/store-product/repository/inventory.repository';
import { StoreProductService } from '../src/api/v1/store-product/service/store-product.service';
import { CommandFactory } from '../src/api/v1/store-product/service/command/command.factory';
import { SnapshotEventService } from '../src/api/v1/store-product/service/snapshot-event.service';
import { ProductSnapshotPayloadDto } from '../src/api/v1/store-product/service/dto/product-snapshot-payload.dto';
import { IntegrationEventDto } from '../src/api/v1/store-product/service/dto/integration-event.dto';
import { StoreProductStatus } from '../src/api/v1/store-product/enum/store-product-status.enum';
import { StoreOfferStatus } from '../src/api/v1/store-product/enum/store-offer-status.enum';
import { StoreProductEntity } from '../src/api/v1/store-product/entity';

config({ path: '.env', quiet: true });

// The suite owns only this randomly named schema, never public tables.
describe('Accounting records in PostgreSQL', () => {
  const schema = `store_test_${randomUUID().replace(/-/g, '')}`;
  const productUuid = randomUUID(),
    variantUuid = randomUUID(),
    secondVariantUuid = randomUUID(),
    shopUuid = randomUUID();
  let source: DataSource;
  let service: StoreProductService;
  let snapshots: SnapshotEventService;
  let product: StoreProductEntity;
  const input = () => ({
    commandId: randomUUID(),
    shopUuid,
    productUuid,
    showing: true,
    offers: [{ variantUuid, showing: true, records: [{ currentPrice: { value: '125.5', currencyCode: 'RUB' } }] }],
  });
  const event = (
    uuid: string,
    version: number,
    status = 'active',
    variants: { uuid: string; name: string; status: string }[] = [
      { uuid: variantUuid, name: 'Синяя', status },
      { uuid: secondVariantUuid, name: 'Зеленая', status: 'active' },
    ],
  ) =>
    plainToInstance(IntegrationEventDto, {
      eventUuid: randomUUID(),
      eventType: 'product.updated',
      schemaVersion: 3,
      producer: 'product_srv',
      aggregateType: 'product',
      aggregateId: uuid,
      aggregateVersion: version,
      occurredAt: new Date().toISOString(),
      payload: { uuid, version, name: 'Майка', status, variants },
    });
  beforeAll(async () => {
    const control = await new DataSource({
      ...StoreDatabaseOptions.create(process.env),
      entities: [],
      migrations: [],
    }).initialize();
    await control.query(`CREATE SCHEMA "${schema}"`);
    await control.destroy();
    source = await new DataSource(
      StoreDatabaseOptions.create({ ...process.env, STORE_DATABASE_SCHEMA: schema }),
    ).initialize();
    await source.runMigrations();
    const commands = new CommandRequestRepository(source),
      events = new StoreEventRepository(new OutboxWriter(STORE_OUTBOX_OPTIONS)),
      queries = new StoreProductQueryRepository(
        source,
        new StoreProductCategoryRepository(),
        new CursorPagination('test-pagination-key-at-least-32-bytes'),
      );
    const repository = new StoreProductRepository(
      commands,
      new StoreOfferRepository(new AccountingRecordRepository()),
      queries,
      events,
      new StoreProductCategoryRepository(),
    );
    service = new StoreProductService(
      repository,
      queries,
      new InventoryRepository(commands, events),
      new CommandFactory(),
    );
    snapshots = new SnapshotEventService(source, catalogArchives(source));
    await source.query(`INSERT INTO currency(code,value) VALUES ('RUB','Российский рубль')`);
    await source.query(`INSERT INTO shop_snapshot(shop_uuid,source_version,name) VALUES ($1,1,'Магазин')`, [shopUuid]);
    await snapshots.apply(event(productUuid, 1));
  });
  afterAll(async () => {
    if (source?.isInitialized) {
      await source.query(`DROP SCHEMA "${schema}" CASCADE`);
      await source.destroy();
    }
  });
  it('keeps the migrated schema consistent with ORM metadata', async () => {
    const changes = await source.driver.createSchemaBuilder().log();
    expect(changes.upQueries.map((query) => query.query)).toEqual([]);
  });
  it('creates one priced record and no parent articles', async () => {
    product = await service.create(input());
    expect(product).not.toHaveProperty('article');
    expect(product.offers[0]).not.toHaveProperty('article');
    expect(product.offers[0].records).toHaveLength(1);
    expect(product.offers[0].records[0].article).toMatch(/^SKU-/);
    expect(product.offers[0].records[0].order).toBe(0);
    expect(product.offers[0].records[0].clarifications).toEqual([]);
    expect(product.offers[0].records[0].inventory.quantity).toBe(0);
    expect(product.offers[0].records[0].currentPrice.value).toBe('125.50');
  });
  it('resolves a full Store Product by accounting record UUID without storefront filters', async () => {
    const record = product.offers[0].records[0];
    const result = await service.getByRecordUuid(record.uuid);
    expect(result.uuid).toBe(product.uuid);
    expect(result.offers[0].records[0].uuid).toBe(record.uuid);
    expect(result.offers[0].records[0].inventory.available).toBe(0);
    await expect(service.getByRecordUuid(randomUUID())).rejects.toThrow('Accounting record not found');
  });

  it('concretizes the initial record and adds another without copying stock', async () => {
    const record = product.offers[0].records[0];
    await service.receiptInventory({
      commandId: randomUUID(),
      recordUuid: record.uuid,
      expectedVersion: 1,
      quantity: 12,
    });
    product = await service.update({
      commandId: randomUUID(),
      uuid: product.uuid,
      expectedVersion: product.version,
      offers: [
        {
          uuid: product.offers[0].uuid,
          variantUuid,
          showing: true,

          records: [
            {
              currentPrice: { value: '125.50', currencyCode: 'RUB' },
              uuid: record.uuid,
              article: 'BLUE-S',
              clarifications: [{ value: 'S евростандарт' }],
            },
            {
              currentPrice: { value: '125.50', currencyCode: 'RUB' },
              article: 'BLUE-L',
              clarifications: [{ value: 'L евростандарт' }],
            },
          ],
        },
      ],
    });
    expect(product.offers[0].records).toHaveLength(2);
    expect(product.offers[0].records.map((record) => record.order)).toEqual([0, 1]);
    const small = product.offers[0].records.find((item) => item.article === 'BLUE-S');
    const large = product.offers[0].records.find((item) => item.article === 'BLUE-L');
    expect(small.inventory.quantity).toBe(12);
    expect(large.inventory.quantity).toBe(0);
    expect(small.clarifications[0]).toMatchObject({ value: 'S евростандарт' });
    expect(small.clarifications[0]).not.toHaveProperty('name');
  });
  it('prices records independently, keeps their histories and summarizes only matching records', async () => {
    const offer = product.offers[0];
    const small = offer.records.find((record) => record.article === 'BLUE-S')!;
    const large = offer.records.find((record) => record.article === 'BLUE-L')!;
    const originalPrice = small.currentPrice!.uuid;
    const command = {
      commandId: randomUUID(),
      uuid: product.uuid,
      expectedVersion: product.version,
      offers: [
        {
          uuid: offer.uuid,
          variantUuid,
          showing: true,
          records: [{ uuid: large.uuid, currentPrice: { value: '200', currencyCode: 'RUB' } }],
        },
      ],
    };
    product = await service.update(command);
    expect(product.offers[0].records.find((record) => record.uuid === small.uuid)!.currentPrice!.uuid).toBe(
      originalPrice,
    );
    const updated = product.offers[0].records.find((record) => record.uuid === large.uuid)!;
    expect(updated.currentPrice!.value).toBe('200.00');
    expect(updated.prices!.map((price) => price.value)).toEqual(['200.00', '125.50']);
    expect(updated.prices![1].endsAt).not.toBeNull();
    expect(updated.inventory).toEqual(large.inventory);
    expect((await service.update(command)).version).toBe(product.version);
    expect((await service.getOffer(offer.uuid)).offer.priceRange).toMatchObject({ min: '125.50', max: '200.00' });
    expect((await service.getOffer(offer.uuid, { availableMin: 1 })).offer.priceRange).toMatchObject({
      min: '125.50',
      max: '125.50',
    });
    const [outbox] = await source.query(
      'SELECT schema_version,payload FROM outbox_event WHERE aggregate_uuid=$1 AND aggregate_version=$2',
      [product.uuid, product.version],
    );
    expect(outbox.schema_version).toBe(3);
    expect(outbox.payload.offers[0]).not.toHaveProperty('currentPrice');
    expect(
      outbox.payload.offers[0].records.find((record: { uuid: string }) => record.uuid === large.uuid).currentPrice
        .value,
    ).toBe('200.00');
    product = await service.update({
      ...command,
      commandId: randomUUID(),
      expectedVersion: product.version,
      offers: [
        {
          ...command.offers[0],
          records: [{ uuid: large.uuid, currentPrice: { value: '125.50', currencyCode: 'RUB' } }],
        },
      ],
    });
  });
  it('applies simultaneous duplicate commands once and stores an inventory outbox event', async () => {
    const record = product.offers[0].records.find((item) => item.article === 'BLUE-L');
    const command = { commandId: randomUUID(), recordUuid: record.uuid, expectedVersion: 1, quantity: 8 };
    const [first, retry] = await Promise.all([service.receiptInventory(command), service.receiptInventory(command)]);
    expect(first.uuid).toBe(retry.uuid);
    expect(first.quantity).toBe(8);
    expect(retry.quantity).toBe(8);
    const [row] = await source.query('SELECT count(*)::int AS count FROM inventory_movement WHERE record_uuid=$1', [
      record.uuid,
    ]);
    expect(row.count).toBe(1);
    const [outbox] = await source.query(
      "SELECT payload FROM outbox_event WHERE aggregate_type='record_inventory' AND aggregate_uuid=$1",
      [first.uuid],
    );
    expect(outbox.payload.recordUuid).toBe(record.uuid);
    await expect(service.receiptInventory({ ...command, quantity: 7 })).rejects.toThrow('Command id was already used');
  });
  it('persists explicit record order in reads and events without changing identity or inventory', async () => {
    const offer = product.offers[0];
    const before = await service.getByUuid(product.uuid);
    const records = before.offers[0].records;
    const update = (inputs: { uuid: string; order?: number; article?: string }[]) =>
      service.update({
        commandId: randomUUID(),
        uuid: product.uuid,
        expectedVersion: product.version,
        offers: [
          {
            uuid: offer.uuid,
            variantUuid,
            showing: true,

            records: inputs.map((record) => ({ ...record, currentPrice: { value: '125.50', currencyCode: 'RUB' } })),
          },
        ],
      });
    const expected = [...records].reverse().map((record) => record.uuid);
    product = await update(records.map((record, index) => ({ uuid: record.uuid, order: records.length - index - 1 })));
    expect(product.offers[0].records.map((record) => record.uuid)).toEqual(expected);
    expect(product.offers[0].records.map((record) => record.order)).toEqual([0, 1]);
    for (const record of product.offers[0].records) {
      const previous = records.find((item) => item.uuid === record.uuid);
      expect(record.article).toBe(previous.article);
      expect(record.inventory).toEqual(previous.inventory);
    }
    const detail = await service.getOffer(offer.uuid, { availableMin: 1 });
    const list = await service.getOffers({ availableMin: 1 });
    expect(detail.offer.records.map((record) => record.uuid)).toEqual(expected);
    expect(list.items.find((item) => item.uuid === offer.uuid).records.map((record) => record.uuid)).toEqual(expected);
    const [outbox] = await source.query(
      'SELECT payload FROM outbox_event WHERE aggregate_uuid=$1 AND aggregate_version=$2',
      [product.uuid, product.version],
    );
    expect(outbox.payload.offers[0].records.map((record) => record.uuid)).toEqual(expected);
    expect(outbox.payload.offers[0].records.map((record) => record.order)).toEqual([0, 1]);

    product = await update([{ uuid: records[0].uuid, article: records[0].article }]);
    expect(product.offers[0].records.map((record) => record.uuid)).toEqual(expected);
    await expect(update(records.map((record) => ({ uuid: record.uuid, order: 0 })))).rejects.toThrow(
      'order occurs twice',
    );
    await expect(update([{ uuid: records[0].uuid, order: -1 }])).rejects.toBeDefined();
    await expect(update([{ uuid: records[0].uuid, order: 0.5 }])).rejects.toBeDefined();
    expect((await service.getByUuid(product.uuid)).version).toBe(product.version);
    await expect(
      source.query('UPDATE accounting_record SET "order"=0 WHERE offer_uuid=$1', [offer.uuid]),
    ).rejects.toThrow();
  });

  it('rejects stale writes and overdraw without a movement or stock change', async () => {
    const record = product.offers[0].records.find((item) => item.article === 'BLUE-L');
    await expect(
      service.writeOffInventory({ commandId: randomUUID(), recordUuid: record.uuid, expectedVersion: 1, quantity: 1 }),
    ).rejects.toThrow('version conflict');
    await expect(
      service.writeOffInventory({ commandId: randomUUID(), recordUuid: record.uuid, expectedVersion: 2, quantity: 9 }),
    ).rejects.toThrow('invalid stock');
    const [row] = await source.query('SELECT quantity,version FROM record_inventory WHERE record_uuid=$1', [
      record.uuid,
    ]);
    expect(row).toEqual({ quantity: 8, version: 2 });
  });
  it('permits zero adjustment and enforces inventory quantity and reservation checks in SQL', async () => {
    const record = product.offers[0].records.find((item) => item.article === 'BLUE-L');
    const inventory = await service.adjustInventory({
      commandId: randomUUID(),
      recordUuid: record.uuid,
      expectedVersion: 2,
      quantity: 0,
    });
    expect(inventory.quantity).toBe(0);
    const [movement] = await source.query(
      "SELECT source_type FROM inventory_movement WHERE record_uuid=$1 AND type='adjustment'",
      [record.uuid],
    );
    expect(movement.source_type).toBe('correction');
    await expect(
      source.query('UPDATE record_inventory SET reserved=1 WHERE record_uuid=$1', [record.uuid]),
    ).rejects.toThrow();
    await expect(
      source.query('UPDATE record_inventory SET quantity=-1 WHERE record_uuid=$1', [record.uuid]),
    ).rejects.toThrow();
  });
  it('allows arbitrary combined text, preserves order and does not filter sibling records from search results', async () => {
    const record = product.offers[0].records.find((item) => item.article === 'BLUE-L');
    product = await service.update({
      commandId: randomUUID(),
      uuid: product.uuid,
      expectedVersion: product.version,
      offers: [
        {
          uuid: product.offers[0].uuid,
          variantUuid,
          showing: true,

          records: [
            {
              currentPrice: { value: '125.50', currencyCode: 'RUB' },
              uuid: record.uuid,
              clarifications: [{ value: 'L евростандарт' }, { value: 'Подарочная упаковка' }],
            },
          ],
        },
      ],
    });
    const result = await service.getAll({ search: 'BLUE-L' });
    expect(result.items[0].offers[0].records).toHaveLength(2);
    expect(
      result.items[0].offers[0].records
        .find((item) => item.uuid === record.uuid)
        .clarifications.map((item) => item.value),
    ).toEqual(['L евростандарт', 'Подарочная упаковка']);
  });
  it('rejects duplicate articles and changes to a record owned by another association atomically', async () => {
    const other = await service.create({
      ...input(),
      offers: [
        {
          variantUuid: secondVariantUuid,
          showing: true,
          records: [{ currentPrice: { value: '150', currencyCode: 'RUB' } }],
        },
      ],
    });
    const otherRecord = other.offers[0].records[0];
    const modify = (records: object[]) => ({
      commandId: randomUUID(),
      uuid: product.uuid,
      expectedVersion: product.version,
      offers: [
        {
          uuid: product.offers[0].uuid,
          variantUuid,
          showing: true,

          records: records.map((record) => ({ ...record, currentPrice: { value: '125.50', currencyCode: 'RUB' } })),
        },
      ],
    });
    await expect(service.update(modify([{ article: 'BLUE-S' }]) as never)).rejects.toThrow('already exists');
    await expect(service.update(modify([{ uuid: otherRecord.uuid, article: 'STOLEN' }]) as never)).rejects.toThrow(
      'does not belong',
    );
    expect((await service.getByUuid(product.uuid)).version).toBe(product.version);
    await expect(
      source.query('INSERT INTO accounting_record(offer_uuid,article) VALUES ($1,$2)', [
        product.offers[0].uuid,
        'BLUE-S',
      ]),
    ).rejects.toThrow();
    await expect(
      source.query('INSERT INTO record_clarification(record_uuid,position,value) VALUES ($1,10,$2)', [
        otherRecord.uuid,
        '   ',
      ]),
    ).rejects.toThrow();
  });
  it('protects parent membership and referenced inventory using foreign keys', async () => {
    const otherProduct = randomUUID(),
      otherVariant = randomUUID();
    await snapshots.apply(
      event(otherProduct, 1, 'active', [{ uuid: otherVariant, name: 'Другой вариант', status: 'active' }]),
    );
    await expect(
      service.create({
        ...input(),
        offers: [
          {
            variantUuid: otherVariant,
            showing: true,
            records: [{ currentPrice: { value: '1', currencyCode: 'RUB' } }],
          },
        ],
      }),
    ).rejects.toThrow('another product');
    await expect(
      source.query('INSERT INTO store_offer(store_product_uuid,product_uuid,variant_uuid) VALUES ($1,$2,$3)', [
        product.uuid,
        productUuid,
        otherVariant,
      ]),
    ).rejects.toThrow();
    await expect(
      source.query('DELETE FROM accounting_record WHERE uuid=$1', [product.offers[0].records[0].uuid]),
    ).rejects.toThrow();
  });
  it('serializes competing stock writes and preserves reserved stock', async () => {
    const target = await service.create(input());
    const record = target.offers[0].records[0];
    const writes = await Promise.allSettled(
      [4, 7].map((quantity) =>
        service.receiptInventory({
          commandId: randomUUID(),
          recordUuid: record.uuid,
          expectedVersion: 1,
          quantity,
        }),
      ),
    );
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const [stock] = await source.query('SELECT quantity,version FROM record_inventory WHERE record_uuid=$1', [
      record.uuid,
    ]);
    expect(stock.version).toBe(2);
    await source.query('UPDATE record_inventory SET reserved=2 WHERE record_uuid=$1', [record.uuid]);
    await expect(
      service.writeOffInventory({
        commandId: randomUUID(),
        recordUuid: record.uuid,
        expectedVersion: 2,
        quantity: stock.quantity - 1,
      }),
    ).rejects.toThrow('invalid stock');
    const [movements] = await source.query(
      'SELECT count(*)::int AS count FROM inventory_movement WHERE record_uuid=$1',
      [record.uuid],
    );
    expect(movements.count).toBe(1);
  });

  it('keeps shop filtering when the product name matches the search', async () => {
    const result = await service.getAll({ shopUuid: randomUUID(), search: 'Майка' });
    expect(result.items).toEqual([]);
  });

  it('filters unavailable records in public SQL while keeping all records in admin queries', async () => {
    const catalogUuid = randomUUID();
    const catalogVariantUuid = randomUUID();
    await snapshots.apply(
      event(catalogUuid, 1, 'active', [{ uuid: catalogVariantUuid, name: 'Черная', status: 'active' }]),
    );
    const created = await service.create({
      ...input(),
      productUuid: catalogUuid,
      offers: [
        {
          variantUuid: catalogVariantUuid,
          showing: true,

          records: [
            {
              currentPrice: { value: '125.50', currencyCode: 'RUB' },
              article: 'AVAILABLE',
              clarifications: [{ value: 'Доступная' }],
            },
            { currentPrice: { value: '125.50', currencyCode: 'RUB' }, article: 'EMPTY', clarifications: [] },
            {
              currentPrice: { value: '125.50', currencyCode: 'RUB' },
              article: 'RESERVED',
              clarifications: [{ value: 'Полностью зарезервирована' }],
            },
          ],
        },
      ],
    });
    const offer = created.offers[0];
    const available = offer.records.find((record) => record.article === 'AVAILABLE');
    const reserved = offer.records.find((record) => record.article === 'RESERVED');
    await source.query('UPDATE record_inventory SET quantity=5, reserved=1 WHERE record_uuid=$1', [available.uuid]);
    await source.query('UPDATE record_inventory SET quantity=5, reserved=5 WHERE record_uuid=$1', [reserved.uuid]);

    const details = await service.getOffer(offer.uuid, { availableMin: 1 });
    expect(details.offer.records.map((record) => record.article)).toEqual(['AVAILABLE']);
    expect(details.offer.records[0].inventory.available).toBe(4);
    expect(
      details.siblingOffers.flatMap((item) => item.records).every((record) => record.inventory.available > 0),
    ).toBe(true);
    const list = await service.getOffers({ availableMin: 1 });
    expect(list.items.find((item) => item.uuid === offer.uuid).records.map((record) => record.article)).toEqual([
      'AVAILABLE',
    ]);
    expect((await service.getByUuid(created.uuid)).offers[0].records).toHaveLength(3);

    await source.query('UPDATE record_inventory SET reserved=quantity WHERE record_uuid=$1', [available.uuid]);
    await expect(service.getOffer(offer.uuid, { availableMin: 1 })).rejects.toThrow('not found');
    expect((await service.getOffers({ availableMin: 1 })).items.some((item) => item.uuid === offer.uuid)).toBe(false);
    expect((await service.getByUuid(created.uuid)).offers[0].records).toHaveLength(3);
  });

  const createFilterFixture = async () => {
    const catalogUuid = randomUUID();
    const red = randomUUID();
    const blue = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await snapshots.apply(
      event(catalogUuid, 1, 'active', [
        { uuid: red, name: 'Красная', status: 'active' },
        { uuid: blue, name: 'Синяя', status: 'active' },
      ]),
    );
    const created = await service.create({
      ...input(),
      productUuid: catalogUuid,
      showing: false,
      offers: [
        {
          variantUuid: red,
          showing: true,

          records: [
            {
              currentPrice: { value: '10', currencyCode: 'RUB' },
              article: `FILTER-LIVE-${suffix}`,
              clarifications: [{ value: 'Есть' }],
            },
            {
              currentPrice: { value: '10', currencyCode: 'RUB' },
              article: `FILTER-ZERO-${suffix}`,
              clarifications: [],
            },
          ],
        },
        {
          variantUuid: blue,
          showing: false,

          records: [
            {
              currentPrice: { value: '10', currencyCode: 'RUB' },
              article: `FILTER-HELD-${suffix}`,
              clarifications: [],
            },
            { currentPrice: { value: '10', currencyCode: 'RUB' }, article: `FILTER-LOW-${suffix}`, clarifications: [] },
          ],
        },
      ],
    });
    for (const [article, quantity, reserved] of [
      ['LIVE', 5, 1],
      ['HELD', 10, 10],
      ['LOW', 3, 0],
    ] as const) {
      await source.query(
        `UPDATE record_inventory SET quantity=$1,reserved=$2
        WHERE record_uuid=(SELECT uuid FROM accounting_record WHERE article=$3)`,
        [quantity, reserved, `FILTER-${article}-${suffix}`],
      );
    }
    return { ...created, suffix };
  };

  it('applies flat showing flags, zero bounds and all six inclusive inventory bounds', async () => {
    const fixture = await createFilterFixture();
    const query = {
      productUuid: fixture.productUuid,
      productShowing: false,
      variantShowing: false,
      availableMin: 0,
      availableMax: 0,
    };
    const result = await service.getAll(query);
    expect(result.items.length).toBe(1);
    expect(result.items[0].offers).toHaveLength(1);
    expect(result.items[0].offers[0].showing).toBe(false);
    expect(result.items[0].offers[0].records.map((record) => record.article)).toEqual([
      `FILTER-HELD-${fixture.suffix}`,
    ]);
    const detail = await service.getByUuid(fixture.uuid, query);
    expect(detail.offers[0].records.map((record) => record.uuid)).toEqual(
      result.items[0].offers[0].records.map((record) => record.uuid),
    );
    const ranges = await service.getAll({
      productUuid: fixture.productUuid,
      quantityMin: 3,
      quantityMax: 5,
      reservedMin: 0,
      reservedMax: 1,
      availableMin: 3,
      availableMax: 4,
    });
    expect(
      ranges.items[0].offers
        .flatMap((offer) => offer.records)
        .map((record) => record.article)
        .sort(),
    ).toEqual([`FILTER-LIVE-${fixture.suffix}`, `FILTER-LOW-${fixture.suffix}`].sort());
    expect((await service.getAll({ productUuid: fixture.productUuid, productShowing: true })).items).toEqual([]);
    expect((await service.getByUuid(fixture.uuid)).offers.flatMap((offer) => offer.records)).toHaveLength(4);
    expect((await service.getOffers({ productUuid: fixture.productUuid })).items).toHaveLength(2);
  });

  it('requires variant and inventory conditions to match the same branch and record', async () => {
    const fixture = await createFilterFixture();
    expect(
      (await service.getAll({ productUuid: fixture.productUuid, variantShowing: true, quantityMin: 10 })).items,
    ).toEqual([]);
    expect(
      (
        await service.getAll({
          productUuid: fixture.productUuid,
          variantShowing: false,
          quantityMin: 10,
          availableMin: 1,
        })
      ).items,
    ).toEqual([]);
    await expect(service.getByUuid(fixture.uuid, { productShowing: true })).rejects.toThrow('not found');
    const offers = await service.getOffers({
      productUuid: fixture.productUuid,
      variantShowing: false,
      availableMin: 1,
    });
    expect(offers.items.length).toBe(1);
    const detail = await service.getOffer(offers.items[0].uuid, { variantShowing: false, availableMin: 1 });
    expect(detail.offer.records.map((record) => record.article)).toEqual([`FILTER-LOW-${fixture.suffix}`]);
    expect(detail.siblingOffers).toHaveLength(1);
  });

  it('excludes archived offers even when explicitly requested and retains disabled products', async () => {
    const fixture = await createFilterFixture();
    await source.query("UPDATE store_product SET status='disabled' WHERE uuid=$1", [fixture.uuid]);
    await source.query("UPDATE store_offer SET status='archived' WHERE store_product_uuid=$1 AND showing=false", [
      fixture.uuid,
    ]);
    const result = await service.getAll({
      productUuid: fixture.productUuid,
      productStatus: StoreProductStatus.DISABLED,
      variantStatus: StoreOfferStatus.ARCHIVED,
    });
    expect(result.items).toEqual([]);
    expect(
      (await service.getAll({ productUuid: fixture.productUuid, productStatus: StoreProductStatus.ACTIVE })).items,
    ).toEqual([]);
    const ordinary = (await service.getAll({ productUuid: fixture.productUuid })).items[0];
    expect(ordinary.status).toBe('disabled');
    expect(ordinary.offers).toHaveLength(1);
    expect((await service.getByUuid(fixture.uuid)).offers).toHaveLength(1);
    const archived = fixture.offers.find((offer) => !offer.showing)!;
    await expect(service.getOffer(archived.uuid)).rejects.toMatchObject({ status: 404 });
    const detail = await service.getOffer(ordinary.offers[0].uuid);
    expect(detail.siblingOffers.map((offer) => offer.uuid)).toEqual([ordinary.offers[0].uuid]);
    expect((await service.getOffers({ productUuid: fixture.productUuid, limit: 1 })).meta.nextToken).toBeNull();
    expect((await service.getAll({ search: `FILTER-LOW-${fixture.suffix}` })).items).toEqual([]);
    expect((await service.getSnapshot(fixture.uuid)).offers).toHaveLength(2);
    await source.query("UPDATE store_offer SET status='archived' WHERE store_product_uuid=$1", [fixture.uuid]);
    const empty = (await service.getAll({ productUuid: fixture.productUuid })).items[0];
    expect(empty.status).toBe(StoreProductStatus.DISABLED);
    expect(empty.offers).toEqual([]);
    expect((await service.getByUuid(fixture.uuid)).offers).toEqual([]);
    expect((await service.getOffers({ productUuid: fixture.productUuid })).items).toEqual([]);
  });

  it('excludes catalog-archived variants before pagination even when Store offers are still active', async () => {
    const fixture = await createFilterFixture();
    const firstPage = await service.getOffers({ productUuid: fixture.productUuid, limit: 1 });
    const archived = firstPage.items[0];
    const remaining = fixture.offers.find((offer) => offer.uuid !== archived.uuid)!;
    await source.query("UPDATE variant_snapshot SET status='archived' WHERE variant_uuid=$1", [archived.variantUuid]);

    const page = await service.getOffers({ productUuid: fixture.productUuid, limit: 1 });
    expect(page.items.map((offer) => offer.uuid)).toEqual([remaining.uuid]);
    expect(page.meta.nextToken).toBeNull();
    await expect(service.getOffer(archived.uuid)).rejects.toMatchObject({ status: 404 });
    const detail = await service.getOffer(remaining.uuid);
    expect(detail.siblingOffers.map((offer) => offer.uuid)).toEqual([remaining.uuid]);
    expect((await service.getByUuid(fixture.uuid)).offers.map((offer) => offer.uuid)).toEqual([remaining.uuid]);
    expect(
      (await service.getAll({ productUuid: fixture.productUuid })).items[0].offers.map((offer) => offer.uuid),
    ).toEqual([remaining.uuid]);
    expect((await service.getAll({ search: archived.records[0].article })).items).toEqual([]);

    const snapshot = await service.getSnapshot(fixture.uuid);
    expect(snapshot.offers).toHaveLength(2);
    expect(snapshot.offers.every((offer) => offer.status === StoreOfferStatus.ACTIVE)).toBe(true);
    await source.query("UPDATE variant_snapshot SET status='archived' WHERE variant_uuid=$1", [remaining.variantUuid]);
    expect((await service.getByUuid(fixture.uuid)).offers).toEqual([]);
    expect((await service.getOffers({ productUuid: fixture.productUuid })).items).toEqual([]);
  });

  it('excludes catalog-archived products while preserving disabled products and full synchronization snapshots', async () => {
    const fixture = await createFilterFixture();
    await source.query("UPDATE product_snapshot SET status='disabled' WHERE product_uuid=$1", [fixture.productUuid]);
    await source.query("UPDATE variant_snapshot SET status='disabled' WHERE product_uuid=$1", [fixture.productUuid]);
    expect((await service.getByUuid(fixture.uuid)).offers).toHaveLength(2);
    expect((await service.getOffers({ productUuid: fixture.productUuid })).items).toHaveLength(2);
    await source.query("UPDATE product_snapshot SET status='archived' WHERE product_uuid=$1", [fixture.productUuid]);

    expect((await service.getAll({ productUuid: fixture.productUuid })).items).toEqual([]);
    expect((await service.getOffers({ productUuid: fixture.productUuid })).items).toEqual([]);
    await expect(service.getByUuid(fixture.uuid)).rejects.toMatchObject({ status: 404 });
    await expect(service.getOffer(fixture.offers[0].uuid)).rejects.toMatchObject({ status: 404 });
    const snapshot = await service.getSnapshot(fixture.uuid);
    expect(snapshot.status).toBe(StoreProductStatus.ACTIVE);
    expect(snapshot.offers).toHaveLength(2);
    expect((await service.getByRecordUuid(fixture.offers[0].records[0].uuid)).offers).toHaveLength(2);
    const snapshotsPage = await service.getSnapshots({ limit: 100 });
    expect(snapshotsPage.items.find((item) => item.uuid === fixture.uuid)?.offers).toHaveLength(2);
  });

  it('hides an archived Store root while keeping full snapshots and archive events', async () => {
    const fixture = await createFilterFixture();
    const archived = await service.archive({
      commandId: randomUUID(),
      uuid: fixture.uuid,
      expectedVersion: fixture.version,
    });
    expect(archived.status).toBe(StoreProductStatus.ARCHIVED);
    expect(archived.offers).toHaveLength(2);
    const query = { productUuid: fixture.productUuid };
    expect((await service.getAll(query)).items).toEqual([]);
    expect((await service.getOffers(query)).items).toEqual([]);
    expect((await service.getAll({ ...query, productStatus: StoreProductStatus.ARCHIVED })).items).toEqual([]);
    await expect(service.getByUuid(fixture.uuid)).rejects.toMatchObject({ status: 404 });
    for (const offer of fixture.offers)
      await expect(service.getOffer(offer.uuid)).rejects.toMatchObject({ status: 404 });
    expect((await service.getSnapshot(fixture.uuid)).offers).toHaveLength(2);
    expect((await service.getByRecordUuid(fixture.offers[0].records[0].uuid)).uuid).toBe(fixture.uuid);
    const eventRows = await source.query(
      "SELECT payload FROM outbox_event WHERE aggregate_uuid=$1 AND event_type='store.product.archived'",
      [fixture.uuid],
    );
    expect(eventRows[0].payload.offers).toHaveLength(2);
    const ordinary: string[] = [];
    const snapshots: string[] = [];
    for (const [read, ids] of [
      [(nextToken?: string) => service.getAll({ limit: 2, nextToken }), ordinary],
      [(nextToken?: string) => service.getSnapshots({ limit: 2, nextToken }), snapshots],
    ] as const) {
      let nextToken: string | undefined;
      do {
        const page = await read(nextToken);
        expect(page.items.length).toBeGreaterThan(0);
        ids.push(...page.items.map((item) => item.uuid));
        nextToken = page.meta.nextToken ?? undefined;
      } while (nextToken);
    }
    expect(ordinary).not.toContain(fixture.uuid);
    expect(snapshots).toContain(fixture.uuid);
    expect(new Set(ordinary).size).toBe(ordinary.length);
  });

  it('searches names and articles using FTS and updates the document after renames', async () => {
    const fixture = await createFilterFixture();
    const query = { productUuid: fixture.productUuid };
    expect((await service.getAll({ ...query, search: 'майками' })).items).toHaveLength(1);
    const article = `FILTER-LIVE-${fixture.suffix}`;
    const found = await service.getAll({ ...query, search: article.toLowerCase() });
    expect(found.items[0].offers).toHaveLength(1);
    expect(found.items[0].offers[0].records).toHaveLength(2);
    expect((await service.getOffers({ ...query, search: 'красн FILTER-LIVE' })).items).toHaveLength(1);
    expect(
      (await service.getAll({ ...query, search: `FILTER-HELD-${fixture.suffix}`, availableMin: 1 })).items,
    ).toEqual([]);
    await source.query('UPDATE accounting_record SET article=$1 WHERE article=$2', [
      `RENAMED-${fixture.suffix}`,
      article,
    ]);
    expect((await service.getAll({ ...query, search: article })).items).toEqual([]);
    expect((await service.getAll({ ...query, search: `RENAMED-${fixture.suffix}` })).items).toHaveLength(1);
    await source.query("UPDATE product_snapshot SET name='Куртка' WHERE product_uuid=$1", [fixture.productUuid]);
    expect((await service.getAll({ ...query, search: 'майками' })).items).toEqual([]);
    expect((await service.getAll({ ...query, search: 'куртками' })).items).toHaveLength(1);
    await source.query("UPDATE variant_snapshot SET name='Желтая' WHERE variant_uuid=$1", [
      fixture.offers[0].variantUuid,
    ]);
    expect((await service.getAll({ ...query, search: 'желт' })).items).toHaveLength(1);
    expect((await service.getAll({ ...query, search: '%_ ()' })).items).toEqual([]);
    const indexes = await source.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexdef LIKE '%USING gin%'",
    );
    expect(indexes).toEqual([{ indexname: 'accounting_record_search_idx' }]);
  });

  it('ignores legacy catalog events and parks a gap until authoritative reconciliation', async () => {
    const legacy = event(randomUUID(), 1);
    legacy.producer = 'product_srv';
    legacy.schemaVersion = 1;
    await snapshots.apply(legacy);
    expect(
      (
        await source.query('SELECT count(*)::int AS count FROM product_snapshot WHERE product_uuid=$1', [
          legacy.aggregateId,
        ])
      )[0].count,
    ).toBe(0);
    const gap = event(productUuid, 3);
    await snapshots.apply(gap);
    expect(
      (await source.query('SELECT source_version FROM product_snapshot WHERE product_uuid=$1', [productUuid]))[0]
        .source_version,
    ).toBe(1);
    await snapshots.synchronizeProduct(plainToInstance(ProductSnapshotPayloadDto, gap.payload));
    expect(
      (await source.query('SELECT source_version FROM product_snapshot WHERE product_uuid=$1', [productUuid]))[0]
        .source_version,
    ).toBe(3);
    expect((await source.query('SELECT status FROM sync_issue WHERE event_uuid=$1', [gap.eventUuid]))[0].status).toBe(
      'resolved',
    );
  });
  it('archives Store sales when their catalog Product is archived', async () => {
    await snapshots.apply(event(productUuid, 4, 'archived'));
    const offers = await service.getOffers();
    expect(offers.items.some((item) => item.productUuid === productUuid)).toBe(false);
    await expect(service.getOffer(product.offers[0].uuid)).rejects.toMatchObject({ status: 404 });
    const archived = await service.getSnapshot(product.uuid);
    expect(archived.status).toBe(StoreProductStatus.ARCHIVED);
    expect(archived.offers.every((offer) => offer.status === StoreOfferStatus.ARCHIVED)).toBe(true);
    expect(archived.offers[0].records).toHaveLength(2);
  });

  it('archives one catalog variant across shops, keeps other variants and does not repeat effects', async () => {
    const fixture = await createFilterFixture();
    const otherShop = randomUUID();
    await source.query("INSERT INTO shop_snapshot(shop_uuid,source_version,name) VALUES ($1,1,'Другой магазин')", [
      otherShop,
    ]);
    const other = await service.create({
      ...input(),
      shopUuid: otherShop,
      productUuid: fixture.productUuid,
      offers: fixture.offers.map((offer) => ({
        variantUuid: offer.variantUuid,
        showing: true,
        records: [{ currentPrice: { value: '25', currencyCode: 'RUB' } }],
      })),
    });
    const target = fixture.offers[0].variantUuid;
    const queries = new StoreProductQueryRepository(
      source,
      new StoreProductCategoryRepository(),
      new CursorPagination('test-pagination-key-at-least-32-bytes'),
    );
    expect(await queries.archiveImpact(fixture.productUuid, target)).toEqual({ offerCount: 2, shopCount: 2 });
    const before = await service.getSnapshot(fixture.uuid);
    const update = event(
      fixture.productUuid,
      2,
      'active',
      fixture.offers.map((offer) => ({
        uuid: offer.variantUuid,
        name: 'Вариант',
        status: offer.variantUuid === target ? 'archived' : 'active',
      })),
    );
    await snapshots.apply(update);
    for (const uuid of [fixture.uuid, other.uuid]) {
      const current = await service.getSnapshot(uuid);
      expect(current.status).toBe(StoreProductStatus.ACTIVE);
      expect(current.offers.find((offer) => offer.variantUuid === target)!.status).toBe(StoreOfferStatus.ARCHIVED);
      expect((await service.getByUuid(uuid)).offers).toHaveLength(1);
    }
    const after = await service.getSnapshot(fixture.uuid);
    expect(after.offers.map((offer) => offer.records)).toEqual(before.offers.map((offer) => offer.records));
    expect(await queries.archiveImpact(fixture.productUuid, target)).toEqual({ offerCount: 0, shopCount: 0 });
    await snapshots.apply(update);
    await snapshots.synchronizeProduct(plainToInstance(ProductSnapshotPayloadDto, update.payload));
    expect((await service.getSnapshot(fixture.uuid)).version).toBe(after.version);
    const complete = event(fixture.productUuid, 3, 'archived', update.payload.variants as any);
    await snapshots.synchronizeProduct(plainToInstance(ProductSnapshotPayloadDto, complete.payload));
    for (const uuid of [fixture.uuid, other.uuid]) {
      const archived = await service.getSnapshot(uuid);
      expect(archived.status).toBe(StoreProductStatus.ARCHIVED);
      expect(archived.offers.every((offer) => offer.status === StoreOfferStatus.ARCHIVED)).toBe(true);
      await expect(service.getByUuid(uuid)).rejects.toMatchObject({ status: 404 });
    }
    expect((await service.getSnapshot(fixture.uuid)).offers.map((offer) => offer.records)).toEqual(
      before.offers.map((offer) => offer.records),
    );
    await snapshots.apply(event(fixture.productUuid, 1));
    expect((await service.getSnapshot(fixture.uuid)).status).toBe(StoreProductStatus.ARCHIVED);
  });
});
