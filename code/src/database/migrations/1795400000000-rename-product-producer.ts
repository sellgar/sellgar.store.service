import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameProductProducer1795400000000 implements MigrationInterface {
  name = 'RenameProductProducer1795400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE product_snapshot ALTER COLUMN source_producer SET DEFAULT 'product_srv'");
    await queryRunner.query("UPDATE product_snapshot SET source_producer = 'product_srv' WHERE source_producer = 'product_srv_v2'");
    await queryRunner.query("UPDATE inbox_event SET producer = 'product_srv' WHERE producer = 'product_srv_v2'");
    await queryRunner.query("UPDATE sync_issue SET producer = 'product_srv' WHERE producer = 'product_srv_v2'");
  }

  async down(): Promise<void> {
    throw new Error('Product producer rename requires a coordinated deployment and cannot be reverted separately');
  }
}
