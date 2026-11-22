import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('product_snapshot')
@Index('product_snapshot_brand_idx', ['brandCode'])
export class ProductSnapshotModel {
  @PrimaryColumn('uuid', { name: 'product_uuid' })
  productUuid: string;

  @Column({ name: 'source_producer', type: 'varchar', length: 128, default: 'product_srv' })
  sourceProducer: string;

  @Column({ name: 'source_version', type: 'int' })
  sourceVersion: number;

  @Column({ name: 'name', type: 'varchar', length: 256 })
  name: string;

  @Column({ name: 'brand_code', type: 'varchar', length: 256, nullable: true })
  brandCode: string | null;

  @Column({ name: 'status', type: 'varchar', length: 64 })
  status: string;

  @Column({ name: 'synced_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  syncedAt: Date;
}
