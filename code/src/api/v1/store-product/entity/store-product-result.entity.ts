import { Expose, Type } from 'class-transformer';
import { IsDefined, ValidateNested, IsArray } from 'class-validator';

import { StoreProductEntity } from './store-product.entity';
import { MetaEntity } from './meta.entity';

export class StoreProductResultEntity {
  @Expose()
  @IsArray()
  @ValidateNested()
  @Type(() => StoreProductEntity)
  items: StoreProductEntity[];

  @Expose()
  @IsDefined()
  @ValidateNested()
  @Type(() => MetaEntity)
  meta: MetaEntity;
}
