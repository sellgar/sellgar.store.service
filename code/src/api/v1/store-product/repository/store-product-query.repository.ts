import { CursorPagination, CursorOrder } from '@sellgar/pagination';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { plainToInstance } from 'class-transformer';

import { AccountingRecordModel } from '../model/accounting-record.model';
import { StoreProductModel } from '../model/store-product.model';
import { StoreOfferModel } from '../model/store-offer.model';
import { ShopSnapshotModel } from '../model/shop-snapshot.model';
import { ProductSnapshotModel } from '../model/product-snapshot.model';
import { PriceHistoryModel } from '../model/price-history.model';
import { StoreProductEntity, StorefrontOfferEntity, StorefrontOfferDetailEntity } from '../entity';
import { GetAllStoreProductsCommand } from '../service/command/get-all-store-products.command';
import { StoreProductCategoryRepository } from './store-product-category.repository';

@Injectable()
export class StoreProductQueryRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly categories: StoreProductCategoryRepository,
    private readonly pagination: CursorPagination,
  ) {}
  async getAll(query: Partial<GetAllStoreProductsCommand>) {
    const page = await this.readPage(this.applyFilters(this.buildStoreProductQuery(), query), query, 'storeProduct');
    await this.loadPrices(page.items, this.dataSource.manager);
    return { items: page.items.map((row) => this.toEntity(row)), meta: page.meta };
  }

  async getByUuid(
    uuid: string,
    query: Partial<GetAllStoreProductsCommand> = {},
    manager: EntityManager = this.dataSource.manager,
  ): Promise<StoreProductEntity> {
    const row = await this.applyFilters(this.buildStoreProductQuery(manager), query)
      .andWhere('storeProduct.uuid = :uuid', { uuid })
      .getOne();
    if (!row) throw new NotFoundException('Store product not found');
    await this.loadPrices([row], manager);
    return this.toEntity(row);
  }

  async getByRecordUuid(recordUuid: string): Promise<StoreProductEntity> {
    const [row]: { uuid: string }[] = await this.dataSource.query(
      `SELECT offer.store_product_uuid AS uuid
       FROM accounting_record record
       JOIN store_offer offer ON offer.uuid = record.offer_uuid
       WHERE record.uuid = $1`,
      [recordUuid],
    );
    if (!row) throw new NotFoundException('Accounting record not found');

    // Internal synchronization read includes hidden and archived records.
    return this.getByUuid(row.uuid);
  }

  async getOffers(query: Partial<GetAllStoreProductsCommand> = {}) {
    const page = await this.readPage(this.applyFilters(this.buildStoreOfferQuery(), query), query, 'offer');
    return { items: page.items.map((row) => this.toOfferEntity(row)), meta: page.meta };
  }

  async getOffer(uuid: string, query: Partial<GetAllStoreProductsCommand> = {}): Promise<StorefrontOfferDetailEntity> {
    const row = await this.applyFilters(this.buildStoreOfferQuery(), query)
      .andWhere('offer.uuid = :uuid', { uuid })
      .getOne();
    if (!row) throw new NotFoundException('Store variant association not found');
    const siblings = await this.applyFilters(this.buildStoreOfferQuery(), query)
      .andWhere('offer.storeProductUuid = :uuid', { uuid: row.storeProductUuid })
      .addOrderBy('offer.createdAt', 'ASC')
      .getMany();
    return plainToInstance(
      StorefrontOfferDetailEntity,
      {
        offer: this.toOfferEntity(row),
        siblingOffers: siblings.map((item) => this.toOfferEntity(item)),
        categories: await this.categories.getPaths(this.dataSource.manager, row.storeProductUuid),
      },
      { excludeExtraneousValues: true },
    );
  }

  private readPage<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    query: Partial<GetAllStoreProductsCommand>,
    alias: 'storeProduct' | 'offer',
  ) {
    const { limit, nextToken, offset, ...filters } = query;
    const codes = (value: string | string[] | undefined) =>
      value === undefined ? undefined : [...new Set(Array.isArray(value) ? value : [value])].sort();
    const order: CursorOrder[] = [
      { expression: alias + '.createdAt', direction: 'DESC', type: 'timestamp' },
      { expression: alias + '.uuid', direction: 'ASC', type: 'uuid' },
    ];
    return this.pagination.read(
      builder,
      { limit, nextToken, offset },
      {
        scope: 'store.' + alias + '.list',
        filters: { ...filters, categoryUuid: codes(filters.categoryUuid), brandCode: codes(filters.brandCode) },
        order,
      },
    );
  }

  private applyFilters<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    query: Partial<GetAllStoreProductsCommand>,
  ) {
    const fields = [
      ['shopUuid', 'storeProduct.shopUuid'],
      ['productUuid', 'storeProduct.productUuid'],
      ['productStatus', 'storeProduct.status'],
      ['productShowing', 'storeProduct.showing'],
      ['variantStatus', 'offer.status'],
      ['variantShowing', 'offer.showing'],
    ] as const;
    for (const [field, column] of fields) {
      if (query[field] !== undefined) builder.andWhere(`${column} = :${field}`, { [field]: query[field] });
    }
    if (query.brandCode !== undefined) {
      builder.andWhere('productSnapshot.brandCode = ANY(CAST(:brandCodes AS varchar[]))', {
        brandCodes: Array.isArray(query.brandCode) ? query.brandCode : [query.brandCode],
      });
    }
    if (query.categoryUuid !== undefined) {
      builder.addCommonTableExpression(
        `SELECT uuid, shop_uuid FROM category WHERE uuid = ANY(CAST(:categoryUuids AS uuid[]))
         UNION
         SELECT child.uuid, child.shop_uuid FROM category child
         JOIN category_branch parent ON child.parent_uuid = parent.uuid AND child.shop_uuid = parent.shop_uuid`,
        'category_branch',
        { recursive: true },
      );
      builder.andWhere(
        `EXISTS (
          SELECT 1 FROM store_product_category link
          JOIN category_branch branch ON branch.uuid = link.category_uuid AND branch.shop_uuid = link.shop_uuid
          WHERE link.store_product_uuid = "storeProduct"."uuid" AND link.shop_uuid = "storeProduct"."shop_uuid"
        )`,
        { categoryUuids: Array.isArray(query.categoryUuid) ? query.categoryUuid : [query.categoryUuid] },
      );
    }
    this.applyInventoryFilters(builder, query, 'inventory');
    if (query.search) {
      const records = builder
        .subQuery()
        .select('1')
        .from(AccountingRecordModel, 'searchedRecord')
        .leftJoin('searchedRecord.inventory', 'searchedInventory')
        .where('searchedRecord.offerUuid = offer.uuid')
        .andWhere('searchedRecord.search_vector @@ store_search_query(:search)');
      this.applyInventoryFilters(records, query, 'searchedInventory');
      builder.andWhere(`EXISTS ${records.getQuery()}`, { search: query.search });
    }
    return builder;
  }

  private applyInventoryFilters<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    query: Partial<GetAllStoreProductsCommand>,
    alias: string,
  ): void {
    const fields = [
      ['quantity', `${alias}.quantity`],
      ['reserved', `${alias}.reserved`],
      ['available', `(${alias}.quantity - ${alias}.reserved)`],
    ] as const;
    for (const [field, column] of fields) {
      const minimum = `${field}Min` as const;
      const maximum = `${field}Max` as const;
      if (query[minimum] !== undefined) builder.andWhere(`${column} >= :${minimum}`, { [minimum]: query[minimum] });
      if (query[maximum] !== undefined) builder.andWhere(`${column} <= :${maximum}`, { [maximum]: query[maximum] });
    }
  }

  private toEntity(row: StoreProductModel): StoreProductEntity {
    return plainToInstance(
      StoreProductEntity,
      {
        ...row,
        offers: row.offers.map((offer) => ({ ...offer, priceRange: this.priceRange(offer) })),
        categoryUuids: row.categoryLinks.map((link) => link.categoryUuid).sort(),
      },
      { excludeExtraneousValues: true },
    );
  }
  private toOfferEntity(row: StoreOfferModel): StorefrontOfferEntity {
    return plainToInstance(
      StorefrontOfferEntity,
      { ...row, priceRange: this.priceRange(row), shopUuid: row.storeProduct.shopUuid },
      { excludeExtraneousValues: true },
    );
  }
  buildStoreProductQuery(manager: EntityManager = this.dataSource.manager) {
    return manager
      .createQueryBuilder(StoreProductModel, 'storeProduct')
      .leftJoinAndMapOne(
        'storeProduct.shopSnapshot',
        ShopSnapshotModel,
        'shopSnapshot',
        'shopSnapshot.shopUuid = storeProduct.shopUuid',
      )
      .leftJoinAndMapOne(
        'storeProduct.productSnapshot',
        ProductSnapshotModel,
        'productSnapshot',
        'productSnapshot.productUuid = storeProduct.productUuid',
      )
      .leftJoinAndSelect('storeProduct.categoryLinks', 'categoryLinks')
      .leftJoinAndSelect('storeProduct.offers', 'offer')
      .leftJoinAndSelect('offer.variantSnapshot', 'variantSnapshot')
      .leftJoinAndSelect('offer.records', 'records')
      .leftJoinAndMapOne(
        'records.currentPrice',
        PriceHistoryModel,
        'current_price',
        'current_price.recordUuid = records.uuid AND current_price.uuid = ' +
          '(SELECT price.uuid FROM price_history price WHERE price.record_uuid = records.uuid ORDER BY price.created_at DESC, price.uuid DESC LIMIT 1)',
      )
      .leftJoinAndSelect('current_price.currency', 'current_price_currency')
      .leftJoinAndSelect('records.clarifications', 'clarifications')
      .leftJoinAndSelect('records.inventory', 'inventory')
      .addOrderBy('records.order', 'ASC')
      .addOrderBy('clarifications.position', 'ASC')
      .addOrderBy('offer.createdAt', 'ASC');
  }

  buildStoreOfferQuery(manager: EntityManager = this.dataSource.manager) {
    return manager
      .createQueryBuilder(StoreOfferModel, 'offer')
      .innerJoinAndSelect('offer.storeProduct', 'storeProduct')
      .leftJoinAndMapOne(
        'offer.productSnapshot',
        ProductSnapshotModel,
        'productSnapshot',
        'productSnapshot.productUuid = offer.productUuid',
      )
      .leftJoinAndSelect('offer.variantSnapshot', 'variantSnapshot')
      .leftJoinAndSelect('offer.records', 'records')
      .leftJoinAndMapOne(
        'records.currentPrice',
        PriceHistoryModel,
        'current_price',
        'current_price.recordUuid = records.uuid AND current_price.uuid = ' +
          '(SELECT price.uuid FROM price_history price WHERE price.record_uuid = records.uuid ORDER BY price.created_at DESC, price.uuid DESC LIMIT 1)',
      )
      .leftJoinAndSelect('current_price.currency', 'current_price_currency')
      .leftJoinAndSelect('records.clarifications', 'clarifications')
      .leftJoinAndSelect('records.inventory', 'inventory')
      .addOrderBy('records.order', 'ASC')
      .addOrderBy('clarifications.position', 'ASC');
  }

  private async loadPrices(rows: StoreProductModel[], manager: EntityManager): Promise<void> {
    const records = rows.flatMap((row) => row.offers.flatMap((offer) => offer.records));
    if (!records.length) return;
    const prices = await manager.find(PriceHistoryModel, {
      where: { recordUuid: In(records.map((record) => record.uuid)) },
      relations: { currency: true },
      order: { createdAt: 'DESC', uuid: 'DESC' },
    });
    const byRecord = new Map<string, PriceHistoryModel[]>();
    for (const price of prices) {
      const history = byRecord.get(price.recordUuid) ?? [];
      history.push(price);
      byRecord.set(price.recordUuid, history);
    }
    for (const record of records) record.prices = byRecord.get(record.uuid) ?? [];
  }

  private priceRange(offer: StoreOfferModel) {
    const prices = offer.records.flatMap((record) => {
      const price = record.currentPrice;
      return price ? [price] : [];
    });
    if (!prices.length || prices.some((price) => price.currencyCode !== prices[0].currencyCode)) return null;
    const units = (value: string) => BigInt(value.replace('.', ''));
    let min = prices[0];
    let max = prices[0];
    for (const price of prices) {
      if (units(price.value) < units(min.value)) min = price;
      if (units(price.value) > units(max.value)) max = price;
    }
    return { min: min.value, max: max.value, currencyCode: min.currencyCode, currency: min.currency };
  }
}
