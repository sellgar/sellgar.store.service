import { DataSource } from 'typeorm';
import { CursorPagination } from '@sellgar/pagination';
import { OutboxWriter } from '@sellgar/outbox';

import { STORE_OUTBOX_OPTIONS } from '../src/integration/outbox/store-outbox.options';
import { CatalogArchiveRepository } from '../src/api/v1/store-product/repository/catalog-archive.repository';
import { StoreProductQueryRepository } from '../src/api/v1/store-product/repository/store-product-query.repository';
import { StoreProductCategoryRepository } from '../src/api/v1/store-product/repository/store-product-category.repository';
import { StoreEventRepository } from '../src/api/v1/store-product/repository/store-event.repository';

export function catalogArchives(source: DataSource): CatalogArchiveRepository {
  return new CatalogArchiveRepository(
    new StoreProductQueryRepository(
      source,
      new StoreProductCategoryRepository(),
      new CursorPagination('test-pagination-key-at-least-32-bytes'),
    ),
    new StoreEventRepository(new OutboxWriter(STORE_OUTBOX_OPTIONS)),
  );
}
