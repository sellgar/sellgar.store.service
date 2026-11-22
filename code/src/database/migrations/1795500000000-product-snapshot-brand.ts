import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductSnapshotBrand1795500000000 implements MigrationInterface {
  name = 'ProductSnapshotBrand1795500000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE product_snapshot ADD COLUMN brand_code varchar(256)');
    await runner.query('CREATE INDEX product_snapshot_brand_idx ON product_snapshot (brand_code)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX product_snapshot_brand_idx');
    await runner.query('ALTER TABLE product_snapshot DROP COLUMN brand_code');
  }
}
