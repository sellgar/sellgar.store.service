import { Injectable } from '@nestjs/common';
import { EntityManager, In, Not } from 'typeorm';

import { StoreProductStatus } from '../enum/store-product-status.enum';
import { StoreOfferStatus } from '../enum/store-offer-status.enum';
import { StoreProductModel } from '../model/store-product.model';
import { StoreOfferModel } from '../model/store-offer.model';
import { ProductSnapshotPayloadDto } from '../service/dto/product-snapshot-payload.dto';
import { StoreProductQueryRepository } from './store-product-query.repository';
import { StoreEventRepository } from './store-event.repository';

@Injectable()
export class CatalogArchiveRepository {
  constructor(
    private readonly queries: StoreProductQueryRepository,
    private readonly events: StoreEventRepository,
  ) {}

  async apply(manager: EntityManager, product: ProductSnapshotPayloadDto): Promise<void> {
    const wholeProduct = product.status === 'archived';
    const variants = product.variants.filter((variant) => variant.status === 'archived').map((variant) => variant.uuid);
    if (!wholeProduct && variants.length === 0) return;

    const affected: { uuid: string }[] = await manager.query(
      `SELECT sp.uuid FROM store_product sp WHERE sp.product_uuid=$1 AND (
        ($2 AND sp.status <> 'archived') OR EXISTS (
          SELECT 1 FROM store_offer so WHERE so.store_product_uuid=sp.uuid
          AND so.status <> 'archived' AND ($2 OR so.variant_uuid=ANY($3::uuid[]))
        )
      ) ORDER BY sp.uuid FOR UPDATE`,
      [product.uuid, wholeProduct, variants],
    );

    for (const row of affected) {
      await manager.update(
        StoreOfferModel,
        {
          storeProductUuid: row.uuid,
          status: Not(StoreOfferStatus.ARCHIVED),
          ...(!wholeProduct ? { variantUuid: In(variants) } : {}),
        },
        { status: StoreOfferStatus.ARCHIVED, version: () => 'version + 1' },
      );
      await manager.update(
        StoreProductModel,
        { uuid: row.uuid },
        { ...(wholeProduct ? { status: StoreProductStatus.ARCHIVED } : {}), version: () => 'version + 1' },
      );
      const snapshot = await this.queries.getSnapshot(row.uuid, manager);
      await this.events.add(
        manager,
        'store_product',
        row.uuid,
        snapshot.version,
        wholeProduct ? 'store.product.archived' : 'store.product.updated',
        snapshot,
      );
    }
  }
}
