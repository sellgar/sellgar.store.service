import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCursorIndexes1795503600000 implements MigrationInterface {
  name = 'AddCursorIndexes1795503600000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE INDEX store_product_cursor_idx ON store_product (created_at DESC, uuid ASC)');
    await runner.query(
      'CREATE INDEX store_product_shop_cursor_idx ON store_product (shop_uuid, created_at DESC, uuid ASC)',
    );
    await runner.query('CREATE INDEX store_offer_cursor_idx ON store_offer (created_at DESC, uuid ASC)');
  }

  async down(): Promise<void> {
    throw new Error('Cursor index rollback is not supported');
  }
}
