import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { StoreProductService } from '../service/store-product.service';
import { CreateStoreProductDto } from './dto/create-store-product.dto';
import { UpdateStoreProductDto } from './dto/update-store-product.dto';
import { ArchiveStoreProductDto } from './dto/archive-store-product.dto';
import { RecordInventoryDto } from './dto/record-inventory.dto';
import { AdjustRecordInventoryDto } from './dto/adjust-record-inventory.dto';
import { GetAllStoreProductsDto } from './dto/get-all-store-products.dto';
import { GetProductByRecordDto } from './dto/get-product-by-record.dto';
import { CatalogArchiveImpactDto } from './dto/catalog-archive-impact.dto';
import { StoreProductQueryRepository } from '../repository/store-product-query.repository';
import { SnapshotEventService } from '../service/snapshot-event.service';
import { CatalogSnapshotDto } from './dto/catalog-snapshot.dto';

@Controller()
export class StoreProductController {
  constructor(
    private readonly service: StoreProductService,
    private readonly queries: StoreProductQueryRepository,
    private readonly snapshots: SnapshotEventService,
  ) {}

  @MessagePattern({ cmd: 'store.catalog.archiveImpact' })
  archiveImpact(@Payload() dto: CatalogArchiveImpactDto) {
    return this.queries.archiveImpact(dto.productUuid, dto.variantUuid);
  }

  @MessagePattern({ cmd: 'store.catalog.synchronizeSnapshot' })
  async synchronizeSnapshot(@Payload() dto: CatalogSnapshotDto) {
    await this.snapshots.synchronizeProduct(dto);
    return { productUuid: dto.uuid, version: dto.version };
  }

  @MessagePattern({ cmd: 'store.product.getAll' }) getAll(
    @Payload('query')
    query: GetAllStoreProductsDto,
  ) {
    return this.service.getAll(query);
  }
  @MessagePattern({ cmd: 'store.product.getByUuid' }) getByUuid(
    @Payload('uuid')
    uuid: string,
    @Payload('query') query: GetAllStoreProductsDto,
  ) {
    return this.service.getByUuid(uuid, query);
  }
  @MessagePattern({ cmd: 'store.product.getByRecordUuid' })
  getByRecordUuid(@Payload() dto: GetProductByRecordDto) {
    return this.service.getByRecordUuid(dto.recordUuid);
  }

  @MessagePattern({ cmd: 'store.product.getSnapshot' })
  getSnapshot(@Payload('uuid') uuid: string) {
    return this.service.getSnapshot(uuid);
  }

  @MessagePattern({ cmd: 'store.product.getSnapshots' })
  getSnapshots(@Payload('query') query: GetAllStoreProductsDto) {
    return this.service.getSnapshots(query);
  }

  @MessagePattern({ cmd: 'store.offer.getAll' }) getOffers(@Payload('query') query: GetAllStoreProductsDto) {
    return this.service.getOffers(query);
  }
  @MessagePattern({ cmd: 'store.offer.getByUuid' }) getOffer(
    @Payload('uuid')
    uuid: string,
    @Payload('query') query: GetAllStoreProductsDto,
  ) {
    return this.service.getOffer(uuid, query);
  }
  @MessagePattern({ cmd: 'store.product.create' }) create(
    @Payload()
    dto: CreateStoreProductDto,
  ) {
    return this.service.create(dto);
  }
  @MessagePattern({ cmd: 'store.product.update' }) update(
    @Payload()
    dto: UpdateStoreProductDto,
  ) {
    return this.service.update(dto);
  }
  @MessagePattern({ cmd: 'store.product.archive' }) archive(
    @Payload()
    dto: ArchiveStoreProductDto,
  ) {
    return this.service.archive(dto);
  }
  @MessagePattern({ cmd: 'store.inventory.receipt' }) receipt(
    @Payload()
    dto: RecordInventoryDto,
  ) {
    return this.service.receiptInventory(dto);
  }
  @MessagePattern({ cmd: 'store.inventory.writeOff' }) writeOff(
    @Payload()
    dto: RecordInventoryDto,
  ) {
    return this.service.writeOffInventory(dto);
  }
  @MessagePattern({ cmd: 'store.inventory.adjust' }) adjust(
    @Payload()
    dto: AdjustRecordInventoryDto,
  ) {
    return this.service.adjustInventory(dto);
  }
}
